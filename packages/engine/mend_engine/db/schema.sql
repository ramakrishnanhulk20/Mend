-- First statement, so two connections applying this file take turns before either
-- touches a table. connect() and the test fixtures send the whole file as one
-- statement batch, which runs as one transaction, so the lock holds to the end.
select pg_advisory_xact_lock(7731300001);

create table if not exists payout_batches (
    sender_batch_id text primary key,
    campaign_id text not null,
    snapshot_hash text not null,
    payout_batch_id text unique,
    status text not null,
    created_at timestamptz not null default now()
);

create table if not exists payout_items (
    payout_item_id text primary key,
    sender_batch_id text not null references payout_batches,
    sender_item_id text not null,
    status text not null,
    fee_minor integer,
    updated_at timestamptz not null default now()
);

create table if not exists audit_log (
    id bigserial primary key,
    at timestamptz not null default now(),
    actor text not null,
    action text not null,
    detail jsonb not null
);

-- Reconcile looks its earlier audit rows up by action.
create index if not exists audit_log_action_at on audit_log (action, at);

-- The demo shop's own order records, imported from UCI Online Retail II (M2).
-- Identities are synthetic (C25); descriptions are source text kept as data (C11).
create table if not exists shop_customers (
    customer_ref text primary key,
    display_name text not null,
    email text not null unique,
    country text not null
);

create table if not exists shop_orders (
    order_ref text primary key,
    customer_ref text not null references shop_customers,
    ordered_at timestamptz not null,
    total_minor integer not null check (total_minor > 0),
    currency text not null check (currency = 'USD')
);

create index if not exists shop_orders_customer_ordered_at on shop_orders (customer_ref, ordered_at);

create table if not exists shop_order_lines (
    order_ref text not null references shop_orders,
    line_no integer not null,
    stock_code text not null,
    description text not null,
    quantity integer not null check (quantity > 0),
    unit_price_minor integer not null check (unit_price_minor > 0),
    primary key (order_ref, line_no)
);

create table if not exists import_runs (
    id bigserial primary key,
    source text not null,
    source_bytes bigint not null,
    lines_read integer not null,
    lines_kept integer not null,
    week_shift integer not null,
    finished_at timestamptz not null default now()
);

-- Verified PayPal webhook deliveries, written only by the web app's receiver after
-- PayPal's verify call says SUCCESS. raw is the body exactly as received. Rows are
-- PayPal transaction data, so they are purged 48 hours after receipt (C27).
create table if not exists paypal_events (
    transmission_id text primary key,
    event_id text not null unique,
    event_type text not null,
    resource_id text,
    received_at timestamptz not null default now(),
    purge_after timestamptz not null,
    raw text not null
);

-- Customers who joined the shop's thank-you list with Log in with PayPal (C28).
-- Only what PayPal returned and what they agreed to. paypal_email is stored after
-- the one email normaliser, so the unique constraint compares normalised values.
-- Leaving deletes the row; nothing here is kept after a member leaves.
create table if not exists members (
    member_id uuid primary key default gen_random_uuid(),
    paypal_email text not null unique,
    paypal_payer_id text unique,
    email_verified boolean not null,
    consent_version text not null,
    consent_text_sha256 text not null,
    client_id text not null,
    joined_at timestamptz not null default now()
);

create table if not exists campaigns (
    campaign_id uuid primary key default gen_random_uuid(),
    shop_name text not null,
    goal_text text not null,
    as_of date not null,
    budget_minor integer not null check (budget_minor > 0),
    per_recipient_minor integer not null check (per_recipient_minor > 0),
    holdout_share numeric(3,2) not null check (holdout_share between 0.20 and 0.50),
    status text not null check (status in ('draft','awaiting_approval','approved','submitting','submitted','submission_unknown','exists_unresolved','completed','voided')),
    void_reason text,
    created_at timestamptz not null default now()
);

-- One row per candidate in a campaign, holdout included. ref ("R1", "R2", ...) is the
-- only identifier a language model will ever see. member_id goes null when a member
-- leaves after the campaign was submitted, so the record of what was sent survives.
create table if not exists campaign_members (
    campaign_id uuid not null references campaigns on delete cascade,
    ref text not null,
    member_id uuid references members on delete set null,
    role text not null check (role in ('reward','holdout')),
    rank integer not null,
    score double precision not null,
    amount_minor integer check (amount_minor is null or amount_minor > 0),
    note text,
    primary key (campaign_id, ref),
    unique (campaign_id, member_id)
);

