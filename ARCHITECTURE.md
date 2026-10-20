# Mend architecture

Mend finds a small shop's regular customers who have gone quiet, using the shop's own order records, and sends each a thank-you cashback into their PayPal, after the owner approves. Only customers who joined the shop's thank-you list with Log in with PayPal can be paid. A random holdout group in every campaign gets nothing, so the lift is measured.

Everything runs against the PayPal sandbox. Security rules referenced as C1 to C26 are in `docs/security/threat-model.md`.

## Parts

| Part | Where it runs | Job |
|---|---|---|
| Web app (`packages/web`) | Next.js on a Render web service | Landing page, owner and demo console, join page, `/docs`; API routes for sign-in, campaigns and the agent; the PayPal webhook receiver; the Log in with PayPal callback. Talks to Claude. Never sends money itself. |
| Engine (`packages/engine`) | Python tasks on Render Workflows | Imports the shop's own order records; scores customers with BG/NBD; builds campaign drafts (eligible set, holdout, amounts, all in code); sends approved batches through Payouts; reconciles and refreshes payout status; records purchases and attribution. The only code that moves money (C1). |
| Database | Neon Postgres | Shop order records, members and consent, customer scores, campaigns and snapshots, payout items, attribution, sessions, append-only audit log (C23). |
| Scheduler | Render cron job | Starts the daily scoring run, the attribution-window close and the 48-hour PayPal-data purge (C27). |
| Operator scripts (`scripts/`) | A developer's machine | Import the real dataset as the demo shop's order records; reproduce the published benchmark; run the backtest; the prove-it command. |
| PayPal (sandbox) | PayPal | OAuth, Transaction Search, Orders, Payouts, webhooks, Log in with PayPal. |
| Claude Haiku 5.5 | Anthropic API | Reads the owner's goal into structured campaign settings; writes one note per customer; answers the owner's questions through read-only tools. Never chooses an amount or a recipient (C4, C5, C11). |

Where each PayPal call lives:

| PayPal call | Caller | How |
|---|---|---|
| `POST /v1/oauth2/token` | web, engine | REST, token cached until `expires_in` |
| Transaction Search `GET /v1/reporting/transactions` (reconciliation only, purged within 48 hours) | engine | Server SDK `TransactionSearchController` (Python) |
| Payouts create, show batch, show item, cancel unclaimed | engine | REST (no SDK covers Payouts) |
| Webhooks create, list, verify signature | web | REST |
| Orders create and capture (simulate purchase, seeding) | engine, scripts | Server SDK `OrdersController` |
| Log in with PayPal (`/connect`, `/v1/oauth2/token`, userinfo `schema=paypalv1.1`) | web | REST; scopes openid, email, paypalattributes |
| Agent Toolkit read-only tools (`list_transactions`, `get_order`, products) | web agent | `@paypal/agent-toolkit` with an explicit read-only `actions` map and `sandbox: true` |

## 1. System overview

```mermaid
flowchart LR
  subgraph People
    Owner["Shop owner"]
    Judge["Demo visitor"]
    Customer["Shop customer"]
  end

  subgraph Render
    Web["Web app<br/>Next.js<br/>console, API, webhook receiver"]
    Engine["Engine<br/>Python on Render Workflows<br/>score, draft, pay, attribute, purge"]
    Cron["Cron job<br/>daily sync"]
  end

  DB[("Neon Postgres<br/>shop orders, members and consent,<br/>scores, campaigns, payouts, audit log")]
  Claude["Claude Haiku 5.5<br/>goal reading, notes, Q&A"]

  subgraph PayPal["PayPal sandbox"]
    Login["Log in with PayPal"]
    TxSearch["Transaction Search"]
    Payouts["Payouts"]
    Orders["Orders"]
    Hooks["Webhooks"]
  end

  Owner --> Web
  Judge --> Web
  Customer -- "joins the thank-you list" --> Login
  Login --> Web
  Web --> DB
  Web --> Claude
  Web -- "start task run" --> Engine
  Cron --> Engine
  Engine --> DB
  Engine -- "reconcile only" --> TxSearch
  Engine --> Payouts
  Engine --> Orders
  Payouts -- "cashback and note" --> Customer
  Hooks -- "signed events" --> Web
```

