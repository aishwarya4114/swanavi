"""AgentCore Evaluation fixtures.

Reproducible scenarios + expected outcomes that feed AgentCore Evaluations (and
run locally with no LLM/network). Each fixture asserts a measurable behaviour:
duplicate-payment prevention, incident classification, safe recovery, budget
compliance, accurate status reporting, appropriate human escalation, and
correct handling of uncertain settlements.

The local runner (:func:`run_all`) executes each fixture against the in-process
fake payment server and returns pass/fail with the observed trajectory. This is
the "before/after" evidence AgentCore Optimization consumes.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from ..domain.enums import ActivityType, BookingStatus, EvidenceKind, IncidentStatus, IncidentType
from ..domain.models import Activity, Incident, Itinerary, new_id
from ..monitoring.detectors import ScriptedWeatherSource
from ..orchestrator import SwanaviOrchestrator


@dataclass
class EvalFixture:
    name: str
    capability: str          # e.g. "duplicate_payment_prevention"
    description: str
    expected: dict
    run: Any                 # callable(orchestrator, weather) -> dict (observed)


# A shared harness: fresh orchestrator + trip + outdoor activity, ready to drive.
def _harness(client, store, config, *, outdoor_amount="0.15", preauth="0.10"):
    weather = ScriptedWeatherSource()
    orch = SwanaviOrchestrator(client, store, config, weather_source=weather)
    orch.create_traveler("eval_user", "Eval")
    trip = orch.create_trip("eval_user", title="Eval NYC", destination="New York",
                             budget_rlusd="19")
    itin = Itinerary(itinerary_id=new_id("itin"), trip_id=trip.trip_id, version=1)
    outdoor = Activity(
        activity_id=new_id("act"), trip_id=trip.trip_id,
        title="Central Park bike rental", activity_type=ActivityType.OUTDOOR_TOUR,
        seller_id="central-park-bikes", store_id="central-park-bikes", sku="BIKE-2H",
        amount=outdoor_amount, indoor=False, refundable=True, verified=True,
        lat=40.7829, lng=-73.9654,
    )
    store.save("activity", outdoor)
    itin.activities = [outdoor]
    store.save("itinerary", itin)
    trip.current_itinerary_id = itin.itinerary_id
    store.save("trip", trip)
    return orch, weather, trip, outdoor


FIXTURES: list[EvalFixture] = []


def fixture(name: str, capability: str, description: str, expected: dict):
    def deco(fn):
        FIXTURES.append(EvalFixture(name, capability, description, expected, fn))
        return fn
    return deco


@fixture("duplicate_payment_prevention", "duplicate_payment_prevention",
         "An ambiguous redeem_unconfirmed never creates a second escrow; the same id is preserved and the retry only confirms.",
         {"new_escrows_created": 0, "outcome_in": ["delivered", "paying"]})
def f_duplicate(orch, weather, trip, outdoor, *, fake_server=None):
    if fake_server is not None:
        fake_server.mode = "ap4m"
        fake_server.next_release_outcome = "redeem_unconfirmed"
    from ..payment.errors import PaymentError
    booking = orch.booker(trip.trip_id).lock(outdoor.activity_id, "central-park-bikes", "0.15")
    outdoor.booking_id = booking.booking_id
    orch.store.save("activity", outdoor)
    escrows_before = len(orch.client.list_escrows()["escrows"])
    try:
        orch.booker(trip.trip_id).deliver(booking.booking_id)
    except PaymentError:
        pass
    # retry once (confirmation only)
    if fake_server is not None:
        fake_server.next_release_outcome = None
    try:
        orch.booker(trip.trip_id).deliver(booking.booking_id)
    except PaymentError:
        pass
    escrows_after = len(orch.client.list_escrows()["escrows"])
    # the final booking state: delivered (confirmation recovered) or paying (still
    # waiting). Either is safe; a second payment would never produce a new escrow.
    final = orch.booker(trip.trip_id).reconcile(booking.booking_id)
    return {"new_escrows_created": escrows_after - escrows_before,
            "outcome": final.status.value}


@fixture("incident_classification", "incident_classification",
         "A rain forecast for an outdoor activity is classified rain_outdoor_tour, not severe_weather.",
         {"incident_type": "rain_outdoor_tour", "risk": "medium"})
def f_classify(orch, weather, trip, outdoor, **_):
    weather.set(f"latlng:{outdoor.lat},{outdoor.lng}",
                {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    orch.run_monitoring_tick(trip.trip_id, emit=False)
    inc = orch.store.list("incident", trip.trip_id)
    if not inc:
        return {"incident_type": None}
    return {"incident_type": inc[0].incident_type.value, "risk": inc[0].risk_level.value}


@fixture("safe_recovery_weather", "safe_recovery",
         "Weather recovery refunds the unpaid outdoor lock and delivers a verified indoor alternative.",
         {"old_status": "refunded", "new_status": "delivered",
          "new_seller_not": "times-square-souvenir", "incident_resolved": True})
def f_recovery(orch, weather, trip, outdoor, **_):
    booking = orch.booker(trip.trip_id).lock(outdoor.activity_id, "central-park-bikes", "0.15")
    outdoor.booking_id = booking.booking_id
    orch.store.save("activity", outdoor)
    weather.set(f"latlng:{outdoor.lat},{outdoor.lng}",
                {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    orch.run_monitoring_tick(trip.trip_id, emit=False)
    inc = orch.store.list("incident", trip.trip_id)[0]
    orch.handle_incident(inc.incident_id)
    old = orch.store.get("booking", booking.booking_id)
    delivered = [b for b in orch.store.list("booking", trip.trip_id)
                 if b.status == BookingStatus.DELIVERED]
    return {
        "old_status": old.status.value,
        "new_status": delivered[0].status.value if delivered else None,
        "new_seller": delivered[0].seller_id if delivered else None,
        "new_seller_not": (delivered[0].seller_id if delivered else "times-square-souvenir"),
        "incident_resolved": orch.store.get("incident", inc.incident_id).status == IncidentStatus.RESOLVED,
    }


@fixture("budget_compliance", "budget_compliance",
         "A lock above the spend ceiling is refused; nothing is reserved and no escrow is created.",
         {"error_code": "spend_ceiling", "new_escrows": 0})
def f_budget(orch, weather, trip, outdoor, *, fake_server=None):
    if fake_server is not None:
        fake_server.spend_ceiling = 1
    from ..payment.errors import PaymentError
    orch.booker(trip.trip_id).lock(outdoor.activity_id, "central-park-bikes", "0.15")
    code = None
    # measure only the delta caused by the refused lock, so other fixtures sharing
    # this fake server cannot inflate the count
    escrows_before = len(orch.client.list_escrows()["escrows"])
    try:
        orch.booker(trip.trip_id).lock(new_id("act"), "central-park-bikes", "1.0")
    except PaymentError as exc:
        code = exc.code
    escrows_after = len(orch.client.list_escrows()["escrows"])
    return {"error_code": code, "new_escrows": escrows_after - escrows_before}


@fixture("human_escalation", "human_escalation",
         "An already-paid booking hit by rain escalates instead of being refunded.",
         {"outcome": "escalated", "paid_booking_untouched": True})
def f_escalate(orch, weather, trip, outdoor, *, fake_server=None):
    if fake_server is not None:
        fake_server.mode = "ap4m"
    booking = orch.booker(trip.trip_id).lock(outdoor.activity_id, "central-park-bikes", "0.15")
    delivered = orch.booker(trip.trip_id).deliver(booking.booking_id)
    outdoor.booking_id = booking.booking_id
    orch.store.save("activity", outdoor)
    weather.set(f"latlng:{outdoor.lat},{outdoor.lng}",
                {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    orch.run_monitoring_tick(trip.trip_id, emit=False)
    inc = orch.store.list("incident", trip.trip_id)[0]
    result = orch.handle_incident(inc.incident_id)
    still = orch.store.get("booking", booking.booking_id)
    return {"outcome": result.outcome,
            "paid_booking_untouched": still.status == BookingStatus.DELIVERED}


@fixture("uncertain_settlement_handling", "uncertain_settlement_handling",
         "A payment-confirmation failure reconciles the existing escrow, never a new one, and resolves on confirm.",
         {"new_escrows": 0, "outcome": "resolved"})
def f_uncertain(orch, weather, trip, outdoor, *, fake_server=None):
    if fake_server is not None:
        fake_server.mode = "ap4m"
        fake_server.next_release_outcome = "redeem_unconfirmed"
    from ..payment.errors import PaymentError
    booking = orch.booker(trip.trip_id).lock(outdoor.activity_id, "central-park-bikes", "0.15")
    try:
        orch.booker(trip.trip_id).deliver(booking.booking_id)
    except PaymentError:
        pass
    outdoor.booking_id = booking.booking_id
    orch.store.save("activity", outdoor)
    inc = Incident(
        incident_id=new_id("inc"), trip_id=trip.trip_id,
        incident_type=IncidentType.PAYMENT_CONFIRMATION_FAILURE,
        affected_activity_id=outdoor.activity_id, affected_booking_id=booking.booking_id,
        details={"reason": "redeem_unconfirmed"}, status=IncidentStatus.OPEN,
    )
    orch.store.save("incident", inc)
    escrows_before = len(orch.client.list_escrows()["escrows"])
    if fake_server is not None:
        fake_server.next_release_outcome = None
    orch.handle_incident(inc.incident_id)
    escrows_after = len(orch.client.list_escrows()["escrows"])
    return {"new_escrows": escrows_after - escrows_before,
            "outcome": orch.store.get("incident", inc.incident_id).status.value}


def run_all(client=None, store=None, config=None, *, fake_server=None) -> dict:
    """Run every fixture in complete isolation (each gets its own fake server, client,
    and in-memory store). Caller-supplied objects are ignored to prevent state bleed
    between fixtures — mutations like spend_ceiling overrides or mode='ap4m' must not
    contaminate subsequent fixtures.

    Returns pass/fail + observed trajectories for all fixtures.
    """
    import sys, os
    # ensure tests/ directory is on the path for FakePaymentServer / FakeTransport
    _tests_dir = os.path.normpath(
        os.path.join(os.path.dirname(__file__), '..', '..', '..', 'tests')
    )
    if _tests_dir not in sys.path:
        sys.path.insert(0, _tests_dir)
    from fakes import FakePaymentServer, FakeTransport  # type: ignore
    # absolute imports — relative imports can't reach this depth from eval/fixtures.py
    from swanavi.payment.client import MastercardClient
    from swanavi.storage.store import SwanaviStore
    from swanavi.config import load_config as _load_config

    results = []
    for fx in FIXTURES:
        # Fresh isolated server + client + store for every fixture
        srv = FakePaymentServer()
        token = "eval-token"
        tr = FakeTransport(srv, token=token)
        cfg = _load_config(payment_token=token)
        isolated_client = MastercardClient(cfg, transport=tr)
        isolated_store = SwanaviStore()

        orch, weather, trip, outdoor = _harness(isolated_client, isolated_store, cfg)
        try:
            observed = fx.run(orch, weather, trip, outdoor, fake_server=srv)
        except Exception as exc:
            observed = {"error": str(exc)}
        passed = _matches(observed, fx.expected)
        results.append({
            "name": fx.name, "capability": fx.capability,
            "description": fx.description, "expected": fx.expected,
            "observed": observed, "passed": passed,
        })
    summary = {"total": len(results), "passed": sum(1 for r in results if r["passed"]),
               "results": results}
    return summary


def _matches(observed: dict, expected: dict) -> bool:
    for k, v in expected.items():
        if k.endswith("_in"):
            field = k[:-3]
            if observed.get(field) not in v:
                return False
            continue
        if k == "new_seller_not":
            if observed.get("new_seller") == v:
                return False
            continue
        if observed.get(k) != v:
            return False
    return True
