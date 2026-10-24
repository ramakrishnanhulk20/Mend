# Not covered here: real PayPal answers (prove_m1 does that live), the daily cap,
# per-customer limits against purchase history, and ledger or approval races.
import json
from dataclasses import replace

import httpx
import pytest

from mend_engine.config import SANDBOX_API_HOST, Config
from mend_engine.paypal import payouts
from mend_engine.paypal.http import PayPalError, PayPalHttp
from mend_engine.paypal.payouts import (
    BatchExistsUnresolved,
    BatchSnapshot,
    PayoutItemSpec,
    SnapshotRefused,
    SubmissionUnknown,
    canonical_json,
    sender_batch_id_for,
    submit_batch,
    validate_snapshot,
)


def make_config(item_cap: int = 1000, campaign_cap: int = 10000) -> Config:
    return Config(
        paypal_client_id="cid",
        paypal_client_secret="csecret",
        paypal_api_host=SANDBOX_API_HOST,
        database_url=None,
        dev=True,
        test_receiver=None,
        item_cap_minor=item_cap,
        campaign_cap_minor=campaign_cap,
        daily_cap_minor=20000,
    )


def item(n: int = 1, **changes: object) -> PayoutItemSpec:
    base = PayoutItemSpec(
        receiver_email=f"buyer{n}@example.com",
        amount_minor=100,
        note="Thank you for being a regular.",
        sender_item_id=f"item-{n}",
    )
    return replace(base, **changes)


def snapshot(*items: PayoutItemSpec, **changes: object) -> BatchSnapshot:
    base = BatchSnapshot(
        campaign_id="camp-1",
        currency="USD",
        email_subject="A thank-you from the shop",
        items=items or (item(),),
    )
    return replace(base, **changes)


def test_same_snapshot_gives_the_same_id() -> None:
    assert sender_batch_id_for(snapshot()) == sender_batch_id_for(snapshot())
    assert sender_batch_id_for(snapshot()).startswith("mend-")
    assert len(sender_batch_id_for(snapshot())) == 45


def test_canonical_json_is_sorted_and_compact() -> None:
    text = canonical_json(snapshot())
    assert " " not in text.replace("A thank-you from the shop", "").replace(
        "Thank you for being a regular.", ""
    )
    assert list(json.loads(text).keys()) == sorted(json.loads(text).keys())


@pytest.mark.parametrize(
    "changed",
    [
        snapshot(campaign_id="camp-2"),
        snapshot(currency="EUR"),
        snapshot(email_subject="Another subject"),
        snapshot(item(receiver_email="someone.else@example.com")),
        snapshot(item(amount_minor=101)),
        snapshot(item(note="A different note.")),
        snapshot(item(sender_item_id="item-9")),
        snapshot(item(1), item(2)),
    ],
)
def test_any_field_change_gives_a_different_id(changed: BatchSnapshot) -> None:
    assert sender_batch_id_for(changed) != sender_batch_id_for(snapshot())


def test_email_case_and_spaces_do_not_change_the_id() -> None:
    shouted = snapshot(item(receiver_email="  BUYER1@Example.COM "))
    assert sender_batch_id_for(shouted) == sender_batch_id_for(snapshot())


def test_a_good_snapshot_passes() -> None:
    validate_snapshot(snapshot(item(1), item(2)), make_config())


def test_two_hundred_items_pass_and_two_hundred_one_do_not() -> None:
    config = make_config(campaign_cap=1_000_000)
    validate_snapshot(snapshot(*(item(n) for n in range(200))), config)
    with pytest.raises(SnapshotRefused):
        validate_snapshot(snapshot(*(item(n) for n in range(201))), config)