create index if not exists campaign_members_member_id on campaign_members (member_id);

-- The demo shop's cancellation invoices from the same UCI file, one row per invoice,
-- in USD cents with the same week shift and identities as shop_orders (C4: what a
-- customer paid is counted net of these).
create table if not exists shop_refunds (
    refund_ref text primary key,
    customer_ref text not null references shop_customers,
    refunded_at timestamptz not null,
    amount_minor integer not null check (amount_minor > 0)
);

create index if not exists shop_refunds_customer_refunded_at on shop_refunds (customer_ref, refunded_at);

-- The exact snapshot a person approved, frozen at approval (C2): the hash they were
-- shown, the canonical text it is the hash of, and who approved when. Submission
-- builds the batch from canonical_json alone, never from live member or campaign rows.
create table if not exists approved_snapshots (
    campaign_id uuid primary key references campaigns,
    snapshot_hash text not null,
    canonical_json text not null,
    approved_at timestamptz not null,
    approved_by text not null
);

-- The 48-hour purge (C27) deletes by purge_after.
create index if not exists paypal_events_purge_after on paypal_events (purge_after);

-- Guards in the database itself (C2, C23). Triggers fire for every role, the table
-- owner included, so no code path that reaches the database can step around them.
-- One block, so running it again replaces the functions and recreates the triggers.
do $mend_guards$
begin
    -- Two connections running this block at once would both rewrite the same
    -- function rows and one would fail; the lock makes them take turns.
    perform pg_advisory_xact_lock(7731300001);

    create or replace function mend_refuse_change() returns trigger
    language plpgsql as $fn$
    begin
        raise exception '%: % refused, rows in this table are permanent', tg_table_name, lower(tg_op);
    end
    $fn$;

    -- A campaign's rows may change while it is a draft, awaiting approval or voided.
    -- From approval on they are frozen. The one change allowed after a batch was
    -- sent is the foreign key emptying member_id when a member leaves, so the record
    -- of what was sent survives (C28). Before that, leaving voids the campaign first.
    create or replace function mend_campaign_rows_frozen() returns trigger
    language plpgsql as $fn$
    declare
        involved uuid[];
        states text[];
    begin
        if tg_op = 'TRUNCATE' then
            raise exception 'campaign_members: truncate refused, it would erase approved and sent campaigns';
        elsif tg_op = 'INSERT' then
            involved := array[new.campaign_id];
        elsif tg_op = 'DELETE' then
            involved := array[old.campaign_id];
        else
            involved := array[old.campaign_id, new.campaign_id];
        end if;
        -- The schema of the table that fired, so each schema guards its own rows.
        execute format(
            'select coalesce(array_agg(status), ''{}'') from %I.campaigns where campaign_id = any($1)',
            tg_table_schema
        ) into states using involved;
        if 'approved' = any(states) then
            raise exception 'campaign_members: % refused, the campaign is approved and its rows are frozen', lower(tg_op);
        end if;
        if states && array['submitting', 'submitted', 'submission_unknown', 'exists_unresolved', 'completed'] then
            if tg_op = 'UPDATE' and old.member_id is not null and new.member_id is null
               and (new.campaign_id, new.ref, new.role, new.rank, new.score, new.amount_minor, new.note)
                   is not distinct from
                   (old.campaign_id, old.ref, old.role, old.rank, old.score, old.amount_minor, old.note) then
                return new;
            end if;
            raise exception 'campaign_members: % refused, the campaign has been sent and its rows are frozen', lower(tg_op);
        end if;
        if tg_op = 'DELETE' then
            return old;
        end if;
        return new;
    end
    $fn$;

    drop trigger if exists audit_log_append_only on audit_log;
    create trigger audit_log_append_only before update or delete on audit_log
        for each row execute function mend_refuse_change();
    drop trigger if exists audit_log_no_truncate on audit_log;
    create trigger audit_log_no_truncate before truncate on audit_log
        for each statement execute function mend_refuse_change();

    -- A snapshot row exists only from approval on, so it is refused always.
    drop trigger if exists approved_snapshots_append_only on approved_snapshots;
    create trigger approved_snapshots_append_only before update or delete on approved_snapshots
        for each row execute function mend_refuse_change();
    drop trigger if exists approved_snapshots_no_truncate on approved_snapshots;
    create trigger approved_snapshots_no_truncate before truncate on approved_snapshots
        for each statement execute function mend_refuse_change();

    drop trigger if exists campaign_members_frozen on campaign_members;
    create trigger campaign_members_frozen before insert or update or delete on campaign_members
        for each row execute function mend_campaign_rows_frozen();
    drop trigger if exists campaign_members_no_truncate on campaign_members;
    create trigger campaign_members_no_truncate before truncate on campaign_members
        for each statement execute function mend_campaign_rows_frozen();
