# Deploy: Mend on Render

`render.mjs` builds and checks Mend's live setup on Render from `.env`, with no dashboard clicks. Everything is in region virginia and deploys `main` on every push:

- `mend-web`, web service (Starter, about USD 7 a month): the site at https://mend-web.onrender.com and the PayPal webhook receiver. Node 26.7.0.
- `mend-engine`, private service (Starter, about USD 7 a month): the engine's task server, reachable only on Render's private network. Python 3.12.10, built with `pip install .` (no extras).
- `mend-jobs`, cron job (Starter, USD 1 a month minimum plus run minutes): `python -m mend_engine.jobs all` every 5 minutes.
- `mend-db`, Postgres (basic_256mb, 1 GB, about USD 6 a month), plus one free PayPal sandbox webhook for mend-web.

Run from the repo root:
- `node scripts/deploy/render.mjs status` reads only and prints what exists.
- `node scripts/deploy/render.mjs up --migrate` finds or creates everything, runs the engine's migrate and seed commands against mend-db, sets every env var and redeploys only what changed. Plain `up` does the same but never touches mend-db. A second run changes nothing.
- `node scripts/deploy/render.mjs prove` runs the live proof: a demo visitor plans, notes, approves and submits a campaign (at most 1.00 USD of sandbox money); the webhook, mend-engine and the results are checked; plus a simulated return, the AI agent, the jobs and a secrets sweep. It ends `D2 RESULT: PASS` or `FAIL`.

`.env` keys it reads: `RENDER_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` (must be `sandbox`), the three `MEND_*_CAP_MINOR` caps, `MEND_OWNER_PASSWORD`, `ANTHROPIC_API_KEY` and `MEND_TEST_RECEIVER`. No service is given `RENDER_API_KEY`. `MEND_CSRF_SECRET` and `MEND_ENGINE_TOKEN` are generated once and live only in Render.

Migrate, seed and the proof reach mend-db from this machine through the engine's virtual environment (`packages/engine/.venv`) over TLS, so `up` allows this machine's public IPv4 address, and only that address, on the database.

`render-state.json` holds ids and addresses, never secrets. Request bodies follow Render's OpenAPI file, https://api-docs.render.com/openapi/render-public-api-1.json, and https://render.com/docs/private-network.