@pytest.mark.parametrize(
    "bad",
    [
        snapshot(items=()),
        snapshot(item(1), item(2, receiver_email=" Buyer1@EXAMPLE.com")),
        snapshot(item(1), item(2, sender_item_id="item-1")),
        snapshot(item(amount_minor=0)),
        snapshot(item(amount_minor=-5)),
        snapshot(item(amount_minor=1001)),
        snapshot(item(amount_minor=True)),
        snapshot(item(amount_minor=1.0)),
        snapshot(*(item(n, amount_minor=1000) for n in range(11))),
        snapshot(currency="EUR"),
        snapshot(item(note="x" * 401)),
        snapshot(item(note="Merci beaucoup é")),
        snapshot(item(note="Thanks\nagain")),
        snapshot(item(note="Thanks\x00")),
        snapshot(item(note="See HTTP stuff")),
        snapshot(item(note="Visit www.example")),
        snapshot(item(note="Write to us @shop")),
        snapshot(item(note="Call 5551234 now")),
        snapshot(item(note="")),
        snapshot(item(note="POSPYO001")),
        snapshot(item(note="ERRPYO005")),
        snapshot(item(note="POSPOI001")),
        snapshot(item(note="errpoi001 lower case")),
        snapshot(item(receiver_email="not-an-email")),
        snapshot(item(receiver_email="two@@example.com")),
        snapshot(item(sender_item_id="")),
        snapshot(item(sender_item_id="x" * 64)),
        snapshot(email_subject="Go to http now"),
        snapshot(campaign_id=""),
        snapshot(item(note="PayPal is giving you this thank-you")),
        snapshot(item(note="a gift from paypal")),
        snapshot(item(note="Thanks from Pay Pal")),
        snapshot(item(note="Thanks from P.a.y-P a l")),
        snapshot(email_subject="A PAYPAL reward"),
        snapshot(item(note="Venmo sent you this")),
        snapshot(item(note="A treat from VENMO's team")),
        snapshot(item(note="Thanks from Ven mo")),
        snapshot(item(note="a v-e-n-m-o thank-you")),
        snapshot(item(note="<b>Thanks</b>")),
        snapshot(item(note="Thanks > everything")),
        snapshot(item(note="Visit evil.example for a bonus")),
        snapshot(item(note="See x.co today")),
        snapshot(email_subject="A thank-you from shop.example"),
    ],
)
def test_validate_refuses(bad: BatchSnapshot) -> None:
    with pytest.raises(SnapshotRefused):
        validate_snapshot(bad, make_config())


def test_exactly_400_characters_and_six_digits_are_allowed() -> None:
    validate_snapshot(snapshot(item(note="x" * 400)), make_config())
    validate_snapshot(snapshot(item(note="Order 123456 thanks")), make_config())


def test_the_note_rule_names_why_paypal_or_venmo_is_refused_and_passes_ordinary_thanks() -> None:
    assert payouts.note_problem("We hope PayPal makes this easy", 400) == "names PayPal"
    assert payouts.note_problem("Sent with Venmo", 400) == "names Venmo"
    for ordinary in (
        "Thanks for the candles and the tea towels, we have missed you.",
        "Pay day treat from your pals",
        "We would love to see you even more often",
        "It has been seven months, so here is a thank-you",
        "You have given more to us than you know",
        "Thanks. See you soon, e.g. for the 3.5 inch candles.",
    ):
        assert payouts.note_problem(ordinary, 400) is None
    assert payouts.note_problem("<i>hi</i>", 400) == "has markup"
    assert payouts.note_problem("Visit evil.example", 400) == "looks like a link"


class PayPalScript:
    """Plays back a fixed list of answers to the payout POST and records each request."""

    def __init__(self, answers: list, get_answers: dict[str, httpx.Response] | None = None) -> None:
        self.answers = list(answers)
        self.get_answers = get_answers or {}
        self.posts: list[httpx.Request] = []
        self.gets: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 32000})
        if request.method == "POST":
            self.posts.append(request)
            answer = self.answers.pop(0)
            if isinstance(answer, Exception):
                raise answer
            return answer
        self.gets.append(request)
        return self.get_answers[request.url.path]


@pytest.fixture
def sleeps(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    recorded: list[float] = []
    monkeypatch.setattr(payouts, "_sleep", recorded.append)
    return recorded


def created(sender_batch_id: str, payout_batch_id: str = "BATCH1") -> httpx.Response:
    return httpx.Response(
        201,
        json={
            "batch_header": {
                "payout_batch_id": payout_batch_id,
                "batch_status": "PENDING",
                "sender_batch_header": {"sender_batch_id": sender_batch_id},
            }
        },
    )


def already_exists() -> httpx.Response:
    # The live sandbox answer, links list included: it is always empty.
    return httpx.Response(
        400,
        json={
            "name": "USER_BUSINESS_ERROR",
            "debug_id": "dbg",
            "details": [{"issue": "Batch with given sender_batch_id already exists", "field": "SENDER_BATCH_ID"}],
            "links": [],
        },
    )


def batch_view(payout_batch_id: str, sender_batch_id: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "batch_header": {
                "payout_batch_id": payout_batch_id,
                "batch_status": "SUCCESS",
                "sender_batch_header": {"sender_batch_id": sender_batch_id},
            }
        },
    )


def run(script: PayPalScript, snap: BatchSnapshot, known: str | None = None):
    http = PayPalHttp(make_config(), transport=httpx.MockTransport(script))
    return submit_batch(http, snap, known_payout_batch_id=known)


def test_body_matches_paypal_shape() -> None:
    snap = snapshot(item(receiver_email=" Buyer1@Example.com"))
    sbid = sender_batch_id_for(snap)
    script = PayPalScript([created(sbid)])
    run(script, snap)
    body = json.loads(script.posts[0].content)
    assert body["sender_batch_header"] == {
        "sender_batch_id": sbid,
        "email_subject": "A thank-you from the shop",
        "recipient_type": "EMAIL",
    }
    assert body["items"] == [
        {
            "recipient_type": "EMAIL",
            "receiver": "buyer1@example.com",
            "amount": {"currency": "USD", "value": "1.00"},
            "note": "Thank you for being a regular.",
            "sender_item_id": "item-1",
            "purpose": "CASHBACK",
        }
    ]


