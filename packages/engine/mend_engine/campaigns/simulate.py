"""The simulate button: a sandbox return purchase by one member of a sent campaign (C20, C21).

It buys from this shop only, with PayPal's public sandbox test card, for one fixed
amount, at most 10 times per campaign. The order is created with intent CAPTURE
and a card source, so PayPal captures it at once with no buyer login (the M0
probe's path). The row in simulated_orders is written before PayPal is called and
its order id is stored from PayPal's answer; only that stored id ever marks a
purchase as simulated (C8). Nothing is attributed here: the purchase counts only
when PayPal's verified capture webhook arrives and a re-read says COMPLETED.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import NoReturn

import psycopg
from psycopg.types.json import Jsonb

from mend_engine.money import to_decimal_string
from mend_engine.paypal.http import PayPalError, PayPalHttp

ORDERS_PATH = "/v2/checkout/orders"
AMOUNT_MINOR = 1250
CURRENCY = "USD"
MAX_PER_CAMPAIGN = 10
SIMULATABLE_STATUSES = ("submitted", "completed")
ACTOR = "simulate"
# PayPal's published sandbox test card. It can only ever pay in the sandbox and is not a secret.
TEST_CARD = {
    "number": "4111111111111111",
    "expiry": "2030-12",
    "security_code": "123",
    "name": "Test Buyer",
    "billing_address": {
        "address_line_1": "1 Main St",
        "admin_area_2": "San Jose",
        "admin_area_1": "CA",
        "postal_code": "95131",
        "country_code": "US",
    },
}

_REF = re.compile(r"R[1-9][0-9]{0,3}", re.ASCII)
_ORDER_ID = re.compile(r"[A-Z0-9]{1,36}", re.ASCII)
_STATUS = re.compile(r"[A-Z][A-Z_]{0,35}", re.ASCII)
_INSERT_AUDIT = "insert into audit_log (actor, action, detail) values (%s, %s, %s)"


@dataclass(frozen=True)
class SimulatedOrder:
    """The order as PayPal created it. paypal_status is PayPal's answer at creation (COMPLETED when captured)."""

    simulated_order_id: uuid.UUID
    paypal_order_id: str
    campaign_id: uuid.UUID
    ref: str
    paypal_status: str


class SimulateRefused(ValueError):
    """Nothing was bought. reason is a short fixed code; the message never names a member."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


class SimulateFailed(Exception):
    """PayPal did not give a usable answer. The attempt still uses one of the campaign's 10."""

    def __init__(self, simulated_order_id: uuid.UUID, status: int | None, name: str | None, debug_id: str | None) -> None:
        self.simulated_order_id = simulated_order_id
        self.status = status
        self.name = name
        self.debug_id = debug_id
        super().__init__(f"PayPal did not create the order (status={status} name={name} debug_id={debug_id})")


class OrderIdRefused(ValueError):
    """An order id that does not look like one PayPal issues. Nothing was sent."""


def simulate_return(conn: psycopg.Connection, http: PayPalHttp, campaign_id: uuid.UUID, ref: str) -> SimulatedOrder:
    """Buy once from this shop as the campaign member ref, with the sandbox test card, for 12.50 USD.

    In one transaction with the campaign row locked: the campaign must be submitted
    or completed, ref must be one of its rewarded or held-back members who has not
    left, and the campaign must have fewer than 10 simulated orders; then a
    simulated_orders row and an audit row are written. Only then is PayPal asked
    for the order (intent CAPTURE, custom_id our simulated order id, a unique
    invoice_id, PayPal-Request-Id our simulated order id), and PayPal's order id is
    stored on the row before returning.

    Raises SimulateRefused, with nothing bought and one audit row naming the reason,
    for: a campaign_id that is not a UUID or a ref of the wrong shape
    ("invalid_input"), no such campaign ("not_found"), a campaign not sent yet
    ("not_sent"), a ref not in it ("unknown_ref"), a member who left ("member_left"),
    and a campaign with 10 already ("limit_reached"). Raises SimulateFailed when
    PayPal errs, cannot be reached or answers without an order id; the row stays,
    without an order id, and still counts towards the 10.
    """
    if not isinstance(campaign_id, uuid.UUID) or type(ref) is not str or not _REF.fullmatch(ref):
        raise SimulateRefused("invalid_input", "the campaign must be a UUID and the ref like R1")
    simulated_order_id = uuid.uuid4()
    try:
        with conn.transaction():
            role = _reserve(conn, campaign_id, ref, simulated_order_id)
    except SimulateRefused as refused:
        with conn.transaction():
            conn.execute(
                _INSERT_AUDIT,
                (ACTOR, "simulate_refused", Jsonb({"campaign_id": str(campaign_id), "ref": ref, "reason": refused.reason})),
            )
        raise
    ids = {"campaign_id": str(campaign_id), "ref": ref, "role": role, "simulated_order_id": str(simulated_order_id)}

    try:
        response = http.request(
            "POST",
            ORDERS_PATH,
            json_body=_order_body(simulated_order_id),
            headers={"PayPal-Request-Id": str(simulated_order_id), "Prefer": "return=representation"},
        )
    except PayPalError as exc:
        _fail(conn, ids, exc.status, exc.name, exc.debug_id)
    order_id = response.body.get("id")
    if response.status not in (200, 201) or not isinstance(order_id, str) or not _ORDER_ID.fullmatch(order_id):
        name = response.body.get("name")
        _fail(conn, ids, response.status, name if isinstance(name, str) else None, response.debug_id)
    raw_status = response.body.get("status")
    status = raw_status if isinstance(raw_status, str) and _STATUS.fullmatch(raw_status) else "UNKNOWN"
    with conn.transaction():
        conn.execute(
            "update simulated_orders set paypal_order_id = %s where simulated_order_id = %s and paypal_order_id is null",
            (order_id, simulated_order_id),
        )
        conn.execute(
            _INSERT_AUDIT,
            (ACTOR, "simulate_created", Jsonb({**ids, "paypal_order_id": order_id, "paypal_status": status})),
        )
    return SimulatedOrder(simulated_order_id, order_id, campaign_id, ref, status)