end
$mend_guards$;

-- What the engine decided for each verified webhook delivery, one row per
-- transmission id (C10, C23). No foreign key to paypal_events: those rows are
-- purged at 48 hours and these stay (C27), so detail holds ids and statuses only,
-- never a raw payload, an email or a name.
create table if not exists event_outcomes (
    transmission_id text primary key,
    processed_at timestamptz not null default now(),
    outcome text not null,
    detail jsonb not null
);

-- Return purchases the simulate button created (C21). The row is written before
-- PayPal is called, so the per-campaign limit counts orders whose answer was lost,
-- and paypal_order_id is filled in from PayPal's answer. A purchase is labelled
-- simulated only through this table, never through a field a buyer can set (C8).
create table if not exists simulated_orders (
    simulated_order_id uuid primary key,
    paypal_order_id text unique,
    campaign_id uuid not null,
    ref text not null,
    created_at timestamptz not null default now()
);

create index if not exists simulated_orders_campaign_id on simulated_orders (campaign_id);

-- A purchase linked to the campaign that rewarded or held back its buyer (C8).
-- source_order is unique, so the same purchase seen twice is attributed once.
create table if not exists attributions (
    attribution_id bigserial primary key,
    campaign_id uuid not null,
    ref text not null,
    role text not null,
    purchased_at timestamptz not null,
    amount_minor integer not null check (amount_minor > 0),
    simulated boolean not null,
    source_order text not null unique
);

create index if not exists attributions_campaign_id on attributions (campaign_id);

-- Every campaign status change, written by the status guard below, so the time a
-- campaign reached each status is on record whichever code path moved it. A row
-- inserted straight into a status has from_status null.
create table if not exists campaign_status_moves (
    campaign_id uuid not null,
    from_status text,
    to_status text not null,
    moved_at timestamptz not null default now()
);

create index if not exists campaign_status_moves_campaign_id on campaign_status_moves (campaign_id, to_status, moved_at);

-- The status guard: a campaign moves only along the arrows below, and each move is
-- recorded. Updates only; inserts may start in any status (tests build campaigns
-- that way) and are recorded with from_status null. Same lock and re-run rules as
-- the block above.
do $mend_status_guard$
begin
    perform pg_advisory_xact_lock(7731300001);

    create or replace function mend_campaign_status_guard() returns trigger
    language plpgsql as $fn$
    begin
        if new.status is not distinct from old.status then
            return new;
        end if;
        -- Deny by default: a move is allowed only if it is one of these pairs.
        if (old.status, new.status) in (
            ('draft', 'awaiting_approval'), ('draft', 'approved'), ('draft', 'voided'),
            ('awaiting_approval', 'approved'), ('awaiting_approval', 'voided'),
            ('approved', 'submitting'), ('approved', 'voided'),
            ('submitting', 'submitted'), ('submitting', 'submission_unknown'),
            ('submitting', 'exists_unresolved'), ('submitting', 'voided'),
            ('submission_unknown', 'submitting'), ('submission_unknown', 'submitted'),
            ('submission_unknown', 'exists_unresolved'),
            ('exists_unresolved', 'submitted'),
            ('submitted', 'completed')
        ) then
            return new;
        end if;
        raise exception 'campaigns: status % to % refused', old.status, new.status;
    end
    $fn$;

    create or replace function mend_campaign_status_record() returns trigger
    language plpgsql as $fn$
    begin
        -- The schema of the table that fired, as in mend_campaign_rows_frozen.
        if tg_op = 'INSERT' then
            execute format(
                'insert into %I.campaign_status_moves (campaign_id, from_status, to_status) values ($1, null, $2)',
                tg_table_schema
            ) using new.campaign_id, new.status;
        else
            execute format(
                'insert into %I.campaign_status_moves (campaign_id, from_status, to_status) values ($1, $2, $3)',
                tg_table_schema
            ) using new.campaign_id, old.status, new.status;
        end if;
        return null;
    end
    $fn$;

    drop trigger if exists campaigns_status_guard on campaigns;
    create trigger campaigns_status_guard before update of status on campaigns
        for each row execute function mend_campaign_status_guard();
    drop trigger if exists campaigns_status_inserted on campaigns;
    create trigger campaigns_status_inserted after insert on campaigns
        for each row execute function mend_campaign_status_record();
    drop trigger if exists campaigns_status_moved on campaigns;
    create trigger campaigns_status_moved after update of status on campaigns
        for each row when (old.status is distinct from new.status)
        execute function mend_campaign_status_record();

    drop trigger if exists campaign_status_moves_append_only on campaign_status_moves;
    create trigger campaign_status_moves_append_only before update or delete on campaign_status_moves
        for each row execute function mend_refuse_change();
    drop trigger if exists campaign_status_moves_no_truncate on campaign_status_moves;
    create trigger campaign_status_moves_no_truncate before truncate on campaign_status_moves
        for each statement execute function mend_refuse_change();
