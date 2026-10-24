# Deploy: Mend on Render

`render.mjs` builds and checks Mend's live setup on Render from `.env`, with no dashboard clicks.

It creates, in region virginia: the web service `mend-web` (plan starter, about USD 7 a month, builds `packages/web` from `main` on every push, Node 26.7.0) and the Postgres database `mend-db` (plan basic_256mb, 1 GB, Postgres 18, about USD 6 a month). It also registers one PayPal sandbox webhook for `mend-web`'s `/api/webhooks/paypal`, which is free.

Run from the repo root:
- `node scripts/deploy/render.mjs status` reads only and prints what exists.
- `node scripts/deploy/render.mjs up [--schema <file>]` finds or creates everything, applies the schema (default `packages/engine/mend_engine/db/schema.sql`), sets the env vars and redeploys only if they changed. A second run changes nothing.
- `node scripts/deploy/render.mjs prove [--schema <file>]` runs the live proof and sends one 1.00 USD sandbox payout. It ends `D1 RESULT: PASS` or `FAIL`. Give it the same `--schema` as `up`, because it reruns `up`.

`.env` keys it reads: `RENDER_API_KEY`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and `PAYPAL_ENV` (must be `sandbox`); `prove` also reads `MEND_TEST_RECEIVER` and `MEND_PAYOUT_ITEM_CAP_MINOR`. `mend-web` gets only `PAYPAL_ENV`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `DATABASE_URL`, `PAYPAL_WEBHOOK_ID` and `NODE_VERSION`.

The schema apply and `prove` reach `mend-db` from this machine through the engine's virtual environment (`packages/engine/.venv`), so `up` allows this machine's public IPv4 address, and only that address, on the database.

`render-state.json` holds ids and URLs, never secrets. Request bodies follow Render's OpenAPI file, https://api-docs.render.com/openapi/render-public-api-1.json, and https://render.com/docs/postgresql-creating-connecting.
