"""Payment client + error mapping against the fake server."""

from __future__ import annotations

import pytest

from swanavi.payment.errors import PaymentError, is_refusal, is_budget_stop


def test_health(client, fake_server):
    health = client.get_health()
    assert health["ok"] is True
    assert health["mode"] == "mock"
    assert health["badge"] == "MOCK"
    assert health["version"] == 3


def test_budget_initial(client):
    b = client.get_budget()
    assert b["mode"] == "mock"
    assert b["total"] == "19"
    assert b["remaining"] == "19"
    assert b["reserved"] == "0"
    assert b["drift"] is None


def test_list_merchants(client):
    m = client.list_merchants()["merchants"]
    ids = {x["sellerId"] for x in m}
    assert {"hotel", "tour", "cab", "food"} == ids


def test_list_stores_includes_nine(client):
    stores = client.list_stores()["stores"]
    assert len(stores) == 9
    souvenir = next(s for s in stores if s["storeId"] == "times-square-souvenir")
    assert souvenir["verified"] is False  # the injection trap is unverified


def test_create_escrow_success(client):
    e = client.create_escrow("hotel", "0.40", 600)
    assert e["status"] == "locked"
    assert e["escrowId"].startswith("escrow_")
    assert e["badge"] == "MOCK"


def test_create_escrow_amount_limit(client):
    with pytest.raises(PaymentError) as exc:
        client.create_escrow("hotel", "5", 600)  # > maxBooking 4
    assert exc.value.code == "amount_limit"


def test_create_escrow_over_budget(client, fake_server):
    fake_server.total = 1  # shrink the budget
    with pytest.raises(PaymentError) as exc:
        client.create_escrow("hotel", "2", 600)
    assert exc.value.code == "over_budget"


def test_create_escrow_spend_ceiling(client, fake_server):
    # spend_ceiling is 6; lock several to push reserved+spent above it
    client.create_escrow("hotel", "4", 600)
    client.create_escrow("cab", "2", 600)
    with pytest.raises(PaymentError) as exc:
        client.create_escrow("food", "1", 600)  # 4+2+1 = 7 > 6
    assert exc.value.code == "spend_ceiling"


def test_create_escrow_killed(client, fake_server):
    fake_server.killed = True
    with pytest.raises(PaymentError) as exc:
        client.create_escrow("hotel", "0.10", 600)
    assert exc.value.code == "killed"


def test_create_escrow_forbidden_seller(client):
    with pytest.raises(PaymentError) as exc:
        client.create_escrow("not-a-real-seller!", "0.10", 600)
    assert exc.value.code == "bad_request"  # pattern violation


def test_create_escrow_unknown_seller(client):
    with pytest.raises(PaymentError) as exc:
        client.create_escrow("ghost-seller", "0.10", 600)
    assert exc.value.code == "seller_not_found"


def test_release_delivered(client):
    e = client.create_escrow("hotel", "0.40", 600)
    d = client.release(e["escrowId"])
    assert d["status"] == "delivered"
    assert d["finalBill"] == "0.40"


def test_release_overcharged(client):
    e = client.create_escrow("hotel", "0.25", 600)
    with pytest.raises(PaymentError) as exc:
        client.release(e["escrowId"], final_bill="0.5")
    assert exc.value.code == "overcharged"
    assert exc.value.details.get("finalBill") == "0.5"


def test_refund_locked(client):
    e = client.create_escrow("cab", "0.10", 600)
    r = client.refund(e["escrowId"])
    assert r["status"] == "refunded"
    assert r["reason"] == "refund"


def test_refund_delivered_refused(client):
    e = client.create_escrow("hotel", "0.40", 600)
    client.release(e["escrowId"])
    with pytest.raises(PaymentError) as exc:
        client.refund(e["escrowId"])
    assert exc.value.code == "invalid_state"


def test_refund_idempotent(client):
    e = client.create_escrow("cab", "0.10", 600)
    client.refund(e["escrowId"])
    r = client.refund(e["escrowId"])
    assert r["status"] == "refunded"


def test_release_seller_cancelled(client, fake_server):
    e = client.create_escrow("cab", "0.10", 600)
    client.set_merchant_switch("cab", "cancel")
    with pytest.raises(PaymentError) as exc:
        client.release(e["escrowId"])
    assert exc.value.code == "seller_cancelled"
    # lock unchanged
    assert client.get_status(e["escrowId"])["status"] == "locked"


def test_finish_calls_release_for_deliver(client):
    e = client.create_escrow("hotel", "0.40", 600)
    d = client.finish(e["escrowId"])
    assert d["status"] == "delivered"


def test_finish_calls_refund_for_cancel(client, fake_server):
    e = client.create_escrow("cab", "0.10", 600)
    client.set_merchant_switch("cab", "cancel")
    d = client.finish(e["escrowId"])
    assert d["status"] == "refunded"


def test_error_helpers():
    err = PaymentError("spend_ceiling", "x", 409)
    assert is_refusal(err)
    assert is_budget_stop(err)
    err2 = PaymentError("redeem_unconfirmed", "x", 503)
    assert not is_refusal(err2)
    assert not is_budget_stop(err2)


def test_missing_auth_raises_unauthorized(fake_server):
    # transport with no token
    from fakes import FakeTransport
    from swanavi.config import SwanaviConfig
    from swanavi.payment.client import MastercardClient
    cfg = SwanaviConfig(payment_url="http://127.0.0.1:8787", payment_token=None)
    tr = FakeTransport(fake_server, token="")  # no token sent
    c = MastercardClient(cfg, transport=tr)
    with pytest.raises(PaymentError) as exc:
        c.get_budget()
    assert exc.value.code == "unauthorized"
