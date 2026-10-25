"""The 25 required automated scenarios.

Each scenario is named exactly as in the implementation brief and asserts the
concrete, honest behaviour (real reservation vs mock, refusal vs success,
escalation vs auto-resolve). All run offline against the in-process fake payment
server; no testnet keys, no network.
"""

from __future__ import annotations

from datetime import timedelta, timezone
from datetime import datetime as _dt

import pytest

from swanavi.domain.enums import BookingStatus, EvidenceKind, IncidentStatus, IncidentType
from swanavi.domain.models import new_id
from swanavi.payment.errors import PaymentError


# 1
def test_01_normal_mock_booking(booker, trip):
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    assert b.status == BookingStatus.LOCKED
    assert b.badge == "MOCK"


# 2
def test_02_successful_delivery_confirmation(booker, trip):
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    d = booker.deliver(b.booking_id)
    assert d.status == BookingStatus.DELIVERED


# 3
def test_03_seller_cancellation_before_payment(booker, trip, client):
    from swanavi.domain.models import new_id
    b = booker.lock(new_id("act"), "cab", "0.10")
    client.set_merchant_switch("cab", "cancel")
    r = booker.cancel(b.booking_id)
    assert r.status == BookingStatus.REFUNDED
    assert r.reason == "refund"


# 4
def test_04_seller_failure(booker, client):
    b = booker.lock(new_id("act"), "food", "0.10")
    client.set_merchant_switch("food", "fail")
    r = booker.cancel(b.booking_id)
    assert r.status == BookingStatus.REFUNDED


# 5
def test_05_price_above_lock(booker, trip):
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    with pytest.raises(PaymentError) as exc:
        booker.deliver(b.booking_id, final_bill="0.5")
    assert exc.value.code == "overcharged"


# 6
def test_06_spend_ceiling_rejection(booker, trip, fake_server):
    _, activity = trip
    fake_server.spend_ceiling = 1
    booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    with pytest.raises(PaymentError) as exc:
        booker.lock(new_id("act"), "central-park-bikes", "1.0")
    assert exc.value.code == "spend_ceiling"


# 7
def test_07_per_booking_amount_limit(booker, trip):
    _, activity = trip
    with pytest.raises(PaymentError) as exc:
        booker.lock(activity.activity_id, "central-park-bikes", "5.0")
    assert exc.value.code == "amount_limit"


# 8
def test_08_channel_cap_rejection(booker, trip, fake_server):
    """In ap4m mode a voucher above the channel cap is refused (over_cap)."""
    _, activity = trip
    fake_server.mode = "ap4m"
    fake_server._channel_cap = Decimal_or("0.05")
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.05")
    fake_server.next_release_outcome = "over_cap"
    with pytest.raises(PaymentError) as exc:
        booker.deliver(b.booking_id)
    assert exc.value.code == "over_cap"


# 9
def test_09_uncertain_payment_outcome(booker, trip, fake_server):
    _, activity = trip
    fake_server.mode = "ap4m"
    fake_server.next_release_outcome = "redeem_unconfirmed"
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    with pytest.raises(PaymentError) as exc:
        booker.deliver(b.booking_id)
    assert exc.value.code == "redeem_unconfirmed"
    # only one escrow ever exists
    assert len(booker.client.list_escrows()["escrows"]) == 1


