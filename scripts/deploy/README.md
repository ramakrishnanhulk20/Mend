# Deploy: Mend on Render

`render.mjs` builds and checks Mend's live setup on Render from `.env`, with no dashboard clicks. Everything is in region virginia and deploys `main` on every push:

- `mend-web`, web service (Starter, about USD 7 a month): the site at https://mend-web.onrender.com and the PayPal webhook receiver. Node 26.7.0.
- `mend-engine`, private service (Starter, about USD 7 a month): the engine's task server, reachable only on Render's private network. Python 3.12.10, built with `pip install .` (no extras).
- `mend-jobs`, cron job (Starter, USD 1 a month minimum plus run minutes): `python -m mend_engine.jobs all` every 5 minutes.
- `mend-db`, Postgres (basic_256mb, 1 GB, about USD 6 a month), plus one free PayPal sandbox webhook for mend-web.

Run from the repo root:
- `node scripts/deploy/render.mjs status` reads only: each resource `render-state.json` records, found by its id, and the database role each service connects as.
- `node scripts/deploy/render.mjs up --migrate` runs the engine's migrate (as mend-db's owner) and seed (as `mend_engine`) commands against mend-db, sets every env var and redeploys only what changed, then drops the old shared role `mend_app` once no service uses it. Plain `up` does the same but never touches mend-db. A second run changes nothing.
- Every command finds each resource by the id `render-state.json` records. A recorded resource that is missing, renamed or on another plan stops the run before anything changes, and so does a service connected to another database. `up` creates a paid resource only with `--create`, only when no id is recorded for it, and never a new database under services that already run.
- `node scripts/deploy/render.mjs prove` runs the live proof and changes no resource or setting: Render and PayPal writes are refused in code, and `up` runs inside it in plan-only mode, which must find nothing to change. A demo visitor plans, notes, approves and submits a campaign (at most 10.00 USD of sandbox money); the webhook, mend-engine and the results are checked; the 4 unclaimed rewards are cancelled back to the shop and the campaign must then count only its 200 claimed cents toward the demo pool; `mend_engine` is refused a trigger change, an audit-log update and a new table, and `mend_web` an update of `payout_items`; plus a simulated return, the AI agent, the jobs and a secrets sweep. It ends `D2 RESULT: PASS` or `FAIL`.

`.env` keys it reads: `RENDER_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` (must be `sandbox`), the three `MEND_*_CAP_MINOR` caps, `MEND_OWNER_PASSWORD`, `ANTHROPIC_API_KEY` and `MEND_TEST_RECEIVER`. No service is given `RENDER_API_KEY`. `MEND_CSRF_SECRET`, `MEND_ENGINE_TOKEN`, `MEND_ENGINE_DB_PASSWORD` and `MEND_WEB_DB_PASSWORD` are generated once and live only in Render (the two passwords inside each service's `DATABASE_URL`).

Each service connects as its own login role, created by migrate: mend-engine and mend-jobs as `mend_engine`, which may read and write rows but only add to `audit_log`; mend-web as `mend_web`, which may read and write only `sessions`, `run_owners`, `rate_limit_hits`, `paypal_certs` and `claude_usage`, read and add to `paypal_events`, and add to `audit_log`. Neither can change the schema or a trigger, and mend-db's owner URL is never set on a service. Migrate, seed and the proof reach mend-db from this machine through the engine's virtual environment (`packages/engine/.venv`) over TLS, so `up` and `prove` allow this machine's public IPv4 address, and only that address, on the database for the length of the run, and remove it at the end however the run ends.

`render-state.json` holds ids and addresses, never secrets. Request bodies follow Render's OpenAPI file, https://api-docs.render.com/openapi/render-public-api-1.json, and https://render.com/docs/private-network.