def read_order(http: PayPalHttp, paypal_order_id: str) -> dict:
    """PayPal's current view of one order. Raises OrderIdRefused before sending, or PayPalError."""
    if type(paypal_order_id) is not str or not _ORDER_ID.fullmatch(paypal_order_id):
        raise OrderIdRefused("paypal_order_id is malformed")
    response = http.request("GET", f"{ORDERS_PATH}/{paypal_order_id}")
    if response.status != 200:
        name = response.body.get("name")
        raise PayPalError(response.status, name if isinstance(name, str) else None, response.debug_id)
    return response.body


def _reserve(conn: psycopg.Connection, campaign_id: uuid.UUID, ref: str, simulated_order_id: uuid.UUID) -> str:
    # The campaign row lock makes simulates for one campaign take turns, so the count below is exact.
    campaign = conn.execute("select status from campaigns where campaign_id = %s for update", (campaign_id,)).fetchone()
    if campaign is None:
        raise SimulateRefused("not_found", "no such campaign")
    if campaign[0] not in SIMULATABLE_STATUSES:
        raise SimulateRefused("not_sent", f"the campaign is {campaign[0]}; only a sent campaign can see a return purchase")
    member = conn.execute(
        "select role, member_id from campaign_members where campaign_id = %s and ref = %s", (campaign_id, ref)
    ).fetchone()
    if member is None:
        raise SimulateRefused("unknown_ref", "no such ref in this campaign")
    if member[1] is None:
        raise SimulateRefused("member_left", "this member left the thank-you list")
    used = conn.execute("select count(*) from simulated_orders where campaign_id = %s", (campaign_id,)).fetchone()[0]
    if used >= MAX_PER_CAMPAIGN:
        raise SimulateRefused("limit_reached", f"a campaign may have at most {MAX_PER_CAMPAIGN} simulated purchases")
    conn.execute(
        "insert into simulated_orders (simulated_order_id, campaign_id, ref) values (%s, %s, %s)",
        (simulated_order_id, campaign_id, ref),
    )
    conn.execute(
        _INSERT_AUDIT,
        (ACTOR, "simulate_requested", Jsonb({"campaign_id": str(campaign_id), "ref": ref, "role": member[0],
                                             "simulated_order_id": str(simulated_order_id)})),
    )
    return member[0]


def _order_body(simulated_order_id: uuid.UUID) -> dict:
    return {
        "intent": "CAPTURE",
        "purchase_units": [
            {
                "reference_id": "mend-simulated-return",
                "amount": {"currency_code": CURRENCY, "value": to_decimal_string(AMOUNT_MINOR)},
                "description": "Mend simulated return purchase",
                "custom_id": str(simulated_order_id),
                "invoice_id": f"mend-sim-{simulated_order_id}",
            }
        ],
        "payment_source": {"card": TEST_CARD},
    }


def _fail(conn: psycopg.Connection, ids: dict, status: int | None, name: str | None, debug_id: str | None) -> NoReturn:
    with conn.transaction():
        conn.execute(
            _INSERT_AUDIT,
            (ACTOR, "simulate_failed", Jsonb({**ids, "status": status, "name": name, "debug_id": debug_id})),
        )
    raise SimulateFailed(uuid.UUID(ids["simulated_order_id"]), status, name, debug_id)