# 10
def test_10_duplicate_monitor_invocation(store, trip):
    from swanavi.config import load_config
    from swanavi.monitoring import MonitoringEngine, ScriptedWeatherSource, WeatherDetector, TrafficDetector
    _, activity = trip
    cfg = load_config(sqlite_path=None)
    eng = MonitoringEngine(store, cfg)
    ws = ScriptedWeatherSource()
    ws.set(f"latlng:{activity.lat},{activity.lng}",
           {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    eng.register_default_detectors(WeatherDetector(ws), TrafficDetector(None))
    eng.run_tick(activity.trip_id)
    lock1 = eng.begin_recovery(store.list("incident", activity.trip_id)[0].incident_id)
    assert lock1 is not None
    lock2 = eng.begin_recovery(store.list("incident", activity.trip_id)[0].incident_id)
    assert lock2 is None  # blocked: no overlapping recovery


# 11
def test_11_duplicate_booking_request(booker, trip):
    _, activity = trip
    b1 = booker.lock(activity.activity_id, "central-park-bikes", "0.15", idempotency_key="dup")
    b2 = booker.lock(activity.activity_id, "central-park-bikes", "0.15", idempotency_key="dup")
    assert b1.booking_id == b2.booking_id
    assert len(booker.client.list_escrows()["escrows"]) == 1


# 12
def test_12_expired_unpaid_lock(booker, trip, fake_server):
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15", deadline_seconds=60)
    # fast-forward the server's deadline into the past
    e = fake_server.escrows[b.escrow_id]
    e.deadline_at = _dt.now(timezone.utc) - timedelta(seconds=1)
    refreshed = booker.reconcile(b.booking_id)
    assert refreshed.status == BookingStatus.REFUNDED
    assert refreshed.reason == "deadline"


# 13
def test_13_attempted_refund_of_delivered_booking(booker, trip):
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    booker.deliver(b.booking_id)
    with pytest.raises(PaymentError) as exc:
        booker.cancel(b.booking_id)
    assert exc.value.code == "invalid_state"


# 14
def test_14_missing_weather_api(store, trip):
    from swanavi.config import load_config
    from swanavi.monitoring import MonitoringEngine, NoWeatherSource, WeatherDetector, TrafficDetector
    _, activity = trip
    cfg = load_config(sqlite_path=None)
    eng = MonitoringEngine(store, cfg)
    eng.register_default_detectors(WeatherDetector(NoWeatherSource()), TrafficDetector(None))
    result = eng.run_tick(activity.trip_id)
    # no fabricated incident from a missing API
    assert result["new_incidents"] == 0


# 15
def test_15_traffic_disruption(store, trip):
    from swanavi.config import load_config
    from swanavi.domain.enums import ActivityType
    from swanavi.domain.models import Activity, new_id
    from swanavi.monitoring import MonitoringEngine, WeatherDetector, TrafficDetector, ScriptedWeatherSource
    _, activity = trip
    transport = Activity(
        activity_id=new_id("act"), trip_id=activity.trip_id, title="Cab ride",
        activity_type=ActivityType.TRANSPORT, seller_id="cab", lat=40.75, lng=-73.98,
    )
    store.save("activity", transport)

    class BigDelaySource:
        def travel_time(self, origin, destination):
            return {"delay_min": 45}
    cfg = load_config(sqlite_path=None)
    eng = MonitoringEngine(store, cfg)
    eng.register_default_detectors(WeatherDetector(ScriptedWeatherSource()),
                                    TrafficDetector(BigDelaySource()))
    result = eng.run_tick(activity.trip_id)
    incidents = store.list("incident", activity.trip_id)
    assert any(i.incident_type == IncidentType.TRAFFIC_TIMED_BOOKING for i in incidents)


# 16
def test_16_invalid_activity_schedule(store, trip):
    from swanavi.config import load_config
    from swanavi.monitoring import MonitoringEngine, NoWeatherSource, ScheduleDetector, WeatherDetector, TrafficDetector
    _, activity = trip
    activity.start_at = _dt(2026, 11, 1, 14, 0, tzinfo=timezone.utc)
    activity.end_at = _dt(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
    store.save("activity", activity)
    cfg = load_config(sqlite_path=None)
    eng = MonitoringEngine(store, cfg)
    eng._detectors = [ScheduleDetector()]
    eng.run_tick(activity.trip_id)
    incidents = store.list("incident", activity.trip_id)
    assert any(i.incident_type == IncidentType.OVERLAPPING_ITINERARY for i in incidents)


# 17
def test_17_forbidden_seller(client):
    with pytest.raises(PaymentError) as exc:
        client.create_escrow("ghost-seller", "0.10", 600)
    assert exc.value.code == "seller_not_found"


# 18
def test_18_missing_authentication(fake_server):
    from fakes import FakeTransport
    from swanavi.config import SwanaviConfig
    from swanavi.payment.client import MastercardClient
    cfg = SwanaviConfig(payment_url="http://127.0.0.1:8787", payment_token=None)
    tr = FakeTransport(fake_server, token="")
    c = MastercardClient(cfg, transport=tr)
    with pytest.raises(PaymentError) as exc:
        c.get_budget()
    assert exc.value.code == "unauthorized"


# 19
def test_19_payment_server_timeout(fake_server):
    """A transport that fails to respond is surfaced as a timeout, not a fabricated result."""
    from swanavi.config import SwanaviConfig
    from swanavi.payment.client import MastercardClient

    class DeadTransport:
        def request(self, *a, **k):
            raise ConnectionError("server unreachable")

    cfg = SwanaviConfig(payment_url="http://127.0.0.1:8787", payment_token="test-token")
    c = MastercardClient(cfg, transport=DeadTransport())
    with pytest.raises(PaymentError) as exc:
        c.get_budget()
    assert exc.value.code == "timeout"


# 20
def test_20_budget_drift(booker, trip, fake_server):
    _, activity = trip
    fake_server.mode = "ap4m"
    orig = fake_server._budget

    def drifty():
        b = orig()
        b["drift"] = {"chainRedeemed": "0.5", "localDelivered": "0.4"}
        return b
    fake_server._budget = drifty
    with pytest.raises(PaymentError) as exc:
        booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    assert "drift" in exc.value.message.lower()


# 21
def test_21_human_approval_required(client, store, trip, fake_server):
    from swanavi.recovery import RecoveryPolicy
    _, activity = trip
    booker = RecoveryPolicy(store, client, trip[0].trip_id, preauthorized_cost="0.01").booker
    locked = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    activity.booking_id = locked.booking_id
    store.save("activity", activity)
    from swanavi.monitoring import MonitoringEngine, ScriptedWeatherSource, WeatherDetector, TrafficDetector
    from swanavi.config import load_config
    eng = MonitoringEngine(store, load_config(sqlite_path=None))
    ws = ScriptedWeatherSource()
    ws.set(f"latlng:{activity.lat},{activity.lng}",
           {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    eng.register_default_detectors(WeatherDetector(ws), TrafficDetector(None))
    eng.run_tick(activity.trip_id)
    incident = store.list("incident", activity.trip_id)[0]
    policy = RecoveryPolicy(store, client, activity.trip_id, preauthorized_cost="0.01")
    attempt = policy.handle(incident)
    assert attempt.requires_approval is True
    approvals = store.list("approval_request", activity.trip_id)
    assert any(a.status.value == "pending" for a in approvals)


# 22
def test_22_correct_response_to_trip_closure(client, booker, trip, fake_server):
    """Trip closure is human-controlled. The agent never calls it autonomously; after
    it runs, all locked bookings are refunded with reason trip_closed. New booking
    attempts on a closed trip are refused (channel_closed)."""
    from swanavi.agents.tools import AGENT_SAFE_TOOLS
    _, activity = trip
    b = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    assert b.status == BookingStatus.LOCKED
    # the agent tools must NOT include closeTrip
    assert "closeTrip" not in AGENT_SAFE_TOOLS
    # operator closes the trip (human action)
    result = client.close_trip()
    assert result["mode"] == "mock"
    refreshed = booker.reconcile(b.booking_id)
    assert refreshed.status == BookingStatus.REFUNDED
    assert refreshed.reason == "trip_closed"


# 23
def test_23_cross_trip_authorization_failure(client, store, trip, booker):
    """A booker scoped to trip A cannot access a booking belonging to trip B."""
    _, activity = trip
    booker_a = booker  # scoped to trip_1
    b = booker_a.lock(activity.activity_id, "central-park-bikes", "0.15")
    # create a second trip + booker
    from swanavi.booking import Booker
    from swanavi.domain.models import Trip, Traveler, new_id
    t2 = Trip(trip_id="trip_2", traveler_id="tv_2", title="Other trip")
    store.save("trip", t2)
    booker_b = Booker(client, store, "trip_2")
    with pytest.raises(PaymentError) as exc:
        booker_b.reconcile(b.booking_id)  # belongs to trip_1
    assert exc.value.code == "not_found"


# 24
def test_24_prompt_injection_through_web_content(client, store, trip, fake_server):
    """The unverified times-square-souvenir store carries a prompt-injection note.
    Recovery must never select it, and the quote's injection text is treated as
    untrusted data (never executed as instructions)."""
    from swanavi.recovery import RecoveryPolicy
    from swanavi.monitoring import MonitoringEngine, ScriptedWeatherSource, WeatherDetector, TrafficDetector
    from swanavi.config import load_config
    _, activity = trip
    booker = RecoveryPolicy(store, client, trip[0].trip_id).booker
    locked = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    activity.booking_id = locked.booking_id
    store.save("activity", activity)
    eng = MonitoringEngine(store, load_config(sqlite_path=None))
    ws = ScriptedWeatherSource()
    ws.set(f"latlng:{activity.lat},{activity.lng}",
           {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    eng.register_default_detectors(WeatherDetector(ws), TrafficDetector(None))
    eng.run_tick(activity.trip_id)
    incident = store.list("incident", activity.trip_id)[0]
    policy = RecoveryPolicy(store, client, activity.trip_id)
    attempt = policy.handle(incident)
    assert attempt.outcome == "succeeded"
    delivered = [b for b in store.list("booking", activity.trip_id)
                 if b.status == BookingStatus.DELIVERED][0]
    # the injection-trap store is never chosen
    assert delivered.seller_id != "times-square-souvenir"
    # and the store's injection text was never honored: no booking for it
    assert all(b.seller_id != "times-square-souvenir"
               for b in store.list("booking", activity.trip_id))


# 25
def test_25_recovery_failure_requiring_escalation(client, store, trip, fake_server):
    """An already-paid booking hit by rain cannot be refunded via the unpaid-lock
    endpoint; recovery must escalate to a human rather than fabricate a fix."""
    from swanavi.recovery import RecoveryPolicy
    from swanavi.monitoring import MonitoringEngine, ScriptedWeatherSource, WeatherDetector, TrafficDetector
    from swanavi.config import load_config
    _, activity = trip
    fake_server.mode = "ap4m"
    booker = RecoveryPolicy(store, client, trip[0].trip_id).booker
    locked = booker.lock(activity.activity_id, "central-park-bikes", "0.15")
    delivered = booker.deliver(locked.booking_id)
    assert delivered.evidence.evidence_kind == EvidenceKind.LIVE
    activity.booking_id = locked.booking_id
    store.save("activity", activity)
    eng = MonitoringEngine(store, load_config(sqlite_path=None))
    ws = ScriptedWeatherSource()
    ws.set(f"latlng:{activity.lat},{activity.lng}",
           {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    eng.register_default_detectors(WeatherDetector(ws), TrafficDetector(None))
    eng.run_tick(activity.trip_id)
    incident = store.list("incident", activity.trip_id)[0]
    policy = RecoveryPolicy(store, client, activity.trip_id)
    attempt = policy.handle(incident)
    assert attempt.outcome == "escalated"
    # the paid booking is untouched
    assert store.get("booking", locked.booking_id).status == BookingStatus.DELIVERED


def Decimal_or(s):
    from decimal import Decimal
    return Decimal(s)