def test_server_error_then_created_resends_the_identical_request(sleeps: list[float]) -> None:
    snap = snapshot()
    sbid = sender_batch_id_for(snap)
    script = PayPalScript([httpx.Response(500, json={"name": "INTERNAL_SERVER_ERROR"}), created(sbid)])
    result = run(script, snap)
    assert result.outcome == "created"
    assert result.payout_batch_id == "BATCH1"
    assert len(script.posts) == 2
    first, second = script.posts
    assert first.headers["PayPal-Request-Id"] == second.headers["PayPal-Request-Id"] == sbid
    assert first.content == second.content
    assert json.loads(second.content)["sender_batch_header"]["sender_batch_id"] == sbid
    assert sleeps == [2]


def test_three_timeouts_end_in_submission_unknown(sleeps: list[float]) -> None:
    snap = snapshot()
    timeouts = [httpx.ReadTimeout("slow") for _ in range(3)]
    script = PayPalScript(timeouts)
    with pytest.raises(SubmissionUnknown) as caught:
        run(script, snap)
    assert caught.value.sender_batch_id == sender_batch_id_for(snap)
    assert len(script.posts) == 3
    assert sleeps == [2, 5]


def test_a_validation_error_is_raised_not_retried(sleeps: list[float]) -> None:
    rejected = httpx.Response(
        400,
        json={"name": "VALIDATION_ERROR", "debug_id": "dbg", "details": [{"issue": "purpose is invalid", "field": "items[0].purpose"}]},
    )
    script = PayPalScript([rejected])
    with pytest.raises(PayPalError) as caught:
        run(script, snapshot())
    assert caught.value.name == "VALIDATION_ERROR"
    assert len(script.posts) == 1
    assert sleeps == []


def test_a_bad_snapshot_never_reaches_paypal() -> None:
    script = PayPalScript([])
    with pytest.raises(SnapshotRefused):
        run(script, snapshot(item(amount_minor=5000)))
    assert script.posts == []


def test_already_exists_with_a_matching_known_id_returns_already_existed(sleeps: list[float]) -> None:
    snap = snapshot()
    sbid = sender_batch_id_for(snap)
    script = PayPalScript([already_exists()], {"/v1/payments/payouts/ORIGINAL1": batch_view("ORIGINAL1", sbid)})
    result = run(script, snap, known="ORIGINAL1")
    assert result.outcome == "already_existed"
    assert result.payout_batch_id == "ORIGINAL1"
    assert result.sender_batch_id == sbid
    assert len(script.posts) == 1
    assert [r.url.host for r in script.gets] == [SANDBOX_API_HOST]
    assert sleeps == []


def test_a_known_id_whose_batch_has_another_sender_batch_id_raises_submission_unknown() -> None:
    snap = snapshot()
    script = PayPalScript([already_exists()], {"/v1/payments/payouts/OTHER1": batch_view("OTHER1", "someone-else")})
    with pytest.raises(SubmissionUnknown) as caught:
        run(script, snap, known="OTHER1")
    assert not isinstance(caught.value, BatchExistsUnresolved)
    assert caught.value.sender_batch_id == sender_batch_id_for(snap)


def test_already_exists_with_no_known_id_raises_batch_exists_unresolved() -> None:
    snap = snapshot()
    script = PayPalScript([already_exists()])
    with pytest.raises(BatchExistsUnresolved) as caught:
        run(script, snap)
    assert isinstance(caught.value, SubmissionUnknown)
    assert caught.value.sender_batch_id == sender_batch_id_for(snap)
    assert "never resubmit under a different id" in caught.value.reason
    assert len(script.posts) == 1
    assert script.gets == []


def test_server_error_then_already_exists_with_a_known_id_returns_already_existed(sleeps: list[float]) -> None:
    snap = snapshot()
    sbid = sender_batch_id_for(snap)
    script = PayPalScript(
        [httpx.Response(500, json={"name": "INTERNAL_SERVER_ERROR"}), already_exists()],
        {"/v1/payments/payouts/ORIGINAL1": batch_view("ORIGINAL1", sbid)},
    )
    result = run(script, snap, known="ORIGINAL1")
    assert result.outcome == "already_existed"
    assert result.payout_batch_id == "ORIGINAL1"
    assert len(script.posts) == 2
    assert script.posts[0].headers["PayPal-Request-Id"] == script.posts[1].headers["PayPal-Request-Id"] == sbid
    assert sleeps == [2]