end
$mend_status_guard$;

-- Console sign-in sessions (C18). session_id is the SHA-256 of the cookie value, so
-- the token a browser holds is never stored and never equals any record id. A
-- session ends 2 hours after last_seen_at or at expires_at, whichever comes first.
create table if not exists sessions (
    session_id text primary key check (session_id ~ '^[0-9a-f]{64}$'),
    role text not null check (role in ('owner', 'demo')),
    created_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    expires_at timestamptz not null
);

create index if not exists sessions_expires_at on sessions (expires_at);

-- Which session created each campaign (C19). A demo session may act only on the
-- campaigns recorded against it here; the owner may act on any.
create table if not exists campaign_owners (
    campaign_id uuid primary key references campaigns,
    role text not null check (role in ('owner', 'demo')),
    session_id text not null check (session_id ~ '^[0-9a-f]{64}$')
);

create index if not exists campaign_owners_session_id on campaign_owners (session_id);

-- One row per request a rate limit let through (C20), keyed on something the caller
-- cannot choose: a client address or a session id. Rows older than the longest
-- window are deleted as new ones arrive.
create table if not exists rate_limit_hits (
    bucket text not null,
    subject text not null,
    at timestamptz not null default now()
);

create index if not exists rate_limit_hits_lookup on rate_limit_hits (bucket, subject, at);
create index if not exists rate_limit_hits_at on rate_limit_hits (at);

-- A campaign's owner never changes and is never removed, so a demo session cannot be
-- handed another visitor's campaign, nor a campaign's creator erased (C19). Same lock
-- and re-run rules as the guard blocks above.
do $mend_owner_guard$
begin
    perform pg_advisory_xact_lock(7731300001);

    drop trigger if exists campaign_owners_append_only on campaign_owners;
    create trigger campaign_owners_append_only before update or delete on campaign_owners
        for each row execute function mend_refuse_change();
end
$mend_owner_guard$;

-- The model's headline proof numbers (the published CDNOW benchmark and the UCI
-- backtest), written only by the operator command python -m mend_engine.store_facts
-- and read by the landing page summary. A missing row means the numbers are not shown.
create table if not exists model_facts (
    key text primary key,
    value jsonb not null,
    computed_at timestamptz not null default now()
);

-- Which session started each engine run a route answered 202 for, so only that
-- session may poll it at GET /api/runs/[runId] (C19). session_id_hash is the sessions
-- table's session_id, the SHA-256 of the cookie, never the cookie itself.
create table if not exists run_owners (
    run_id text primary key,
    session_id_hash text not null,
    task text not null,
    created_at timestamptz not null default now()
);

-- PayPal webhook certificate addresses that have verified a genuine delivery, written
-- only by the web app after a signature checks out (C9, C20). A restarted app reads the
-- ones verified in the last 400 days, so PayPal's certificate never waits behind the
-- download budget that unauthenticated traffic shares.
create table if not exists paypal_certs (url text primary key, last_verified_at timestamptz not null default now());

-- Where a member row came from (C23, C28): 'paypal_login' for a person who clicked Join
-- with PayPal, 'seed' for the demo shop's stand-in members, which no person consented to.
-- Rows from before this column default to paypal_login; seed_demo marks its own rows.
alter table members add column if not exists source text not null default 'paypal_login';
do $$ begin
    alter table members add constraint members_source_known check (source in ('paypal_login', 'seed'));
exception when duplicate_object then null; end $$;

-- Claude tokens spent per day and per subject (a session tag, an address tag, 'demo_all'
-- or 'owner'), so C12 and C20 can cap tokens as well as calls. Written only by the web app.
create table if not exists claude_usage (
    day date not null,
    subject text not null,
    input_tokens bigint not null default 0,
    output_tokens bigint not null default 0,
    primary key (day, subject)
);
