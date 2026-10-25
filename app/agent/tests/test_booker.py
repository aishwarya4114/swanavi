"""Booker tests — the payment-safety invariants enforced in code."""

from __future__ import annotations

import pytest

from swanavi.domain.enums import BookingStatus, EvidenceKind
from swanavi.payment.errors import PaymentError


def test_normal_mock_booking(booker, trip):
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15", idempotency_key="k1")
    assert b.status == BookingStatus.LOCKED
    assert b.escrow_id is not None
    assert b.badge == "MOCK"
    assert b.evidence.evidence_kind == EvidenceKind.MOCK


def test_successful_delivery(booker, trip):
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    d = booker.deliver(b.booking_id)
    assert d.status == BookingStatus.DELIVERED
    assert d.evidence.evidence_kind == EvidenceKind.MOCK  # mock server


def test_seller_cancellation_before_payment(booker, trip, client, fake_server):
    """A base seller switched to 'cancel' refunds an unpaid lock (via finish)."""
    from swanavi.domain.models import new_id
    _, activity = trip
    # use a base seller (cab) so the merchant switch applies
    b = booker.lock(new_id("act"), "cab", "0.10")
    client.set_merchant_switch("cab", "cancel")
    r = booker.cancel(b.booking_id)
    assert r.status == BookingStatus.REFUNDED
    assert r.reason == "refund"


def test_price_above_lock_overcharged(booker, trip):
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    with pytest.raises(PaymentError) as exc:
        booker.deliver(b.booking_id, final_bill="0.5")
    assert exc.value.code == "overcharged"
    refreshed = booker.reconcile(b.booking_id)
    assert refreshed.status == BookingStatus.OVERCHARGED


def test_spend_ceiling_rejection(booker, trip, fake_server):
    _, activity = trip
    fake_server.spend_ceiling = 1  # tiny ceiling
    booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    with pytest.raises(PaymentError) as exc:
        booker.lock(activity.activity_id + "_2", "central-park-bikes", "1.0")
    assert exc.value.code == "spend_ceiling"


def test_per_booking_amount_limit(booker, trip):
    _, activity = trip
    with pytest.raises(PaymentError) as exc:
        booker.lock(activity.activity_id, "central-park-bikes", "5.0")
    assert exc.value.code == "amount_limit"


def test_duplicate_booking_request_is_idempotent(booker, trip):
    _, activity = trip
    b1 = booker.lock(activity.activity_id, "central-park-bikes", "0.15", idempotency_key="dup-key")
    b2 = booker.lock(activity.activity_id, "central-park-bikes", "0.15", idempotency_key="dup-key")
    # same idempotency key => same booking, no duplicate escrow
    assert b1.booking_id == b2.booking_id
    escrows = booker.client.list_escrows()["escrows"]
    assert len(escrows) == 1


def test_duplicate_booking_for_same_activity(booker, trip):
    _, activity = trip
    booker.lock(activity.activity_id, "central-park-bikes", "0.15", idempotency_key="a")
    booker.lock(activity.activity_id, "central-park-bikes", "0.15", idempotency_key="b")
    # two different keys but same activity => second returns the existing (no dup)
    escrows = booker.client.list_escrows()["escrows"]
    assert len(escrows) == 1


def test_refund_delivered_booking_refused(booker, trip):
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    booker.deliver(b.booking_id)
    with pytest.raises(PaymentError) as exc:
        booker.cancel(b.booking_id)
    assert exc.value.code == "invalid_state"
    assert "on chain" in exc.value.message or "paid" in exc.value.message.lower()


def test_refuse_refund_when_live_paid(booker, trip, fake_server):
    """In ap4m mode a delivered booking is LIVE; refund must be refused."""
    _, activity = trip
    fake_server.mode = "ap4m"
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    d = booker.deliver(b.booking_id)
    assert d.evidence.evidence_kind == EvidenceKind.LIVE
    with pytest.raises(PaymentError) as exc:
        booker.cancel(b.booking_id)
    assert exc.value.code == "invalid_state"
    assert "on chain" in exc.value.message


def test_uncertain_payment_reconciled_no_duplicate_escrow(booker, trip, fake_server):
    """redeem_unconfirmed must NOT create a new escrow; reconcile preserves the id."""
    _, activity = trip
    fake_server.mode = "ap4m"
    fake_server.next_release_outcome = "redeem_unconfirmed"
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    with pytest.raises(PaymentError) as exc:
        booker.deliver(b.booking_id)
    assert exc.value.code == "redeem_unconfirmed"
    # re-read the persisted record (deliver operates on a fresh load, not b)
    stored = booker.reconcile(b.booking_id)
    assert stored.status == BookingStatus.PAYING
    escrows_before = booker.client.list_escrows()["escrows"]
    assert len(escrows_before) == 1
    # retrying release retries confirmation only; still one escrow
    fake_server.next_release_outcome = None
    booker.deliver(b.booking_id)
    assert len(booker.client.list_escrows()["escrows"]) == 1


def test_budget_drift_stops_new_bookings(booker, trip, fake_server):
    _, activity = trip
    fake_server.mode = "ap4m"
    # inject drift into the budget response
    orig = fake_server._budget

    def drifty_budget():
        b = orig()
        b["drift"] = {"chainRedeemed": "0.5", "localDelivered": "0.4"}
        return b
    fake_server._budget = drifty_budget
    with pytest.raises(PaymentError) as exc:
        booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    assert exc.value.code == "invalid_state"
    assert "drift" in exc.value.message.lower()


def test_reconcile_all_syncs_local(booker, trip):
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    booker.deliver(b.booking_id)
    updated = booker.reconcile_all()
    assert any(x.status == BookingStatus.DELIVERED for x in updated)


def test_replace_unpaid_booking_requires_locked(booker, trip):
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    booker.deliver(b.booking_id)
    with pytest.raises(PaymentError) as exc:
        booker.replace_unpaid_booking(b.booking_id, "alt-act", "midtown-book-nook", "0.20")
    assert exc.value.code == "invalid_state"
