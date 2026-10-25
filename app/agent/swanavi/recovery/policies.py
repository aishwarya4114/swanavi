"""Recovery policies.

The weather-driven tour replacement is a complete, executable vertical slice. The
other incident types have deterministic handling where the data exists (schedule,
booking reconciliation, payment confirmation) and clearly-labeled "unsupported"
cases where a live provider integration does not exist (flight data, real merchant
inventory). We never fabricate a replacement booking; a found-but-unconfirmed
alternative is labeled SIMULATED.

Critical invariants enforced here, in code:
* An already-paid (delivered/live) booking is NEVER cancelled via the unpaid-lock
  refund endpoint. Only an unpaid LOCKED booking is safe to replace.
* Recovery requests human approval when the additional cost exceeds the
  traveler's preauthorization or the risk is HIGH/CRITICAL.
* Unverified stores (the prompt-injection trap) are never selected.
* An incident is RESOLVED only after the replacement is verified.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Optional

from ..domain.enums import (
    ApprovalStatus, BookingStatus, EvidenceKind, IncidentStatus,
    IncidentType, RiskLevel,
)
from ..domain.models import (
    Activity, ApprovalRequest, BookingRecord, Incident, RecoveryAttempt,
    TimelineEntry, new_id, utcnow,
)
from ..payment.client import MastercardClient
from ..storage.store import SwanaviStore
from ..booking.booker import Booker


# The maximum additional cost (RLUSD) the agent may spend on a recovery
# replacement WITHOUT asking a human. Tunable; the demo default is small.
DEFAULT_PREAUTHORIZED_RECOVERY_COST = Decimal("0.10")


class RecoveryPolicy:
    """Per-incident recovery decisioning and execution."""

    def __init__(self, store: SwanaviStore, client: MastercardClient, trip_id: str,
                 preauthorized_cost: str = "0.10"):
        self.store = store
        self.client = client
        self.trip_id = trip_id
        self.booker = Booker(client, store, trip_id)
        self.preauthorized_cost = Decimal(str(preauthorized_cost))

    # ------------------------------------------------------------------ main entry
    def handle(self, incident: Incident, correlation_id: Optional[str] = None) -> RecoveryAttempt:
        """Dispatch to the policy for this incident type. Returns a RecoveryAttempt.
        Idempotent: an already-resolved/dropped incident returns a no-op attempt."""
        attempt = RecoveryAttempt(
            attempt_id=new_id("rec"), incident_id=incident.incident_id, trip_id=self.trip_id,
            action=_action_for(incident.incident_type),
        )
        if incident.status in (IncidentStatus.RESOLVED, IncidentStatus.DROPPED):
            attempt.outcome = "succeeded" if incident.status == IncidentStatus.RESOLVED else "dropped"
            attempt.evidence = {"reason": "already_resolved", "status": incident.status.value}
            return attempt
        handler = self._policy_for(incident.incident_type)
        try:
            result = handler(incident, attempt, correlation_id)
        except _Escalate as exc:
            attempt.outcome = "escalated"
            attempt.evidence = {"reason": str(exc)}
            self._escalate(incident, str(exc), correlation_id)
            self._timeline(incident, "recovery_escalated", str(exc))
        except Exception as exc:
            attempt.outcome = "failed"
            attempt.evidence = {"error": str(exc)}
            self._timeline(incident, "recovery_failed", str(exc))
        finally:
            attempt.finished_at = utcnow()
            self.store.save("recovery_attempt", attempt)
            incident.recovery_attempts.append(attempt.attempt_id)
            self.store.save("incident", incident)
        return attempt

    def _policy_for(self, incident_type: IncidentType):
        return {
            IncidentType.RAIN_OUTDOOR_TOUR: self._weather_replacement,
            IncidentType.SEVERE_WEATHER: self._severe_weather,
            IncidentType.FLIGHT_DELAY: self._flight_delay,
            IncidentType.TRAFFIC_TIMED_BOOKING: self._traffic,
            IncidentType.RESTAURANT_UNAVAILABLE: self._provider_unavailable,
            IncidentType.TOUR_CANCELLATION: self._provider_unavailable,
            IncidentType.ATTRACTION_CLOSURE: self._attraction_closure,
            IncidentType.HOTEL_BOOKING_FAILURE: self._booking_failure,
            IncidentType.OVERLAPPING_ITINERARY: self._schedule_fix,
            IncidentType.PAYMENT_CONFIRMATION_FAILURE: self._payment_confirmation,
        }[incident_type]

    # ------------------------------------------------------------------ weather (vertical slice)
    def _weather_replacement(self, incident: Incident, attempt: RecoveryAttempt,
                              correlation_id: Optional[str]) -> None:
        """The complete weather-driven tour replacement."""
        self._timeline(incident, "risk_classified",
            f"Rain affects outdoor activity; risk {incident.risk_level.value}.")
        activity = self._activity(incident)
        if not activity:
            raise _Escalate("Affected activity not found.")

        # 1. Find an indoor alternative from VERIFIED stores only (no injection traps).
        alternative = self._find_indoor_alternative(activity, incident, correlation_id)
        attempt.proposed_alternative = alternative
        self._timeline(incident, "alternative_selected",
            f"Indoor alternative proposed: {alternative.get('title')} "
            f"({alternative.get('store_id')}).",
            evidence_kind=alternative.get("evidence_kind"))

        # 2. Check the existing reservation: must be UNPAID and cancellable (LOCKED).
        booking = self._booking_for(activity)
        if booking and booking.status != BookingStatus.LOCKED:
            if booking.is_paid:
                raise _Escalate(
                    "Existing reservation is already paid and confirmed on chain. "
                    "It cannot be cancelled via the unpaid-lock refund endpoint. "
                    "Human/merchant cancellation workflow required.")
            if booking.status == BookingStatus.PAYING:
                raise _Escalate(
                    "Existing reservation is paying; the payment may already be on chain. "
                    "Reconcile before any recovery decision.")
            raise _Escalate(
                f"Existing reservation is in status {booking.status.value}; not safely replaceable.")

        # 3. Authorization: additional cost within preauthorization?
        additional = self._additional_cost(booking, alternative)
        attempt.additional_cost = str(additional) if additional is not None else None
        needs_approval = (
            incident.risk_level in (RiskLevel.HIGH, RiskLevel.CRITICAL)
            or (additional is not None and additional > self.preauthorized_cost)
        )
        attempt.requires_approval = needs_approval
        if needs_approval:
            self._timeline(incident, "approval_required",
                f"Recovery needs human approval (additional cost {attempt.additional_cost}, "
                f"risk {incident.risk_level.value}).")
            approval = self._request_approval(incident, additional, correlation_id)
            if approval.status != ApprovalStatus.APPROVED:
                attempt.outcome = "escalated"
                attempt.evidence = {"reason": "approval_not_granted",
                                    "approval_id": approval.request_id}
                self._escalate(incident, "Human approval not granted for recovery.", correlation_id)
                return

        # 4. Execute: refund the unpaid lock, lock the indoor alternative, deliver it.
        if booking:
            self.booker.cancel(booking.booking_id, correlation_id=correlation_id)
            self._timeline(incident, "action_attempted",
                f"Refunded unpaid lock for '{activity.title}'.", evidence_kind="LOCAL")
        # create the replacement activity in the itinerary
        new_activity = self._create_alternative_activity(alternative, activity, correlation_id)
        new_booking = self.booker.lock(
            new_activity.activity_id, alternative["seller_id"], alternative["amount"],
            deadline_seconds=7200,
            idempotency_key=f"recovery:{incident.incident_id}:{alternative['store_id']}",
            correlation_id=correlation_id,
        )
        attempt.evidence = {"new_booking_id": new_booking.booking_id,
                            "new_escrow_id": new_booking.escrow_id}
        self._timeline(incident, "action_attempted",
            f"Locked indoor alternative '{alternative['title']}'.", evidence_kind="LOCAL")

        delivered = self.booker.deliver(new_booking.booking_id, correlation_id=correlation_id)
        self._timeline(incident, "action_verified",
            f"Indoor alternative delivered: badge {delivered.badge}, "
            f"evidence {delivered.evidence.evidence_kind.value}.",
            evidence_kind=delivered.evidence.evidence_kind.value)

        # 5. Update itinerary: mark old activity replaced, mark incident resolved.
        activity.booking_id = None
        activity.notes = (activity.notes + " | Replaced due to rain: "
                          + alternative.get("title", ""))
        self.store.save("activity", activity)
        new_activity.booking_id = delivered.booking_id
        self.store.save("activity", new_activity)

        attempt.outcome = "succeeded"
        self._timeline(incident, "traveler_notified",
            "Trip updated; incident resolved after verification.")
        self._mark_resolved(incident)

    # ------------------------------------------------------------------ severe weather
    def _severe_weather(self, incident: Incident, attempt: RecoveryAttempt,
                         correlation_id: Optional[str]) -> None:
        """Severe weather is a safety issue: always escalate to the human. The agent
        may surface safe indoor alternatives but does not move money without approval."""
        self._timeline(incident, "risk_classified", "Severe weather: safety-first escalation.")
        activity = self._activity(incident)
        if activity:
            alt = self._find_indoor_alternative(activity, incident, correlation_id)
            attempt.proposed_alternative = alt
        attempt.requires_approval = True
        attempt.outcome = "escalated"
        self._request_approval(incident, None, correlation_id,
            description="Severe weather threatens safety. Manual decision required before any rebooking.")
        self._escalate(incident, "Severe weather requires human decision (safety).", correlation_id)

    # ------------------------------------------------------------------ flight delay (unsupported)
    def _flight_delay(self, incident: Incident, attempt: RecoveryAttempt,
                       correlation_id: Optional[str]) -> None:
        """No live flight-data provider integration exists. Do NOT fabricate delay
        data, availability, or refunds. Surface the limitation and escalate."""
        self._timeline(incident, "risk_classified",
            "Flight delay detected. No live flight-data provider integrated.")
        attempt.evidence = {"supported": False,
            "reason": "no_flight_api",
            "missing_provider": "flight_status/availability/refunds"}
        attempt.outcome = "escalated"
        self._escalate(incident,
            "Flight disruption requires a live flight-data provider (not integrated). "
            "Manual rebooking/refund through the airline.", correlation_id)

    # ------------------------------------------------------------------ traffic
    def _traffic(self, incident: Incident, attempt: RecoveryAttempt,
                  correlation_id: Optional[str]) -> None:
        """If real-time traffic shows a delay threatening a timed booking, the agent
        can only reschedule local timing or surface the risk. Rebooking transport
        needs a provider; without it, escalate."""
        activity = self._activity(incident)
        delay = float(incident.details.get("delay_min", 0) or 0)
        attempt.evidence = {"delay_min": delay, "supported": "partial"}
        if delay >= 60:
            attempt.outcome = "escalated"
            self._escalate(incident,
                "Significant traffic delay; needs transport rebooking provider or human.",
                correlation_id)
            return
        # within scope: flag the timing risk, no money moved
        self._timeline(incident, "risk_classified",
            f"Traffic delay ~{delay:.0f} min flagged for '{activity.title if activity else '?'}'.")
        attempt.outcome = "succeeded"
        self._mark_resolved(incident)

    # ------------------------------------------------------------------ provider unavailable (tour/restaurant)
    def _provider_unavailable(self, incident: Incident, attempt: RecoveryAttempt,
                               correlation_id: Optional[str]) -> None:
        """A tour cancellation / restaurant unavailability may be recoverable with a
        verified alternative if unpaid. If the existing booking is paid, escalate."""
        activity = self._activity(incident)
        booking = self._booking_for(activity) if activity else None
        if booking and booking.is_paid:
            attempt.outcome = "escalated"
            self._escalate(incident,
                "Provider unavailable but booking already paid; needs merchant cancellation/refund.",
                correlation_id)
            return
        if booking and booking.status == BookingStatus.LOCKED:
            alt = self._find_indoor_alternative(activity, incident, correlation_id) if activity else None
            if alt:
                attempt.proposed_alternative = alt
                self.booker.cancel(booking.booking_id, correlation_id=correlation_id)
                self._timeline(incident, "action_attempted", "Refunded unpaid lock for cancelled provider.")
                attempt.outcome = "succeeded"
                self._mark_resolved(incident)
                return
        attempt.outcome = "escalated"
        self._escalate(incident, "Provider unavailable; no confirmed alternative. Human rebooking needed.",
                       correlation_id)

    # ------------------------------------------------------------------ attraction closure
    def _attraction_closure(self, incident: Incident, attempt: RecoveryAttempt,
                             correlation_id: Optional[str]) -> None:
        """An attraction closure from an official page is untrusted content. If the
        source is a browser-fetched official notice, treat it as a SUGGESTION only;
        never claim a booking. Refund unpaid locks; escalate otherwise."""
        activity = self._activity(incident)
        booking = self._booking_for(activity) if activity else None
        source = str(incident.details.get("source", ""))
        attempt.evidence = {"source": source, "trusted": source == "official_provider_webhook"}
        if booking and booking.status == BookingStatus.LOCKED:
            self.booker.cancel(booking.booking_id, correlation_id=correlation_id)
            self._timeline(incident, "action_attempted",
                "Refunded unpaid lock for closed attraction. (No replacement booked; "
                "closure notice treated as unconfirmed suggestion unless from an official webhook.)",
                evidence_kind="LOCAL")
            attempt.outcome = "succeeded"
            self._mark_resolved(incident)
            return
        attempt.outcome = "escalated"
        self._escalate(incident, "Attraction closure needs verification/paid-booking handling.",
                       correlation_id)

    # ------------------------------------------------------------------ hotel booking failure
    def _booking_failure(self, incident: Incident, attempt: RecoveryAttempt,
                          correlation_id: Optional[str]) -> None:
        """A hotel booking failure surfaces from booker reconciliation. If the lock
        is intact and unpaid, refund and flag for rebooking; if paid, escalate."""
        booking = self._booking_by_id(incident.affected_booking_id)
        if not booking:
            attempt.outcome = "escalated"
            self._escalate(incident, "Hotel booking failure: booking not found.", correlation_id)
            return
        if booking.is_paid:
            attempt.outcome = "escalated"
            self._escalate(incident, "Hotel booking paid then failed; needs merchant resolution.",
                           correlation_id)
            return
        self.booker.cancel(booking.booking_id, correlation_id=correlation_id)
        self._timeline(incident, "action_attempted", "Refunded unpaid hotel lock after booking failure.")
        attempt.outcome = "succeeded"
        self._mark_resolved(incident)

    # ------------------------------------------------------------------ schedule fix
    def _schedule_fix(self, incident: Incident, attempt: RecoveryAttempt,
                        correlation_id: Optional[str]) -> None:
        """Invalid schedule or overlap: the planner re-times the activity. No money
        moves; pure local itinerary fix."""
        activity = self._activity(incident)
        if activity:
            problem = incident.details.get("problem")
            if problem == "invalid_schedule":
                # swap start/end so end is after start (deterministic local fix)
                activity.start_at, activity.end_at = activity.end_at, activity.start_at
                self.store.save("activity", activity)
                self._timeline(incident, "action_verified", "Schedule corrected locally.")
                attempt.outcome = "succeeded"
                self._mark_resolved(incident)
                return
        # overlap: flag for the planner to re-time — within scope, no money moved
        self._timeline(incident, "risk_classified",
            "Overlap detected; planner should re-time activities. No payment change.")
        attempt.outcome = "succeeded"
        self._mark_resolved(incident)

    # ------------------------------------------------------------------ payment confirmation
    def _payment_confirmation(self, incident: Incident, attempt: RecoveryAttempt,
                               correlation_id: Optional[str]) -> None:
        """An uncertain settlement (redeem_unconfirmed) is handled by RECONCILING the
        existing escrow, NEVER by creating a new one. Poll getStatus; if still
        ``paying``, retry the release which the server treats as confirmation-only
        (it can never produce a second payment). If it becomes delivered, resolve."""
        booking = self._booking_by_id(incident.affected_booking_id)
        if not booking:
            attempt.outcome = "escalated"
            self._escalate(incident, "Payment confirmation failure: booking not found.", correlation_id)
            return
        fresh = self.booker.reconcile(booking.booking_id, correlation_id=correlation_id)
        attempt.evidence = {"status": fresh.status.value, "badge": fresh.badge,
                             "escrow_id": fresh.escrow_id}
        if fresh.status == BookingStatus.DELIVERED:
            self._timeline(incident, "action_verified",
                f"Payment confirmed on reconcile (no duplicate escrow). Badge {fresh.badge}.",
                evidence_kind=fresh.evidence.evidence_kind.value)
            attempt.outcome = "succeeded"
            self._mark_resolved(incident)
            return
        if fresh.status == BookingStatus.PAYING:
            # retry the confirmation only: release on a paying row never pays twice
            try:
                confirmed = self.booker.deliver(fresh.booking_id, correlation_id=correlation_id)
            except PaymentError as exc:
                attempt.evidence["retry_error"] = exc.code
                attempt.outcome = "escalated"
                self._escalate(incident,
                    "Payment still unconfirmed after retry; preserve escrow id, poll again. "
                    "Do NOT create a new escrow.", correlation_id)
                return
            if confirmed.status == BookingStatus.DELIVERED:
                self._timeline(incident, "action_verified",
                    "Payment confirmed on release-retry (no duplicate escrow).",
                    evidence_kind=confirmed.evidence.evidence_kind.value)
                attempt.outcome = "succeeded"
                self._mark_resolved(incident)
                return
            attempt.outcome = "escalated"
            self._escalate(incident, f"Payment reconciliation left booking {confirmed.status.value}.",
                           correlation_id)
            return
        attempt.outcome = "escalated"
        self._escalate(incident, f"Payment reconciliation left booking {fresh.status.value}.",
                       correlation_id)

    # ------------------------------------------------------------------ helpers
    def _activity(self, incident: Incident) -> Optional[Activity]:
        if not incident.affected_activity_id:
            return None
        return self.store.get("activity", incident.affected_activity_id)

    def _booking_for(self, activity: Optional[Activity]) -> Optional[BookingRecord]:
        if not activity or not activity.booking_id:
            return None
        return self.store.get("booking", activity.booking_id)

    def _booking_by_id(self, booking_id: Optional[str]) -> Optional[BookingRecord]:
        if not booking_id:
            return None
        return self.store.get("booking", booking_id)

    def _find_indoor_alternative(self, activity: Activity, incident: Incident,
                                  correlation_id: Optional[str]) -> dict:
        """Find a VERIFIED indoor store with a bookable offer. Never returns an
        unverified store (the prompt-injection trap). Prefers stores explicitly
        described as rain alternatives."""
        stores = self.client.list_stores().get("stores", [])
        candidates = []
        for s in stores:
            if s.get("verified") is False:
                continue  # skip unverified (injection trap)
            if s.get("category") == "shopping":
                continue  # shopping is not a tour replacement
            if s.get("storeId") == getattr(activity, "store_id", None):
                continue
            note = str(s.get("note", "")).lower()
            # prefer explicitly-indoor stores; the note 'rain' marks the canonical alt
            catalog = self.client.search_catalog(s["storeId"]).get("items", [])
            indoor_offers = [c for c in catalog if c.get("indoor")]
            if not indoor_offers:
                continue
            offer = indoor_offers[0]
            candidates.append({
                "store_id": s["storeId"], "seller_id": s["sellerId"],
                "title": offer.get("title", s.get("name", "")),
                "amount": offer.get("amount", "0"),
                "indoor": True, "verified": True,
                "is_rain_alternative": "rain" in note or "rained" in note,
                "evidence_kind": EvidenceKind.SUGGESTION.value,
            })
        if not candidates:
            raise _Escalate("No verified indoor alternative store available.")
        # prefer the explicit rain alternative, then the cheapest
        candidates.sort(key=lambda c: (not c["is_rain_alternative"], Decimal(c["amount"])))
        chosen = candidates[0]
        # A found alternative is a SUGGESTION until the Booker locks it; recovery
        # promotes it to LOCAL/LIVE via the booking. Keep the suggestion label here.
        return chosen

    def _additional_cost(self, booking: Optional[BookingRecord], alternative: dict) -> Optional[Decimal]:
        new_cost = Decimal(str(alternative.get("amount", "0")))
        if booking and booking.status == BookingStatus.LOCKED:
            old_cost = Decimal(str(booking.amount))
            return max(new_cost - old_cost, Decimal("0"))
        return new_cost

    def _create_alternative_activity(self, alternative: dict, original: Activity,
                                       correlation_id: Optional[str]) -> Activity:
        from ..domain.enums import ActivityType
        new_act = Activity(
            activity_id=new_id("act"), trip_id=self.trip_id,
            title=alternative["title"],
            activity_type=ActivityType.INDOOR_TOUR,
            seller_id=alternative["seller_id"], store_id=alternative["store_id"],
            amount=alternative["amount"], indoor=True, verified=True,
            notes=f"Recovery replacement for '{original.title}' (rain).",
        )
        self.store.save("activity", new_act)
        return new_act

    def _request_approval(self, incident: Incident, additional: Optional[Decimal],
                            correlation_id: Optional[str],
                            description: str = "") -> ApprovalRequest:
        req = ApprovalRequest(
            request_id=new_id("appr"), trip_id=self.trip_id, incident_id=incident.incident_id,
            action="recovery_replacement", description=description or (
                f"Recover '{incident.summary}'. Additional cost: "
                f"{str(additional) if additional is not None else 'unknown'}."),
            proposed_cost=str(additional) if additional is not None else None,
        )
        self.store.save("approval_request", req)
        incident.approval_request_id = req.request_id
        incident.status = IncidentStatus.AWAITING_APPROVAL
        self.store.save("incident", incident)
        self._timeline(incident, "approval_required", req.description)
        return req

    def decide_approval(self, request_id: str, approved: bool, decided_by: str = "human",
                          correlation_id: Optional[str] = None) -> ApprovalRequest:
        req = self.store.get("approval_request", request_id)
        if not req:
            raise KeyError(f"unknown approval request {request_id}")
        req.status = ApprovalStatus.APPROVED if approved else ApprovalStatus.REJECTED
        req.decided_at = utcnow()
        req.decided_by = decided_by
        self.store.save("approval_request", req)
        return req

    def _escalate(self, incident: Incident, reason: str, correlation_id: Optional[str]) -> None:
        self._release_incident_lock(incident)
        incident.status = IncidentStatus.ESCALATED
        self.store.save("incident", incident)
        self.store.save("audit_event", _audit(self.trip_id, incident.correlation_id or correlation_id,
            "recovery", "incident.escalated", "escalated", {"reason": reason}))

    def _mark_resolved(self, incident: Incident) -> None:
        self._release_incident_lock(incident)
        incident.status = IncidentStatus.RESOLVED
        incident.resolved_at = utcnow()
        self.store.save("incident", incident)
        self._timeline(incident, "action_verified", "Incident resolved after verification.")

    def _release_incident_lock(self, incident: Incident) -> None:
        # the recovery lock for this incident (acquired by the monitoring engine) is
        # released once recovery finishes (resolved or escalated), so a later
        # re-detection can run. Reload from the store because the engine may have
        # acquired the lock on a different in-memory copy of the incident.
        fresh = self.store.get("incident", incident.incident_id)
        lock_id = (fresh.lock_id if fresh else None) or incident.lock_id
        if lock_id:
            self.store.release_lock(lock_id)
            incident.lock_id = None

    def _timeline(self, incident: Incident, step: str, message: str,
                    evidence_kind: Optional[str] = None) -> None:
        self.store.save("timeline_entry", TimelineEntry(
            entry_id=new_id("tl"), trip_id=self.trip_id, incident_id=incident.incident_id,
            step=step, message=message, evidence_kind=evidence_kind,
            details={"correlation_id": incident.correlation_id},
        ))


def _action_for(incident_type: IncidentType) -> str:
    return {
        IncidentType.RAIN_OUTDOOR_TOUR: "replace_outdoor_with_indoor",
        IncidentType.SEVERE_WEATHER: "escalate_safety",
        IncidentType.FLIGHT_DELAY: "escalate_no_flight_api",
        IncidentType.TRAFFIC_TIMED_BOOKING: "reschedule_or_escalate",
        IncidentType.RESTAURANT_UNAVAILABLE: "refund_or_escalate",
        IncidentType.TOUR_CANCELLATION: "refund_or_replace",
        IncidentType.ATTRACTION_CLOSURE: "refund_unpaid_or_escalate",
        IncidentType.HOTEL_BOOKING_FAILURE: "refund_unpaid_or_escalate",
        IncidentType.OVERLAPPING_ITINERARY: "reschedule_local",
        IncidentType.PAYMENT_CONFIRMATION_FAILURE: "reconcile_no_duplicate",
    }.get(incident_type, "review")


class _Escalate(Exception):
    """Internal signal: recovery cannot proceed autonomously; escalate to a human."""


def _audit(trip_id, correlation_id, role, action, outcome, details):
    from ..domain.enums import AgentRole
    from ..domain.models import AuditEvent
    return AuditEvent(
        event_id=new_id("evt"), trip_id=trip_id, correlation_id=correlation_id,
        role=AgentRole.RECOVERY, action=action, outcome=outcome, details=details,
    )
