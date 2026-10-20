# Mend engine

Reads a shop's PayPal history and sends guarded cashback payouts. It talks to the PayPal sandbox only.

Setup (Windows, Python 3.12, run from `packages/engine`):
`python -m venv .venv`, then `.venv\Scripts\activate`, then `pip install -e ".[test]"`

Tests: `python -m pytest -q` (no network).

Live proof: `python -m mend_engine.prove_m1`. Each line prints PASS or FAIL, and the run ends with `M1 RESULT`. It sends one 1.00 USD sandbox payout per UTC day. Later runs that day reuse the ledger row and send nothing.

It reads the `.env` file at the repo root, and the process environment wins over the file. Keys:
`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` (must be `sandbox`), `MEND_DEV`, `MEND_TEST_RECEIVER`,
`MEND_PAYOUT_ITEM_CAP_MINOR`, `MEND_CAMPAIGN_CAP_MINOR`, `MEND_DAILY_CAP_MINOR`, and optionally `DATABASE_URL`.
With no `DATABASE_URL` and `MEND_DEV=1`, it starts a local Postgres (pgserver) in `.pgdata`.

## M2: the demo shop's order records

`python -m mend_engine.prove_m2` loads the shop's order history from UCI Online Retail II, the real sales of a UK gift-ware wholesaler from Dec 2009 to Dec 2011, and prints PASS or FAIL per check, ending with `M2 RESULT`. It uses the same `.env` and database as M1 and calls no PayPal API. The 45.6 MB zip is downloaded into `.data/` on first use, and a file of any other size is refused.
Cleaning keeps 802,634 lines: no cancellations, quantity and price above 0, a customer number, no postage or fee codes. Both sheets carry 1 to 9 Dec 2010, so those invoices are stored once: 788,189 lines, 36,594 orders, 5,852 customers.
Money: GBP becomes USD at a fixed 1.60 per GBP, an approximate 2010 to 2011 average, with each unit price rounded half up to whole cents.
Dates: every order moves forward 775 whole weeks on the UK wall clock, so the last order day is 16 Oct 2026 and each order keeps its weekday and time of day. Seasons land about eight weeks earlier in the year.
People: the source holds only a customer number and a country. Names such as "Maya R." and emails such as `c13085@shop.example` (a domain that can never receive mail) are generated from the number.
Data: Chen, D. (2012). Online Retail II [Dataset]. UCI Machine Learning Repository. https://doi.org/10.24432/C5CG6D. Licence CC BY 4.0.
