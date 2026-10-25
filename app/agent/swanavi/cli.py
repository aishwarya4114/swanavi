"""Swanavi local CLI.

Runs the full weather-recovery demo end-to-end with an in-process fake of the
Mastercard payment server (no Node server, no keys, no network needed). Can also
point at the real payment server by exporting SWANAVI_PAYMENT_URL and
SWANAVI_PAYMENT_TOKEN.

Usage:
    python -m swanavi.cli demo        # the 5-minute weather-recovery scenario
    python -m swanavi.cli status       # print the trip dashboard JSON
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

from .config import load_config
from .domain.enums import ActivityType, BookingStatus
from .domain.models import Activity, Itinerary, new_id
from .monitoring.detectors import ScriptedWeatherSource
from .orchestrator import SwanaviOrchestrator
from .payment.client import MastercardClient, UrllibTransport
from .storage.store import SwanaviStore


def _build_orchestrator(use_fake: bool = True) -> tuple[SwanaviOrchestrator, Optional[object]]:
    """Build the orchestrator. With use_fake, an in-process fake payment server
    stands in for the protected Node server (offline demo). Otherwise connect to
    the real server via the configured URL + token."""
    store = SwanaviStore()
    config = load_config()
    weather = ScriptedWeatherSource()
    if use_fake:
        # offline demo: ensure a token is set so the client authenticates to the fake
        if not config.payment_token:
            config = load_config(payment_token="demo-token")
        # import the test fake lazily so the package has no test-time dependency
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "tests"))
        from fakes import FakePaymentServer, FakeTransport  # type: ignore
        server = FakePaymentServer()
        transport = FakeTransport(server, token=config.payment_token)
        client = MastercardClient(config, transport=transport)
        return SwanaviOrchestrator(client, store, config, weather_source=weather), server
    client = MastercardClient(config, transport=UrllibTransport())
    return SwanaviOrchestrator(client, store, config, weather_source=weather), None


def _print(label: str, obj) -> None:
    print(f"\n=== {label} ===")
    print(json.dumps(obj, indent=2, default=str))


def run_demo() -> int:
    print("Swanavi — weather-driven recovery demo (in-process, offline, MOCK payments)")
    orch, _server = _build_orchestrator(use_fake=True)

    # 1. Traveler + trip with an outdoor tour
    orch.create_traveler("traveler_ada", "Ada Lovelace")
    trip = orch.create_trip("traveler_ada", title="NYC weekend", destination="New York",
                             budget_rlusd="19")
    itin = Itinerary(itinerary_id=new_id("itin"), trip_id=trip.trip_id, version=1)
    outdoor = Activity(
        activity_id=new_id("act"), trip_id=trip.trip_id,
        title="Central Park bike rental", activity_type=ActivityType.OUTDOOR_TOUR,
        seller_id="central-park-bikes", store_id="central-park-bikes", sku="BIKE-2H",
        amount="0.15", indoor=False, refundable=True, verified=True,
        lat=40.7829, lng=-73.9654,
        start_at=datetime.now(timezone.utc) + timedelta(days=1, hours=2),
        end_at=datetime.now(timezone.utc) + timedelta(days=1, hours=4),
    )
    orch.store.save("activity", outdoor)
    itin.activities = [outdoor]
    orch.store.save("itinerary", itin)
    trip.current_itinerary_id = itin.itinerary_id
    orch.store.save("trip", trip)
    print(f"\nTrip created: {trip.trip_id} ({trip.title})")

    # 2. A valid supported tour offer is associated (lock the outdoor booking)
    orch.weather_source.set(f"latlng:{outdoor.lat},{outdoor.lng}",
                             {"condition": "clear", "severity": "low", "precip_mm": 0})
    booking = orch.lock_activity(trip.trip_id, outdoor.activity_id,
                                  "central-park-bikes", "0.15")
    outdoor.booking_id = booking["booking_id"]
    orch.store.save("activity", outdoor)
    _print("2. Outdoor booking locked (MOCK)", {k: booking[k] for k in
            ("booking_id", "seller_id", "amount", "status", "badge", "evidence")})

    # 4. The monitoring engine receives a rainy-weather scenario
    orch.weather_source.set(f"latlng:{outdoor.lat},{outdoor.lng}",
                             {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    # detect only (emit=False) so the demo can show the recovery step explicitly
    tick = orch.run_monitoring_tick(trip.trip_id, emit=False)
    _print("4. Monitoring tick detected rain", {k: tick[k] for k in
            ("observations", "new_incidents", "unsupported_sources")})

    # 5-12. Master Agent identifies the affected activity and recovers
    incidents = orch.store.list("incident", trip.trip_id)
    result = orch.handle_incident(incidents[0].incident_id)
    _print("5-12. Recovery outcome", {
        "action": result.action, "outcome": result.outcome, "message": result.message,
        "new_booking_id": result.new_booking_id,
        "additional_cost": result.additional_cost,
        "evidence_kind": result.evidence_kind})

    # 13. The UI displays the recovery timeline
    _print("13. Recovery timeline", orch.agent_timeline(trip.trip_id))

    # final dashboard
    dash = orch.trip_dashboard(trip.trip_id)
    delivered = [b for b in dash["bookings"] if b["status"] == "delivered"]
    refunded = [b for b in dash["bookings"] if b["status"] == "refunded"]
    print(f"\nResult: {len(delivered)} delivered, {len(refunded)} refunded; "
          f"trip_health={dash['trip_health']}")
    if delivered:
        print(f"New indoor booking: seller={delivered[0]['seller_id']}, "
              f"badge={delivered[0]['badge']}, evidence={delivered[0]['evidence']['badge']}")
    print("\nHonesty labels: outdoor lock refunded (unpaid, never signed); "
          "indoor replacement delivered as MOCK (in-process fake, no chain).")
    return 0


def run_status() -> int:
    # demonstrate reading a dashboard for a fresh trip
    orch, _ = _build_orchestrator(use_fake=True)
    orch.create_traveler("tv", "Demo")
    trip = orch.create_trip("tv", title="Demo trip")
    _print("trip dashboard", orch.trip_dashboard(trip.trip_id))
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    argv = list(argv if argv is not None else sys.argv[1:])
    cmd = argv[0] if argv else "demo"
    if cmd == "demo":
        return run_demo()
    if cmd == "status":
        return run_status()
    print(f"unknown command: {cmd}\nusage: python -m swanavi.cli [demo|status]")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
