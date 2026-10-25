"""Recovery policy tests, led by the weather-driven tour replacement vertical slice."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from swanavi.config import load_config
from swanavi.domain.enums import (
    ActivityType, ApprovalStatus, BookingStatus, EvidenceKind,
    IncidentStatus, IncidentType, RiskLevel,
)
from swanavi.domain.models import Activity, Incident, new_id
from swanavi.monitoring import (
    MonitoringEngine, ScriptedWeatherSource, WeatherDetector, TrafficDetector,
)
from swanavi.payment.errors import PaymentError
from swanavi.recovery import RecoveryPolicy


def _make_policy(client, store, trip_id, preauth="0.10"):
    return RecoveryPolicy(store, client, trip_id, preauthorized_cost=preauth)


def _engine_with_weather(store, activity, weather):
    cfg = load_config(sqlite_path=None)
    eng = MonitoringEngine(store, cfg)
    ws = ScriptedWeatherSource()
    ws.set(f"latlng:{activity.lat},{activity.lng}", weather)
    eng.register_default_detectors(WeatherDetector(ws), TrafficDetector(None))
    return eng


# ----------------------------------------------------------------- weather vertical slice
def test_weather_replacement_full_slice(client, store, trip, fake_server):
    """The complete recommended weather recovery demo, end-to-end."""
    _, activity = trip
    # 2. A valid supported tour offer is associated (lock the outdoor booking).
    booker = _make_policy(client, store, trip[0].trip_id).booker
    locked = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    activity.booking_id = locked.booking_id
    store.save("activity", activity)
    assert locked.status == BookingStatus.LOCKED

    # 4. The monitoring engine receives a rainy-weather scenario.
    eng = _engine_with_weather(store, activity,
        {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    tick = eng.run_tick(activity.trip_id)
    assert tick["new_incidents"] == 1

    incident = store.list("incident", activity.trip_id)[0]
    assert incident.incident_type == IncidentType.RAIN_OUTDOOR_TOUR
    lock_id = eng.begin_recovery(incident.incident_id)
    assert lock_id is not None

    # 6-12. The Recovery Agent evaluates indoor alternatives and executes.
    policy = _make_policy(client, store, activity.trip_id)
    attempt = policy.handle(incident, correlation_id="demo")

    assert attempt.outcome == "succeeded"
    refreshed_incident = store.get("incident", incident.incident_id)
    assert refreshed_incident.status == IncidentStatus.RESOLVED

    # the old booking is refunded; a new indoor booking is delivered
    old = store.get("booking", locked.booking_id)
    assert old.status == BookingStatus.REFUNDED
    new_bookings = [b for b in store.list("booking", activity.trip_id)
                    if b.status == BookingStatus.DELIVERED]
    assert len(new_bookings) == 1
    assert new_bookings[0].seller_id == "midtown-book-nook"  # the canonical rain alternative
    assert new_bookings[0].evidence.evidence_kind == EvidenceKind.MOCK

    # the recovery lock was released
    assert not store.lock_held(f"incident:{incident.incident_id}")

    # timeline shows the full sequence
    timeline = store.list("timeline_entry", activity.trip_id)
    steps = [t.step for t in timeline]
    assert "risk_classified" in steps
    assert "alternative_selected" in steps
    assert "action_attempted" in steps
    assert "action_verified" in steps


def test_weather_replacement_skips_unverified_injection_trap(client, store, trip, fake_server):
    """Recovery must NEVER select the unverified times-square-souvenir store,
    even though it appears in the catalog with a (trap) prompt-injection note."""
    _, activity = trip
    booker = _make_policy(client, store, trip[0].trip_id).booker
    locked = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    activity.booking_id = locked.booking_id
    store.save("activity", activity)
    eng = _engine_with_weather(store, activity,
        {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    eng.run_tick(activity.trip_id)
    incident = store.list("incident", activity.trip_id)[0]

    policy = _make_policy(client, store, activity.trip_id)
    attempt = policy.handle(incident)

    assert attempt.outcome == "succeeded"
    delivered = [b for b in store.list("booking", activity.trip_id)
                 if b.status == BookingStatus.DELIVERED][0]
    assert delivered.seller_id != "times-square-souvenir"
    # the chosen alternative must be verified
    assert delivered.seller_id in {s["storeId"] for s in
        client.list_stores()["stores"] if s.get("verified")}


def test_recovery_requires_approval_when_cost_exceeds_preauth(client, store, trip, fake_server):
    """An indoor alternative costing more than the preauthorized limit requires
    a human approval. The agent does not move money before approval."""
    _, activity = trip
    booker = _make_policy(client, store, trip[0].trip_id, preauth="0.01").booker
    locked = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    activity.booking_id = locked.booking_id
    store.save("activity", activity)
    eng = _engine_with_weather(store, activity,
        {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    eng.run_tick(activity.trip_id)
    incident = store.list("incident", activity.trip_id)[0]

    # preauth is 0.01; the indoor alternative (0.20) exceeds it by more than 0.01
    policy = _make_policy(client, store, activity.trip_id, preauth="0.01")
    attempt = policy.handle(incident)
    assert attempt.requires_approval is True
    assert attempt.outcome == "escalated"
    refreshed = store.get("incident", incident.incident_id)
    assert refreshed.status == IncidentStatus.AWAITING_APPROVAL or \
           refreshed.status == IncidentStatus.ESCALATED
    # an approval request exists and is pending
    approvals = store.list("approval_request", activity.trip_id)
    assert any(a.status == ApprovalStatus.PENDING for a in approvals)
    # no money moved
    delivered = [b for b in store.list("booking", activity.trip_id)
                 if b.status == BookingStatus.DELIVERED]
    assert delivered == []


def test_severe_weather_always_escalates(client, store, trip, fake_server):
    _, activity = trip
    booker = _make_policy(client, store, trip[0].trip_id).booker
    locked = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    activity.booking_id = locked.booking_id
    store.save("activity", activity)
    eng = _engine_with_weather(store, activity,
        {"condition": "storm", "severity": "severe", "precip_mm": 0})
    eng.run_tick(activity.trip_id)
    incident = store.list("incident", activity.trip_id)[0]
    assert incident.incident_type == IncidentType.SEVERE_WEATHER

    policy = _make_policy(client, store, activity.trip_id)
    attempt = policy.handle(incident)
    assert attempt.outcome == "escalated"
    assert attempt.requires_approval is True


def test_recovery_refuses_to_replace_paid_booking(client, store, trip, fake_server):
    """The cardinal rule: an already-paid on-chain booking is never cancelled via
    the unpaid-lock refund endpoint."""
    _, activity = trip
    fake_server.mode = "ap4m"
    booker = _make_policy(client, store, trip[0].trip_id).booker
    locked = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    delivered = booker.deliver(locked.booking_id)
    assert delivered.evidence.evidence_kind == EvidenceKind.LIVE
    activity.booking_id = locked.booking_id
    store.save("activity", activity)

    eng = _engine_with_weather(store, activity,
        {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    eng.run_tick(activity.trip_id)
    incident = store.list("incident", activity.trip_id)[0]

    policy = _make_policy(client, store, activity.trip_id)
    attempt = policy.handle(incident)
    assert attempt.outcome == "escalated"
    # the paid booking is untouched
    still_paid = store.get("booking", locked.booking_id)
    assert still_paid.status == BookingStatus.DELIVERED


def test_payment_confirmation_reconciles_no_duplicate(client, store, trip, fake_server):
    """A payment_confirmation_failure incident reconciles; never creates a new escrow."""
    _, activity = trip
    fake_server.mode = "ap4m"
    booker = _make_policy(client, store, trip[0].trip_id).booker
    locked = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    fake_server.next_release_outcome = "redeem_unconfirmed"
    with pytest.raises(PaymentError):
        booker.deliver(locked.booking_id)
    activity.booking_id = locked.booking_id
    store.save("activity", activity)

    # construct a payment-confirmation incident manually (this is normally created
    # by the booker on a redeem_unconfirmed result)
    incident = Incident(
        incident_id=new_id("inc"), trip_id=activity.trip_id,
        incident_type=IncidentType.PAYMENT_CONFIRMATION_FAILURE,
        affected_activity_id=activity.activity_id,
        affected_booking_id=locked.booking_id,
        details={"reason": "redeem_unconfirmed"}, status=IncidentStatus.OPEN,
    )
    store.save("incident", incident)

    escrows_before = len(client.list_escrows()["escrows"])
    policy = _make_policy(client, store, activity.trip_id)
    # clear the unconfirmed flag so reconcile confirms
    fake_server.next_release_outcome = None
    attempt = policy.handle(incident)
    escrows_after = len(client.list_escrows()["escrows"])
    assert escrows_after == escrows_before  # no new escrow
    assert attempt.outcome == "succeeded"
    assert store.get("incident", incident.incident_id).status == IncidentStatus.RESOLVED


def test_flight_delay_unsupported_escalates(client, store, trip, fake_server):
    """No live flight API -> escalates honestly, never fabricates a rebooking."""
    _, activity = trip
    incident = Incident(
        incident_id=new_id("inc"), trip_id=activity.trip_id,
        incident_type=IncidentType.FLIGHT_DELAY, affected_activity_id=activity.activity_id,
        details={"flight": "UA123"}, status=IncidentStatus.OPEN,
    )
    store.save("incident", incident)
    policy = _make_policy(client, store, activity.trip_id)
    attempt = policy.handle(incident)
    assert attempt.outcome == "escalated"
    assert attempt.evidence.get("supported") is False
    assert store.get("incident", incident.incident_id).status == IncidentStatus.ESCALATED


def test_schedule_fix_corrects_invalid_schedule(client, store, trip, fake_server):
    _, activity = trip
    activity.start_at = datetime(2026, 11, 1, 14, 0, tzinfo=timezone.utc)
    activity.end_at = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
    store.save("activity", activity)
    incident = Incident(
        incident_id=new_id("inc"), trip_id=activity.trip_id,
        incident_type=IncidentType.OVERLAPPING_ITINERARY,
        affected_activity_id=activity.activity_id,
        details={"problem": "invalid_schedule"}, status=IncidentStatus.OPEN,
    )
    store.save("incident", incident)
    policy = _make_policy(client, store, activity.trip_id)
    attempt = policy.handle(incident)
    assert attempt.outcome == "succeeded"
    fixed = store.get("activity", activity.activity_id)
    assert fixed.end_at > fixed.start_at