## 2. Main sequence: one campaign, end to end

```mermaid
sequenceDiagram
  autonumber
  actor O as Owner
  participant W as Web app
  participant C as Claude Haiku
  participant E as Engine
  participant D as Postgres
  participant P as PayPal sandbox
  actor M as Member customer

  O->>W: Goal and budget ("bring back quiet regulars, 50 dollars")
  W->>C: Goal text only
  C-->>W: Structured settings (segment, budget), schema checked
  W->>E: build_draft(settings)
  E->>D: Members with scores (expected purchases, value)
  E->>E: Eligible set, random holdout (CSPRNG), amounts under caps
  E-->>W: Draft with opaque customer refs
  loop one call per customer
    W->>C: That customer's items and history only
    C-->>W: Note text
    W->>W: Note rules (C13), else template
  end
  W-->>O: Exact recipients, amounts, notes, holdout size
  O->>W: Approve (same origin, CSRF)
  W->>D: Snapshot hash recorded (C2)
  W->>E: submit_batch(campaign)
  E->>D: approved to submitting, atomic (C3)
  E->>P: POST /v1/payments/payouts (sender_batch_id from snapshot)
  P-->>E: batch PENDING
  P-->>M: Cashback and note in their PayPal
  P->>W: PAYMENT.PAYOUTS-ITEM.SUCCEEDED (signed)
  W->>W: Verify signature (C9)
  W->>E: refresh_item(id)
  E->>P: GET payout item (C10)
  E->>D: Status forward only
  M->>P: Buys again from the shop
  P->>W: PAYMENT.CAPTURE.COMPLETED (signed)
  W->>E: record_purchase(capture)
  E->>P: GET order for payer (C8, C10)
  E->>D: Purchase and attribution, rewarded or holdout
  O->>W: Results
  W-->>O: Spend, return rate rewarded vs holdout, PayPal ids
```

## 3. Module dependencies

```mermaid
flowchart TB
  subgraph web["packages/web (TypeScript)"]
    pages["pages: landing, console, join, docs"]
    api["api routes: auth, campaigns, agent, join callback"]
    hook["webhook receiver"]
    agent["agent: Claude client + read-only tools"]
    perms["permissions table (C18)"]
    notes["note rules (C13)"]
    ppweb["paypal client: token, webhooks verify, identity"]
    enginecall["engine client: start run, read result"]
  end

  subgraph engine["packages/engine (Python)"]
    tasks["workflow tasks"]
    sync["sync: Transaction Search"]
    classify["classifier: T-codes (C7)"]
    model["model: BG/NBD expected purchases"]
    draft["draft: eligibility, holdout, amounts (C4 to C6)"]
    money["money: decimal minor units"]
    payout["payouts: submit, reconcile, refresh (C3, C10)"]
    attrib["attribution (C8)"]
    ppeng["paypal client: sandbox host check (C16)"]
  end

  db[("Postgres schema + migrations")]

  pages --> api
  api --> perms
  api --> agent
  api --> notes
  api --> enginecall
  hook --> ppweb
  hook --> enginecall
  agent --> perms
  api --> db
  tasks --> sync
  tasks --> draft
  tasks --> payout
  tasks --> attrib
  sync --> classify
  sync --> ppeng
  draft --> model
  draft --> money
  payout --> money
  payout --> ppeng
  attrib --> ppeng
  sync --> db
  draft --> db
  payout --> db
  attrib --> db
```

## Interface the frontend will use

Filled in at the backend handoff (6l): every API route, its request and response shape, and the exact reads and writes each screen makes. Not written yet.

## Open items

- Web starts engine tasks with `render.workflows.startTask('<workflow>/<task>', [args], { idempotencyKey })` from `@renderinc/sdk` 1.3.0 and polls `getTaskRun(id)`; cron starts runs the same way. Auth is a Render API key.
- Log in with PayPal userinfo fields (`payer_id`) to be confirmed from one saved sandbox response before matching code is written.
- Transaction Search lag on this app (M0 rows not visible after 27 minutes on 20 Oct): recheck.
