"""The Swanavi orchestrator.

Wires the deterministic monitoring engine to the Master Agent and the Recovery
policy. Runs in two modes:

* **deterministic** (default for local, credential-free runs and the demo): the
  Master Agent routes incidents by type and risk using code, not an LLM. This is
  fully reproducible and needs no AWS credentials.
* **strands** (when Bedrock is configured): the Master Agent uses a Strands
  ``Agent`` with the safe payment/discovery tools; safety invariants still live
  in the deterministic core, so the LLM only decides routing and explanation.

Either way, the monitoring engine, booker and recovery policy are the same
deterministic objects — the LLM never bypasses payment rules, locks, or the
no-duplicate-escrow invariant.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Callable, Optional

from .agents.boundaries import AuthorizationScope, can_agent_act, check_authorization_scope
from .booking.booker import Booker
from .config import SwanaviConfig
from .domain.enums import (
    AgentRole, ApprovalStatus, IncidentStatus, IncidentType, RiskLevel,
)
from .domain.models import (
    AuditEvent, Incident, TimelineEntry, Traveler, Trip, new_id, utcnow,
)
from .monitoring.engine import MonitoringEngine
from .monitoring.detectors import (
    NoWeatherSource, ScheduleDetector, TrafficDetector, WeatherDetector, WeatherSource,
)
from .payment.client import MastercardClient
from .payment.errors import PaymentError
from .recovery.policies import RecoveryPolicy
from .storage.store import SwanaviStore


@dataclass
class OrchestratorResult:
    """Outcome of handling an incident — surfaced to the UI/timeline."""
    incident_id: str
    action: str
    outcome: str            # resolved | escalated | awaiting_approval | no_action
    message: str
    new_booking_id: Optional[str] = None
    approval_request_id: Optional[str] = None
    additional_cost: Optional[str] = None
    evidence_kind: Optional[str] = None


class SwanaviOrchestrator:
    """Master Trip Agent orchestration over the deterministic core."""

    def __init__(
        self,
        client: MastercardClient,
        store: SwanaviStore,
        config: SwanaviConfig,
        *,
        weather_source: Optional[WeatherSource] = None,
        traffic_source: Optional[object] = None,
        strands_agent: Optional[object] = None,
    ):
        self.client = client
        self.store = store
        self.config = config
        self.weather_source = weather_source or NoWeatherSource()
        self.traffic_source = traffic_source
        self.strands_agent = strands_agent      # a Strands Agent, when configured
        self.engine = MonitoringEngine(store, config, handlers=[self._on_incident])
        self.engine.register_default_detectors(
            WeatherDetector(self.weather_source),
            TrafficDetector(self.traffic_source),
        )
        # per-trip recovery policies + authorization scopes
        self._policies: dict[str, RecoveryPolicy] = {}
        self._scopes: dict[str, AuthorizationScope] = {}

    # ------------------------------------------------------------------ trip setup
    def create_traveler(self, traveler_id: str, name: str = "") -> Traveler:
        t = Traveler(traveler_id=traveler_id, name=name)
        self.store.save("traveler", t)
        return t

    def create_trip(self, traveler_id: str, title: str = "", destination: str = "",
                    budget_rlusd: str = "19", **prefs) -> Trip:
        trip = Trip(trip_id=new_id("trip"), traveler_id=traveler_id, title=title,
                    destination=destination, budget_rlusd=budget_rlusd,
                    preferences=prefs)
        self.store.save("trip", trip)
        self._policies[trip.trip_id] = RecoveryPolicy(
            self.store, self.client, trip.trip_id,
            preauthorized_cost="0.10",
        )
        self._scopes[trip.trip_id] = AuthorizationScope(
            trip_id=trip.trip_id, traveler_id=traveler_id,
            budget_rlusd=Decimal(budget_rlusd),
        )
        return trip

    def scope_for(self, trip_id: str) -> AuthorizationScope:
        if trip_id not in self._scopes:
            raise KeyError(f"no authorization scope for trip {trip_id}")
        return self._scopes[trip_id]

    def policy_for(self, trip_id: str) -> RecoveryPolicy:
        if trip_id not in self._policies:
            self._policies[trip_id] = RecoveryPolicy(self.store, self.client, trip_id)
        return self._policies[trip_id]

    # ------------------------------------------------------------------ monitoring
    def run_monitoring_tick(self, trip_id: str, *, emit: bool = True) -> dict:
        return self.engine.run_tick(trip_id, emit=emit)

    # ------------------------------------------------------------------ master routing (deterministic)
    def _on_incident(self, incident: Incident) -> None:
        """The monitoring engine's handler: this is the Master Agent's wake-up.
        In deterministic mode we route by incident type + risk. In strands mode we
        could ask the LLM, but we always act through the recovery policy (which
        enforces the safety invariants)."""
        self._route_incident(incident)

    def _route_incident(self, incident: Incident) -> OrchestratorResult:
        scope = self._scopes.get(incident.trip_id)
        policy = self.policy_for(incident.trip_id)
        self._audit(incident.trip_id, AgentRole.MASTER, "incident.routed",
                    {"incident_id": incident.incident_id,
                     "type": incident.incident_type.value,
                     "risk": incident.risk_level.value})
        self._timeline(incident, "agent_delegated",
                       f"Master Agent delegated incident to Recovery Agent "
                       f"({incident.incident_type.value}, {incident.risk_level.value}).")

        # Severe weather / safety-first: always escalate.
        if incident.risk_level in (RiskLevel.HIGH, RiskLevel.CRITICAL) and \
           incident.incident_type == IncidentType.SEVERE_WEATHER:
            attempt = policy.handle(incident)
            return OrchestratorResult(incident.incident_id, "escalate_safety",
                                       attempt.outcome, "Severe weather escalated to human.")

        attempt = policy.handle(incident)
        outcome = attempt.outcome  # succeeded | failed | escalated

        if outcome == "succeeded":
            return OrchestratorResult(
                incident.incident_id, attempt.action, "resolved",
                "Recovery completed and verified.",
                new_booking_id=attempt.evidence.get("new_booking_id"),
                additional_cost=attempt.additional_cost,
                evidence_kind=attempt.evidence.get("evidence_kind"))
        if attempt.requires_approval:
            return OrchestratorResult(
                incident.incident_id, attempt.action, "awaiting_approval",
                "Recovery needs human approval.",
                approval_request_id=attempt.evidence.get("approval_id"),
                additional_cost=attempt.additional_cost)
        return OrchestratorResult(incident.incident_id, attempt.action, "escalated",
                                   attempt.evidence.get("reason", "Recovery failed; escalated."))

    def handle_incident(self, incident_id: str) -> OrchestratorResult:
        """Manually trigger handling of an existing incident (e.g. after an approval)."""
        incident = self.store.get("incident", incident_id)
        if not incident:
            raise KeyError(f"unknown incident {incident_id}")
        return self._route_incident(incident)

    # ------------------------------------------------------------------ approvals
    def request_approval(self, trip_id: str, incident_id: str, description: str,
                         proposed_cost: Optional[str] = None) -> str:
        req = self.policy_for(trip_id)._request_approval(
            self.store.get("incident", incident_id),
            Decimal(proposed_cost) if proposed_cost else None, None, description)
        return req.request_id

    def decide_approval(self, request_id: str, approved: bool,
                        decided_by: str = "human") -> dict:
        req = self.policy_for(self._trip_of(request_id)).decide_approval(
            request_id, approved, decided_by)
        return req.to_dict()

    # ------------------------------------------------------------------ booking passthrough
    def booker(self, trip_id: str) -> Booker:
        return self.policy_for(trip_id).booker

    def lock_activity(self, trip_id: str, activity_id: str, seller_id: str,
                       amount: str, deadline_seconds: int = 3600) -> dict:
        from .payment.client import UrllibTransport
        assert_seller_supported_safe(
            seller_id, remote=isinstance(self.client._transport, UrllibTransport))
        return self.booker(trip_id).lock(activity_id, seller_id, amount,
                                         deadline_seconds=deadline_seconds).to_dict()

    # ------------------------------------------------------------------ audit/timeline
    def _audit(self, trip_id, role, action, details):
        self.store.save("audit_event", AuditEvent(
            event_id=new_id("evt"), trip_id=trip_id, correlation_id=None,
            role=role, action=action, outcome="ok", details=details))

    def _timeline(self, incident: Incident, step: str, message: str,
                 evidence_kind: Optional[str] = None):
        self.store.save("timeline_entry", TimelineEntry(
            entry_id=new_id("tl"), trip_id=incident.trip_id,
            incident_id=incident.incident_id, step=step, message=message,
            evidence_kind=evidence_kind))

    def _trip_of(self, request_id: str) -> str:
        req = self.store.get("approval_request", request_id)
        if not req:
            raise KeyError(f"unknown approval request {request_id}")
        return req.trip_id

    # ------------------------------------------------------------------ views for UI
    def trip_dashboard(self, trip_id: str) -> dict:
        """The operational view the Trip Dashboard consumes."""
        trip = self.store.get("trip", trip_id)
        if not trip:
            raise KeyError(f"unknown trip {trip_id}")
        itinerary = (self.store.get("itinerary", trip.current_itinerary_id)
                     if trip.current_itinerary_id else None)
        bookings = self.store.list("booking", trip_id)
        incidents = self.store.list("incident", trip_id)
        approvals = [a for a in self.store.list("approval_request", trip_id)
                     if a.status == ApprovalStatus.PENDING]
        timeline = self.store.list("timeline_entry", trip_id)
        budget = self.booker(trip_id).refresh_budget().to_dict()
        return {
            "trip": trip.to_dict(),
            "current_itinerary": itinerary.to_dict() if itinerary else None,
            "bookings": [b.to_dict() for b in bookings],
            "incidents": [i.to_dict() for i in incidents],
            "pending_approvals": [a.to_dict() for a in approvals],
            "timeline": [t.to_dict() for t in timeline],
            "budget": budget,
            "trip_health": _health(incidents, bookings),
        }

    def agent_timeline(self, trip_id: str) -> list[dict]:
        return [t.to_dict() for t in self.store.list("timeline_entry", trip_id)]

    def recovery_panel(self, trip_id: str) -> list[dict]:
        rows = []
        for inc in self.store.list("incident", trip_id):
            attempts = [a.to_dict() for a in self.store.list("recovery_attempt")
                         if a.incident_id == inc.incident_id]
            rows.append({
                "incident": inc.to_dict(),
                "attempts": attempts,
                "approval": (self.store.get("approval_request", inc.approval_request_id).to_dict()
                              if inc.approval_request_id else None),
            })
        return rows


def _health(incidents, bookings) -> str:
    open_incidents = [i for i in incidents if i.status not in
                      (IncidentStatus.RESOLVED, IncidentStatus.DROPPED)]
    if any(i.risk_level == RiskLevel.CRITICAL for i in open_incidents):
        return "critical"
    if any(i.risk_level == RiskLevel.HIGH for i in open_incidents):
        return "at_risk"
    if open_incidents:
        return "monitoring"
    if any(b.status.value == "paying" for b in bookings):
        return "payment_pending"
    return "healthy"


def assert_seller_supported_safe(seller_id: str, *, remote: bool = False) -> None:
    from .agents.tools import assert_seller_supported
    assert_seller_supported(seller_id, remote=remote)
