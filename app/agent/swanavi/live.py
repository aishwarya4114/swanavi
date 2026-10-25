"""Live demo runs.

A run records traveler inputs and the milestones that have actually happened.
Creating a run does not call Bedrock and does not create an escrow. Nova evidence
is recorded only when the Next server posts a completed runtime stream. A
Mastercard escrow is created only by ``approve_booking`` after the quote checks
pass. Rain, overcharge, timeout, and rebook use the in-process fake and are
labeled offline simulations.
"""

from __future__ import annotations

import re
import threading
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Optional

from .config import DEFAULT_PAYMENT_URL, load_config
from .domain.enums import ActivityType, IncidentStatus, IncidentType
from .domain.models import Activity, Incident, new_id, utcnow
from .envfile import load_local_env
from .payment.client import MastercardClient, UrllibTransport
from .payment.errors import PaymentError

QUOTES = {
    "hotel": Decimal("4"),
    "tour": Decimal("3"),
    "cab": Decimal("2"),
    "food": Decimal("2.5"),
}
_QUOTE_TEXT = {seller: format(amount, "f") for seller, amount in QUOTES.items()}
_RUN_ID = re.compile(r"^run_[a-f0-9]{16}$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_FORBIDDEN_LOG = ("/fund", "/kill-switch", "/merchants", "/trip/close")


class LiveError(Exception):
    def __init__(self, status: int, code: str):
        self.status = status
        self.code = code


class LiveBoard:
    def __init__(self):
        self._cv = threading.Condition()
        self._runs: dict[str, dict] = {}

    def create(self, body: dict) -> dict:
        trip = _trip_input(body)
        run_id = new_id("run")
        run = {
            "run_id": run_id,
            **trip,
            "events": [],
            "itinerary": None,
            "nova": None,
            "gate": None,
            "escrow": None,
            "budget_before": None,
            "budget_after": None,
            "recovery": "waiting",
            "simulations": {},
        }
        with self._cv:
            self._runs[run_id] = run
            self._event(run, "request_received", (
                f"Live run received for {trip['destination']}, "
                f"{trip['start_date']} to {trip['end_date']}, "
                f"{trip['travelers']} travelers, budget {trip['budget_rlusd']} RLUSD."
            ), "local")
            self._event(run, "nova_approval_required", (
                "Nova planning is waiting for explicit approval. "
                "No Bedrock request has been sent."
            ), "local")
            self._event(run, "trip_status", (
                f"Destination stays {trip['destination']}. "
                "No model call and no payment call have been made."
            ), "local")
            self._cv.notify_all()
            return self._public(run)

    def get(self, run_id: str) -> dict:
        with self._cv:
            return self._public(self._must(run_id))

    def events(self, run_id: str) -> list[dict]:
        with self._cv:
            run = self._must(run_id)
            return list(run["events"])

    def wait(self, timeout: float) -> None:
        with self._cv:
            self._cv.wait(timeout=timeout)

    def record_nova(self, run_id: str, body: dict) -> dict:
        if not isinstance(body, dict) or body.get("confirm") != "record-nova-evidence":
            raise LiveError(400, "evidence_required")
        model_calls = body.get("modelCalls")
        if not isinstance(model_calls, int) or isinstance(model_calls, bool) or model_calls < 1:
            raise LiveError(400, "no_model_evidence")
        itinerary = body.get("itinerary")
        if not isinstance(itinerary, str) or not itinerary.strip():
            raise LiveError(400, "no_itinerary")
        itinerary = itinerary.strip()[:4000]
        delegated = body.get("delegatedToPlanner") is True
        with self._cv:
            run = self._must(run_id)
            if run["nova"]:
                return self._public(run)
            run["nova"] = {
                "model_calls": model_calls,
                "delegated_to_planner": delegated,
                "budget_read_failed": body.get("budgetReadFailed") is True,
            }
            run["itinerary"] = itinerary
            self._event(run, "master_started", (
                f"AgentCore returned {model_calls} model usage record"
                f"{'' if model_calls == 1 else 's'} for this run."
            ), "bedrock")
            if delegated:
                self._event(run, "delegated_to_planner", (
                    "The runtime stream included the tool delegateToPlanner."
                ), "bedrock")
            self._event(run, "planner_itinerary", (
                "Planner text was returned for "
                f"{run['destination']}. No booking was created by that request."
            ), "bedrock")
            self._event(run, "booking_authorization_required", (
                "A Mastercard escrow still needs explicit approval. None has been requested."
            ), "local")
            self._cv.notify_all()
            return self._public(run)

    def prepare_booking(self, run_id: str, body: dict, snapshot: dict) -> tuple[int, dict]:
        seller = body.get("sellerId") if isinstance(body, dict) else None
        amount = body.get("amount") if isinstance(body, dict) else None
        if seller not in QUOTES:
            raise LiveError(400, "seller_unsupported")
        quote = _QUOTE_TEXT[seller]
        if amount != quote:
            raise LiveError(400, "quote_mismatch")
        with self._cv:
            run = self._must(run_id)
            if run["escrow"]:
                raise LiveError(409, "escrow_exists")
            if run.get("approving"):
                raise LiveError(409, "approval_in_progress")
            refusal = _quote_refusal(run, seller, quote, snapshot)
            if refusal:
                self._event(run, "escrow_rejected", (
                    f"Refused before any payment call: {refusal}."
                ), "local_check")
                self._cv.notify_all()
                return 409, {"error": refusal, "run": self._public(run), "mutated": False}
            budget = _public_budget(snapshot.get("budget") or {})
            run["budget_before"] = budget
            run["gate"] = {
                "seller_id": seller,
                "amount": quote,
                "status": "awaiting_approval",
            }
            self._event(run, "booking_authorization_required", (
                f"{seller} quote {quote} RLUSD passed the server checks. "
                f"Mode {budget.get('mode')}, live {budget.get('live')}, badge {budget.get('badge')}. "
                f"Remaining {budget.get('remaining')} RLUSD. "
                "The escrow has not been created."
            ), "mastercard")
            self._cv.notify_all()
            return 200, {"run": self._public(run), "mutated": False}

    def approve_booking(self, run_id: str, body: dict, client: MastercardClient) -> tuple[int, dict]:
        if not isinstance(body, dict) or body.get("confirm") != "approve-mock-escrow":
            raise LiveError(400, "approval_required")
        seller = body.get("sellerId")
        amount = body.get("amount")
        with self._cv:
            run = self._must(run_id)
            if run["escrow"]:
                return 200, {"run": self._public(run), "mutated": False}
            if run.get("approving"):
                raise LiveError(409, "approval_in_progress")
            gate = run["gate"] or {}
            if gate.get("status") != "awaiting_approval" or gate.get("seller_id") != seller or gate.get("amount") != amount:
                raise LiveError(409, "approval_required")
            run["approving"] = True
        try:
            return self._approve_locked_quote(run_id, seller, amount, client)
        finally:
            with self._cv:
                current = self._runs.get(run_id)
                if current is not None:
                    current["approving"] = False

    def _approve_locked_quote(self, run_id: str, seller: object, amount: object, client: MastercardClient) -> tuple[int, dict]:
        try:
            health = client.get_health()
            budget = client.get_budget()
        except (PaymentError, Exception) as exc:
            code = getattr(exc, "code", "unreachable")
            with self._cv:
                run = self._must(run_id)
                self._event(run, "escrow_rejected", f"Payment read failed ({code}). No escrow was created.", "mastercard")
                self._cv.notify_all()
                return 502, {"error": code, "run": self._public(run), "mutated": False}
        snapshot = {"configured": True, "halted": False, "health": health, "budget": budget}
        with self._cv:
            run = self._must(run_id)
            refusal = _quote_refusal(run, str(seller), str(amount), snapshot)
            if refusal:
                self._event(run, "escrow_rejected", f"Refused before any payment call: {refusal}.", "local_check")
                self._cv.notify_all()
                return 409, {"error": refusal, "run": self._public(run), "mutated": False}
            run["budget_before"] = _public_budget(budget)
        self._event_locked(run_id, "mastercard_escrow_requested", (
            f"POST /escrows seller {seller} amount {amount} RLUSD."
        ), "mastercard")
        try:
            created = client.create_escrow(str(seller), str(amount), 600)
        except PaymentError as exc:
            self._event_locked(run_id, "escrow_rejected", (
                f"Mastercard refused the escrow ({exc.code}). No second attempt was made."
            ), "mastercard")
            with self._cv:
                return 409, {"error": exc.code, "run": self._public(self._must(run_id)), "mutated": False}
        after = None
        try:
            after = _public_budget(client.get_budget())
        except (PaymentError, Exception):
            after = None
        with self._cv:
            run = self._must(run_id)
            if run["escrow"]:
                return 200, {"run": self._public(run), "mutated": False}
            public_escrow = _public_escrow(created)
            run["escrow"] = public_escrow
            run["budget_after"] = after
            run["gate"]["status"] = "approved"
            status = public_escrow.get("status")
            if status == "locked" and public_escrow.get("badge") == "MOCK" and public_escrow.get("live") is False:
                self._event(run, "escrow_confirmed", (
                    f"Escrow {public_escrow.get('escrowId')} locked for {seller} at {amount} RLUSD. "
                    f"Remaining {None if after is None else after.get('remaining')} RLUSD. "
                    "MOCK lock only. Nothing was released or refunded."
                ), "mastercard")
                self._event(run, "trip_status", (
                    f"{run['destination']} has one MOCK escrow. Final status is locked."
                ), "mastercard")
                self._cv.notify_all()
                return 200, {"run": self._public(run), "mutated": True}
            self._event(run, "escrow_rejected", (
                f"Escrow {public_escrow.get('escrowId')} returned status {status}. "
                "It was not released and it was not retried."
            ), "mastercard")
            self._cv.notify_all()
            return 409, {"error": "unexpected_escrow_state", "run": self._public(run), "mutated": True}

    def simulate(self, run_id: str, kind: str) -> dict:
        if kind == "rain":
            detail = _simulate_rain()
        elif kind == "overcharge":
            detail = _simulate_overcharge()
        elif kind == "timeout":
            detail = _simulate_timeout()
        elif kind == "rebook":
            detail = _simulate_rebook()
        else:
            raise LiveError(404, "not_found")
        with self._cv:
            run = self._must(run_id)
            destination = run["destination"]
            detail["destination_unchanged"] = destination
            detail["label"] = "OFFLINE SIMULATION"
            run["simulations"][kind] = detail
            if kind == "rebook":
                hotel = run["hotel"] or "the hotel"
                self._event(run, "mastercard_escrow_requested", (
                    f"OFFLINE SIMULATION. Booking held {hotel} at 4 RLUSD on the in-process fixture. "
                    "The live Mastercard server was not called."
                ), "offline_simulation")
                self._event(run, "escrow_rejected", (
                    f"{hotel} submitted a bill of 5 RLUSD. The release was refused. "
                    f"Escrow {detail.get('refused_escrow_id')} is {detail.get('refused_status')}. "
                    "txHash null. Nothing was signed."
                ), "offline_simulation")
                self._event(run, "recovery_invoked", (
                    "The refused hold is not reserved and not spent, so the 4 RLUSD is back in the remaining budget. "
                    "No refund was sent to Mastercard, and this is not an on-chain refund."
                ), "offline_simulation")
                label = "RECOVERY — VERIFIED" if detail.get("verified") else "RECOVERY — ESCALATED"
                run["recovery"] = "VERIFIED" if detail.get("verified") else "ESCALATED"
                self._event(run, "recovery_decision", (
                    f"{label}. Recovery booked an alternative tour at 3 RLUSD instead. "
                    f"Escrow {detail.get('alternative_escrow_id')} is {detail.get('alternative_status')}, "
                    "badge MOCK, txHash null."
                ), "offline_simulation")
                self._event(run, "trip_status", (
                    f"{destination} is unchanged. {hotel} was not reserved. "
                    "The alternative is an offline MOCK delivery."
                ), "offline_simulation")
                self._cv.notify_all()
                return self._public(run)
            if kind == "rain":
                self._event(run, "monitoring_detected", (
                    "DEMO INJECTION — SIMULATED. Scripted rain was applied to the offline outdoor fixture. "
                    f"{destination} was not changed. Mastercard was not called."
                ), "offline_simulation")
            elif kind == "overcharge":
                self._event(run, "monitoring_detected", (
                    "OFFLINE SIMULATION. A final bill above the locked quote was submitted to the in-process fake. "
                    "The live Mastercard server was not called."
                ), "offline_simulation")
            else:
                self._event(run, "monitoring_detected", (
                    "OFFLINE SIMULATION. The first release returned an unconfirmed payment. "
                    "The live Mastercard server was not called."
                ), "offline_simulation")
            self._event(run, "recovery_invoked", (
                "The deterministic recovery policy ran in this process. "
                "This was not a Bedrock Recovery Agent call."
            ), "offline_simulation")
            label = "RECOVERY — VERIFIED" if detail.get("verified") else "RECOVERY — ESCALATED"
            run["recovery"] = "VERIFIED" if detail.get("verified") else "ESCALATED"
            self._event(run, "recovery_decision", f"{label}. {detail.get('summary')}", "offline_simulation")
            self._event(run, "trip_status", (
                f"{destination} is unchanged. {label}. "
                "No on-chain refund was simulated."
            ), "offline_simulation")
            self._cv.notify_all()
            return self._public(run)

    def _must(self, run_id: str) -> dict:
        if not isinstance(run_id, str) or not _RUN_ID.match(run_id):
            raise LiveError(404, "run_not_found")
        run = self._runs.get(run_id)
        if run is None:
            raise LiveError(404, "run_not_found")
        return run

    def _event(self, run: dict, step: str, message: str, evidence: str) -> None:
        run["events"].append({
            "event_id": new_id("evt"),
            "run_id": run["run_id"],
            "step": step,
            "message": message,
            "evidence": evidence,
            "at": utcnow().isoformat(),
        })

    def _event_locked(self, run_id: str, step: str, message: str, evidence: str) -> None:
        with self._cv:
            run = self._must(run_id)
            self._event(run, step, message, evidence)
            self._cv.notify_all()

    def _public(self, run: dict) -> dict:
        recovery = run["recovery"]
        if recovery == "VERIFIED":
            recovery_label = "RECOVERY — VERIFIED"
        elif recovery == "ESCALATED":
            recovery_label = "RECOVERY — ESCALATED"
        else:
            recovery_label = "RECOVERY — waiting"
        return {
            "run_id": run["run_id"],
            "destination": run["destination"],
            "start_date": run["start_date"],
            "end_date": run["end_date"],
            "travelers": run["travelers"],
            "preferences": run["preferences"],
            "budget_rlusd": run["budget_rlusd"],
            "hotel": run["hotel"],
            "attractions": list(run["attractions"]),
            "itinerary": run["itinerary"],
            "nova": run["nova"],
            "gate": run["gate"],
            "escrow": run["escrow"],
            "budget_before": run["budget_before"],
            "budget_after": run["budget_after"],
            "simulations": run["simulations"],
            "events": list(run["events"]),
            "labels": {
                "bedrock": "BEDROCK AI — CLOUD",
                "mastercard": "MASTERCARD API — MOCK",
                "injection": "DEMO INJECTION — SIMULATED",
                "recovery": recovery_label,
            },
            "bedrock_invoked": run["nova"] is not None,
            "mastercard_mutated": run["escrow"] is not None,
            "quotes": dict(_QUOTE_TEXT),
        }


def remote_payment_client() -> MastercardClient:
    """Build the real adapter. Callers must already have an explicit approval."""
    load_local_env()
    config = load_config()
    if not config.payment_token or not config.payment_url or config.payment_url == DEFAULT_PAYMENT_URL:
        raise LiveError(409, "payment_not_configured")
    return MastercardClient(config, transport=UrllibTransport())


def _trip_input(body: dict) -> dict:
    if not isinstance(body, dict):
        raise LiveError(400, "invalid_json")
    destination = _text(body.get("destination"), 80)
    if not destination:
        raise LiveError(400, "destination_required")
    start = _iso_date(body.get("startDate"))
    end = _iso_date(body.get("endDate"))
    if not start or not end or end < start:
        raise LiveError(400, "dates_required")
    travelers = body.get("travelers")
    if not isinstance(travelers, int) or isinstance(travelers, bool) or not 1 <= travelers <= 8:
        raise LiveError(400, "travelers_required")
    budget = _money(body.get("budgetRlusd"))
    if budget is None or budget <= 0 or budget > Decimal("10000"):
        raise LiveError(400, "budget_required")
    preferences = _text(body.get("preferences"), 240)
    hotel = _text(body.get("hotel"), 120)
    attractions = body.get("attractions")
    names: list[str] = []
    if isinstance(attractions, list):
        for item in attractions[:12]:
            name = _text(item, 120)
            if name:
                names.append(name)
    return {
        "destination": destination,
        "start_date": start,
        "end_date": end,
        "travelers": travelers,
        "preferences": preferences,
        "budget_rlusd": format(budget, "f"),
        "hotel": hotel,
        "attractions": names,
    }


def _quote_refusal(run: dict, seller: str, quote: str, snapshot: dict) -> Optional[str]:
    if not isinstance(snapshot, dict) or not snapshot.get("configured"):
        return "payment_not_configured"
    if snapshot.get("halted") or snapshot.get("error"):
        return "not_mock"
    health = snapshot.get("health") if isinstance(snapshot.get("health"), dict) else {}
    if health.get("mode") != "mock" or health.get("live") is not False or health.get("badge") != "MOCK":
        return "not_mock"
    budget = snapshot.get("budget") if isinstance(snapshot.get("budget"), dict) else None
    if not isinstance(budget, dict):
        return "budget_unreadable"
    if budget.get("mode") != "mock" or budget.get("live") is not False or budget.get("badge") != "MOCK":
        return "not_mock"
    if budget.get("killed") is True or budget.get("drift") is not None:
        return "budget_unsafe"
    remaining = _money(budget.get("remaining"))
    traveler = _money(run.get("budget_rlusd"))
    quoted = _money(quote)
    if remaining is None or traveler is None or quoted is None:
        return "budget_unreadable"
    if quoted > traveler:
        return "over_traveler_budget"
    if quoted > remaining:
        return "over_budget"
    if seller not in QUOTES or quote != _QUOTE_TEXT[seller]:
        return "seller_unsupported"
    return None


def _simulate_rain() -> dict:
    from .httpapi import Desk
    desk = Desk()
    desk.plan("traveler_ada")
    view = desk.rain("traveler_ada")
    summary = view["summary"]
    verified = summary.get("resolution") == "resolved" and summary.get("delivered") == 1 and summary.get("refunded") == 1
    return {
        "kind": "rain",
        "verified": verified,
        "summary": (
            f"Indoor replacement additional cost {summary.get('additional_cost')} RLUSD. "
            f"Delivered {summary.get('delivered')}, refunded {summary.get('refunded')}. "
            "The fixture is not the remote hotel escrow."
        ),
        "additional_cost": summary.get("additional_cost"),
        "delivered": summary.get("delivered"),
        "refunded": summary.get("refunded"),
        "resolution": summary.get("resolution"),
    }


def _simulate_overcharge() -> dict:
    from .cli import _build_orchestrator
    orch, server = _build_orchestrator(use_fake=True)
    orch.create_traveler("traveler_ada", "Ada Lovelace")
    trip = orch.create_trip("traveler_ada", title="Quote check", destination="offline-fixture", budget_rlusd="19")
    activity = Activity(
        activity_id=new_id("act"), trip_id=trip.trip_id, title="Hotel quote",
        activity_type=ActivityType.HOTEL, seller_id="hotel", amount="4",
    )
    orch.store.save("activity", activity)
    locked = orch.lock_activity(trip.trip_id, activity.activity_id, "hotel", "4", deadline_seconds=600)
    escrow_id = locked["escrow_id"]
    refused = False
    try:
        orch.booker(trip.trip_id).deliver(locked["booking_id"], final_bill="5")
    except PaymentError as exc:
        refused = exc.code == "overcharged"
    fresh = orch.client.get_status(escrow_id)
    paths = [item["path"] for item in server.request_log]
    clean = _no_admin(paths) and len(server.escrows) == 1 and fresh.get("escrowId") == escrow_id
    verified = refused and clean and fresh.get("status") == "overcharged" and fresh.get("txHash") is None
    return {
        "kind": "overcharge",
        "verified": verified,
        "summary": (
            f"Escrow {escrow_id} refused final bill 5 against lock 4. "
            f"Status {fresh.get('status')}. Same escrow only. txHash null."
        ),
        "escrow_id": escrow_id,
        "status": fresh.get("status"),
        "tx_hash": fresh.get("txHash"),
        "escrow_count": len(server.escrows),
    }


def _simulate_rebook() -> dict:
    """Hotel bill above the lock is refused, the hold is not spent, then a tour is delivered.

    The in-process fake refuses refunds of an overcharged lock. The budget effect
    is that the refused amount is neither reserved nor spent. Nothing here calls
    the live Mastercard server or signs a transaction.
    """
    from .cli import _build_orchestrator
    orch, server = _build_orchestrator(use_fake=True)
    orch.create_traveler("traveler_ada", "Ada Lovelace")
    trip = orch.create_trip("traveler_ada", title="Hotel refusal", destination="offline-fixture", budget_rlusd="19")
    hotel = Activity(
        activity_id=new_id("act"), trip_id=trip.trip_id, title="Hotel quote",
        activity_type=ActivityType.HOTEL, seller_id="hotel", amount="4",
    )
    orch.store.save("activity", hotel)
    locked = orch.lock_activity(trip.trip_id, hotel.activity_id, "hotel", "4", deadline_seconds=600)
    refused_id = locked["escrow_id"]
    refused = False
    try:
        orch.booker(trip.trip_id).deliver(locked["booking_id"], final_bill="5")
    except PaymentError as exc:
        refused = exc.code == "overcharged"
    fresh = orch.client.get_status(refused_id)
    held = orch.client.get_budget()
    freed = _money(held.get("reserved")) == 0 and _money(held.get("spent")) == 0
    tour = Activity(
        activity_id=new_id("act"), trip_id=trip.trip_id, title="Alternative tour",
        activity_type=ActivityType.INDOOR_TOUR, seller_id="tour", amount="3",
    )
    orch.store.save("activity", tour)
    alternative = orch.lock_activity(trip.trip_id, tour.activity_id, "tour", "3", deadline_seconds=600)
    orch.booker(trip.trip_id).deliver(alternative["booking_id"])
    booked = orch.client.get_status(alternative["escrow_id"])
    paths = [item["path"] for item in server.request_log]
    verified = (
        refused and freed and _no_admin(paths) and len(server.escrows) == 2
        and fresh.get("escrowId") == refused_id
        and fresh.get("status") == "overcharged"
        and fresh.get("badge") == "MOCK"
        and fresh.get("live") is False
        and fresh.get("txHash") is None
        and booked.get("status") == "delivered"
        and booked.get("sellerId") == "tour"
        and booked.get("amount") == "3"
        and booked.get("badge") == "MOCK"
        and booked.get("live") is False
        and booked.get("txHash") is None
    )
    return {
        "kind": "rebook",
        "verified": verified,
        "summary": (
            f"Hotel escrow {refused_id} refused bill 5 against lock 4. "
            f"Status {fresh.get('status')}. The hold is not spent. "
            f"Alternative {alternative['escrow_id']} is {booked.get('status')}. txHash null."
        ),
        "refused_escrow_id": refused_id,
        "refused_status": fresh.get("status"),
        "alternative_escrow_id": alternative["escrow_id"],
        "alternative_status": booked.get("status"),
        "tx_hash": fresh.get("txHash"),
        "escrow_count": len(server.escrows),
    }


def _simulate_timeout() -> dict:
    from .cli import _build_orchestrator
    orch, server = _build_orchestrator(use_fake=True)
    orch.create_traveler("traveler_ada", "Ada Lovelace")
    trip = orch.create_trip("traveler_ada", title="Confirmation check", destination="offline-fixture", budget_rlusd="19")
    activity = Activity(
        activity_id=new_id("act"), trip_id=trip.trip_id, title="Cab quote",
        activity_type=ActivityType.TRANSPORT, seller_id="cab", amount="2",
    )
    orch.store.save("activity", activity)
    locked = orch.lock_activity(trip.trip_id, activity.activity_id, "cab", "2", deadline_seconds=600)
    server.next_release_outcome = "redeem_unconfirmed"
    uncertain = False
    try:
        orch.booker(trip.trip_id).deliver(locked["booking_id"])
    except PaymentError as exc:
        uncertain = exc.code == "redeem_unconfirmed"
    before = len(server.escrows)
    incident = Incident(
        incident_id=new_id("inc"), trip_id=trip.trip_id,
        incident_type=IncidentType.PAYMENT_CONFIRMATION_FAILURE,
        affected_activity_id=activity.activity_id, affected_booking_id=locked["booking_id"],
        details={"reason": "redeem_unconfirmed"}, status=IncidentStatus.OPEN,
    )
    orch.store.save("incident", incident)
    orch.handle_incident(incident.incident_id)
    fresh = orch.client.get_status(locked["escrow_id"])
    resolved = orch.store.get("incident", incident.incident_id).status.value == "resolved"
    paths = [item["path"] for item in server.request_log]
    verified = (
        uncertain and resolved and len(server.escrows) == before
        and fresh.get("escrowId") == locked["escrow_id"]
        and fresh.get("badge") == "MOCK" and fresh.get("txHash") is None
        and fresh.get("live") is False and _no_admin(paths)
    )
    return {
        "kind": "timeout",
        "verified": verified,
        "summary": (
            f"Escrow {locked['escrow_id']} was unconfirmed, then reconciled without a second escrow. "
            f"Status {fresh.get('status')}, badge {fresh.get('badge')}, txHash null. "
            "This is not an on-chain refund."
        ),
        "escrow_id": locked["escrow_id"],
        "status": fresh.get("status"),
        "badge": fresh.get("badge"),
        "tx_hash": fresh.get("txHash"),
        "new_escrows": len(server.escrows) - before,
    }


def _no_admin(paths: list[str]) -> bool:
    return not any(any(token in path for token in _FORBIDDEN_LOG) for path in paths)


def _public_budget(body: dict) -> dict:
    keys = ("currency", "mode", "live", "badge", "total", "remaining", "reserved", "spent", "refundedTotal", "killed", "drift")
    return {key: body.get(key) for key in keys}


def _public_escrow(body: dict) -> dict:
    keys = ("escrowId", "sellerId", "amount", "status", "badge", "live", "mode", "txHash", "reason")
    out = {key: body.get(key) for key in keys}
    out["receipt_url"] = None
    return out


def _text(value: Any, limit: int) -> str:
    if not isinstance(value, str):
        return ""
    return re.sub(r"[\u0000-\u001F\u007F]", " ", value).strip()[:limit]


def _iso_date(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not _DATE.match(value):
        return None
    try:
        datetime.strptime(value, "%Y-%m-%d")
    except ValueError:
        return None
    return value


def _money(value: Any) -> Optional[Decimal]:
    if isinstance(value, bool) or not isinstance(value, (str, int, Decimal)):
        return None
    text = format(value, "f") if isinstance(value, Decimal) else str(value).strip()
    if not re.fullmatch(r"(?:0|[1-9]\d*)(?:\.\d{1,2})?", text):
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None
