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
