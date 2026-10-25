"""Typed domain models (stdlib dataclasses).

These are the durable-state schemas for travelers, trips, itineraries, bookings,
payment evidence, monitoring observations, incidents, recovery attempts, human
approval requests, execution locks, and audit events. They are intentionally
framework-free and serialise to/from JSON so the SQLite/in-memory store and the
(eventual) DynamoDB implementation share one schema.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Optional
from uuid import uuid4

from .enums import (
    ActivityType,
    AgentRole,
    ApprovalStatus,
    BookingStatus,
    EvidenceKind,
    IncidentStatus,
    IncidentType,
    RiskLevel,
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(ts: Optional[datetime]) -> Optional[str]:
    return ts.isoformat() if ts else None


def parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex[:16]}"


def _dec(value: Any) -> Decimal:
    return Decimal(str(value))


@dataclass
class Traveler:
    traveler_id: str
    name: str = ""
    preferences: dict[str, Any] = field(default_factory=dict)
    mobility_constraints: dict[str, Any] = field(default_factory=dict)  # only if explicitly provided
    created_at: datetime = field(default_factory=utcnow)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["created_at"] = iso(self.created_at)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Traveler":
        return cls(
            traveler_id=d["traveler_id"],
            name=d.get("name", ""),
            preferences=d.get("preferences", {}),
            mobility_constraints=d.get("mobility_constraints", {}),
            created_at=parse_iso(d.get("created_at")) or utcnow(),
        )


@dataclass
class Activity:
    """One item in an itinerary. An attraction suggested by Places is a SUGGESTION,
    not a booking — ``booking_id`` is null until the Booker confirms an escrow."""

    activity_id: str
    trip_id: str
    title: str
    activity_type: ActivityType
    seller_id: Optional[str] = None        # set when tied to a bookable seller/store
    store_id: Optional[str] = None         # demo store id, when sourced from a store
    sku: Optional[str] = None
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    location_name: str = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    indoor: Optional[bool] = None
    refundable: Optional[bool] = None
    amount: Optional[str] = None           # RLUSD decimal string quote, if bookable
    booking_id: Optional[str] = None       # set once the Booker creates an escrow
    verified: Optional[bool] = None        # store-verified flag (False => unverified trap)
    notes: str = ""
    version: int = 1

    def to_dict(self) -> dict:
        d = asdict(self)
        d["activity_type"] = self.activity_type.value
        d["start_at"] = iso(self.start_at)
        d["end_at"] = iso(self.end_at)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Activity":
        return cls(
            activity_id=d["activity_id"],
            trip_id=d["trip_id"],
            title=d.get("title", ""),
            activity_type=ActivityType(d.get("activity_type", "other")),
            seller_id=d.get("seller_id"),
            store_id=d.get("store_id"),
            sku=d.get("sku"),
            start_at=parse_iso(d.get("start_at")),
            end_at=parse_iso(d.get("end_at")),
            location_name=d.get("location_name", ""),
            lat=d.get("lat"),
            lng=d.get("lng"),
            indoor=d.get("indoor"),
            refundable=d.get("refundable"),
            amount=d.get("amount"),
            booking_id=d.get("booking_id"),
            verified=d.get("verified"),
            notes=d.get("notes", ""),
            version=d.get("version", 1),
        )

    @property
    def is_bookable(self) -> bool:
        return self.seller_id is not None and self.amount is not None


@dataclass
class Itinerary:
    """A versioned itinerary. Versions are immutable once published; edits create a
    new version so the timeline can show what changed during recovery."""

    itinerary_id: str
    trip_id: str
    version: int
    activities: list[Activity] = field(default_factory=list)
    created_at: datetime = field(default_factory=utcnow)
    notes: str = ""

    def to_dict(self) -> dict:
        return {
            "itinerary_id": self.itinerary_id,
            "trip_id": self.trip_id,
            "version": self.version,
            "activities": [a.to_dict() for a in self.activities],
            "created_at": iso(self.created_at),
            "notes": self.notes,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Itinerary":
        return cls(
            itinerary_id=d["itinerary_id"],
            trip_id=d["trip_id"],
            version=d.get("version", 1),
            activities=[Activity.from_dict(a) for a in d.get("activities", [])],
            created_at=parse_iso(d.get("created_at")) or utcnow(),
            notes=d.get("notes", ""),
        )

    def find(self, activity_id: str) -> Optional[Activity]:
        return next((a for a in self.activities if a.activity_id == activity_id), None)


@dataclass
class PaymentEvidence:
    """On-chain/live evidence backing a booking claim. Mirrors the payment server
    booking fields so the dashboard can show real explorer links vs a MOCK badge."""

    tx_hash: Optional[str] = None
    explorer_url: Optional[str] = None
    claim_id: Optional[str] = None
    block_number: Optional[int] = None
    cumulative_amount: Optional[str] = None
    receipt_url: Optional[str] = None
    settlement: Optional[dict] = None
    channel_id: Optional[str] = None
    chain_status: Optional[str] = None
    paid_via: Optional[str] = None          # "x402" | "voucher" | None
    resource: Optional[Any] = None         # JSON the seller delivered, if x402
    badge: Optional[str] = None            # LIVE | LOCAL | MOCK (server's per-booking badge)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: Optional[dict]) -> "PaymentEvidence":
        if not d:
            return cls()
        return cls(
            tx_hash=d.get("tx_hash"),
            explorer_url=d.get("explorer_url"),
            claim_id=d.get("claim_id"),
            block_number=d.get("block_number"),
            cumulative_amount=d.get("cumulative_amount"),
            receipt_url=d.get("receipt_url"),
            settlement=d.get("settlement"),
            channel_id=d.get("channel_id"),
            chain_status=d.get("chain_status"),
            paid_via=d.get("paid_via"),
            resource=d.get("resource"),
            badge=d.get("badge"),
        )

    @property
    def evidence_kind(self) -> EvidenceKind:
        # LIVE requires a confirmed on-chain transaction, regardless of mode.
        if self.tx_hash and self.chain_status == "confirmed":
            return EvidenceKind.LIVE
        # Otherwise the server's per-booking badge distinguishes MOCK from LOCAL.
        if self.badge == "MOCK":
            return EvidenceKind.MOCK
        if self.badge == "LOCAL":
            return EvidenceKind.LOCAL
        # No badge set: fall back to chain presence.
        return EvidenceKind.LOCAL


@dataclass
class BookingRecord:
    """Local reconciliation of one payment-server escrow. The payment server and the
    chain remain authoritative for financial outcomes; this record is the agent's
    operational view, kept in sync via getStatus."""

    booking_id: str
    trip_id: str
    activity_id: str
    seller_id: str
    amount: str                              # locked amount, RLUSD decimal string
    final_bill: Optional[str] = None
    status: BookingStatus = BookingStatus.QUOTED
    reason: Optional[str] = None
    escrow_id: Optional[str] = None          # payment server escrow id
    evidence: PaymentEvidence = field(default_factory=PaymentEvidence)
    badge: str = "MOCK"                       # LIVE | LOCAL | MOCK
    note: str = ""
    mode: str = "mock"                        # mock | ap4m
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
    deadline_at: Optional[datetime] = None
    idempotency_key: Optional[str] = None
    repaired: Optional[dict] = None           # chain-driven repair record
    replaced_by: Optional[str] = None         # booking_id of the replacement, if any

    def to_dict(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value
        d["evidence"] = self.evidence.to_dict()
        d["created_at"] = iso(self.created_at)
        d["updated_at"] = iso(self.updated_at)
        d["deadline_at"] = iso(self.deadline_at)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "BookingRecord":
        return cls(
            booking_id=d["booking_id"],
            trip_id=d["trip_id"],
            activity_id=d["activity_id"],
            seller_id=d["seller_id"],
            amount=d["amount"],
            final_bill=d.get("final_bill"),
            status=BookingStatus(d.get("status", "quoted")),
            reason=d.get("reason"),
            escrow_id=d.get("escrow_id"),
            evidence=PaymentEvidence.from_dict(d.get("evidence")),
            badge=d.get("badge", "MOCK"),
            note=d.get("note", ""),
            mode=d.get("mode", "mock"),
            created_at=parse_iso(d.get("created_at")) or utcnow(),
            updated_at=parse_iso(d.get("updated_at")) or utcnow(),
            deadline_at=parse_iso(d.get("deadline_at")),
            idempotency_key=d.get("idempotency_key"),
            repaired=d.get("repaired"),
            replaced_by=d.get("replaced_by"),
        )

    @property
    def is_terminal(self) -> bool:
        return self.status in (BookingStatus.DELIVERED, BookingStatus.REFUNDED, BookingStatus.OVERCHARGED)

    @property
    def is_paid(self) -> bool:
        return self.status == BookingStatus.DELIVERED and self.evidence.evidence_kind == EvidenceKind.LIVE


@dataclass
class Trip:
    trip_id: str
    traveler_id: str
    title: str = ""
    destination: str = ""
    budget_rlusd: str = "19"                 # mirrors mock server default total
    start_at: Optional[datetime] = None
    end_at: Optional[datetime] = None
    status: str = "planning"                 # planning | active | closed
    current_itinerary_id: Optional[str] = None
    created_at: datetime = field(default_factory=utcnow)
    updated_at: datetime = field(default_factory=utcnow)
    next_check_at: Optional[datetime] = None  # monitoring schedule
    preferences: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["start_at"] = iso(self.start_at)
        d["end_at"] = iso(self.end_at)
        d["created_at"] = iso(self.created_at)
        d["updated_at"] = iso(self.updated_at)
        d["next_check_at"] = iso(self.next_check_at)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Trip":
        return cls(
            trip_id=d["trip_id"],
            traveler_id=d["traveler_id"],
            title=d.get("title", ""),
            destination=d.get("destination", ""),
            budget_rlusd=d.get("budget_rlusd", "19"),
            start_at=parse_iso(d.get("start_at")),
            end_at=parse_iso(d.get("end_at")),
            status=d.get("status", "planning"),
            current_itinerary_id=d.get("current_itinerary_id"),
            created_at=parse_iso(d.get("created_at")) or utcnow(),
            updated_at=parse_iso(d.get("updated_at")) or utcnow(),
            next_check_at=parse_iso(d.get("next_check_at")),
            preferences=d.get("preferences", {}),
        )


@dataclass
class Observation:
    """One monitoring tick's reading of an external signal."""

    observation_id: str
    trip_id: str
    source: str                               # "weather" | "traffic" | "schedule" | "provider_webhook" | ...
    signal: dict[str, Any] = field(default_factory=dict)
    observed_at: datetime = field(default_factory=utcnow)
    dedup_key: Optional[str] = None           # stable key for deduplication

    def to_dict(self) -> dict:
        d = asdict(self)
        d["observed_at"] = iso(self.observed_at)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Observation":
        return cls(
            observation_id=d["observation_id"],
            trip_id=d["trip_id"],
            source=d.get("source", ""),
            signal=d.get("signal", {}),
            observed_at=parse_iso(d.get("observed_at")) or utcnow(),
            dedup_key=d.get("dedup_key"),
        )


@dataclass
class Incident:
    """A classified, deduplicated disruption affecting a trip."""

    incident_id: str
    trip_id: str
    incident_type: IncidentType
    risk_level: RiskLevel = RiskLevel.MEDIUM
    status: IncidentStatus = IncidentStatus.OPEN
    affected_activity_id: Optional[str] = None
    affected_booking_id: Optional[str] = None
    summary: str = ""
    details: dict[str, Any] = field(default_factory=dict)
    detected_at: datetime = field(default_factory=utcnow)
    resolved_at: Optional[datetime] = None
    dedup_key: Optional[str] = None
    lock_id: Optional[str] = None              # execution lock id (no overlapping recovery)
    recovery_attempts: list[str] = field(default_factory=list)  # recovery attempt ids
    approval_request_id: Optional[str] = None
    correlation_id: Optional[str] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["incident_type"] = self.incident_type.value
        d["risk_level"] = self.risk_level.value
        d["status"] = self.status.value
        d["detected_at"] = iso(self.detected_at)
        d["resolved_at"] = iso(self.resolved_at)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "Incident":
        return cls(
            incident_id=d["incident_id"],
            trip_id=d["trip_id"],
            incident_type=IncidentType(d.get("incident_type", "rain_outdoor_tour")),
            risk_level=RiskLevel(d.get("risk_level", "medium")),
            status=IncidentStatus(d.get("status", "open")),
            affected_activity_id=d.get("affected_activity_id"),
            affected_booking_id=d.get("affected_booking_id"),
            summary=d.get("summary", ""),
            details=d.get("details", {}),
            detected_at=parse_iso(d.get("detected_at")) or utcnow(),
            resolved_at=parse_iso(d.get("resolved_at")),
            dedup_key=d.get("dedup_key"),
            lock_id=d.get("lock_id"),
            recovery_attempts=d.get("recovery_attempts", []),
            approval_request_id=d.get("approval_request_id"),
            correlation_id=d.get("correlation_id"),
        )


@dataclass
class RecoveryAttempt:
    """One attempt by the Recovery Agent to resolve an incident."""

    attempt_id: str
    incident_id: str
    trip_id: str
    action: str                               # e.g. "replace_activity", "refund_and_rebook"
    proposed_alternative: dict[str, Any] = field(default_factory=dict)
    additional_cost: Optional[str] = None
    requires_approval: bool = False
    approval_granted: bool = False
    outcome: str = "pending"                 # pending | succeeded | failed | escalated
    evidence: dict[str, Any] = field(default_factory=dict)
    started_at: datetime = field(default_factory=utcnow)
    finished_at: Optional[datetime] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["started_at"] = iso(self.started_at)
        d["finished_at"] = iso(self.finished_at)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "RecoveryAttempt":
        return cls(
            attempt_id=d["attempt_id"],
            incident_id=d["incident_id"],
            trip_id=d["trip_id"],
            action=d.get("action", ""),
            proposed_alternative=d.get("proposed_alternative", {}),
            additional_cost=d.get("additional_cost"),
            requires_approval=d.get("requires_approval", False),
            approval_granted=d.get("approval_granted", False),
            outcome=d.get("outcome", "pending"),
            evidence=d.get("evidence", {}),
            started_at=parse_iso(d.get("started_at")) or utcnow(),
            finished_at=parse_iso(d.get("finished_at")),
        )


@dataclass
class ApprovalRequest:
    """A request for a human decision before an action that exceeds preauthorization."""

    request_id: str
    trip_id: str
    incident_id: Optional[str] = None
    action: str = ""
    description: str = ""
    proposed_cost: Optional[str] = None
    status: ApprovalStatus = ApprovalStatus.PENDING
    requested_at: datetime = field(default_factory=utcnow)
    decided_at: Optional[datetime] = None
    decided_by: Optional[str] = None
    decision_reason: Optional[str] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value
        d["requested_at"] = iso(self.requested_at)
        d["decided_at"] = iso(self.decided_at)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "ApprovalRequest":
        return cls(
            request_id=d["request_id"],
            trip_id=d["trip_id"],
            incident_id=d.get("incident_id"),
            action=d.get("action", ""),
            description=d.get("description", ""),
            proposed_cost=d.get("proposed_cost"),
            status=ApprovalStatus(d.get("status", "pending")),
            requested_at=parse_iso(d.get("requested_at")) or utcnow(),
            decided_at=parse_iso(d.get("decided_at")),
            decided_by=d.get("decided_by"),
            decision_reason=d.get("decision_reason"),
        )


@dataclass
class ExecutionLock:
    """A durable execution lock — prevents overlapping recovery for one incident
    and duplicate booking for one request."""

    lock_id: str
    trip_id: str
    scope: str                                # "incident:<id>" | "booking:<key>" | ...
    held_by: Optional[str] = None
    acquired_at: datetime = field(default_factory=utcnow)
    expires_at: Optional[datetime] = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["acquired_at"] = iso(self.acquired_at)
        d["expires_at"] = iso(self.expires_at)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "ExecutionLock":
        return cls(
            lock_id=d["lock_id"],
            trip_id=d["trip_id"],
            scope=d.get("scope", ""),
            held_by=d.get("held_by"),
            acquired_at=parse_iso(d.get("acquired_at")) or utcnow(),
            expires_at=parse_iso(d.get("expires_at")),
        )


@dataclass
class AuditEvent:
    """Structured audit log entry with a correlation id linking trip/incident/escrow."""

    event_id: str
    trip_id: Optional[str]
    correlation_id: Optional[str]
    role: AgentRole
    action: str
    outcome: str = "ok"                       # ok | error | denied | escalated
    details: dict[str, Any] = field(default_factory=dict)
    occurred_at: datetime = field(default_factory=utcnow)
    # intentionally never stores secrets/payment credentials

    def to_dict(self) -> dict:
        d = asdict(self)
        d["role"] = self.role.value
        d["occurred_at"] = iso(self.occurred_at)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "AuditEvent":
        return cls(
            event_id=d["event_id"],
            trip_id=d.get("trip_id"),
            correlation_id=d.get("correlation_id"),
            role=AgentRole(d.get("role", "master")),
            action=d.get("action", ""),
            outcome=d.get("outcome", "ok"),
            details=d.get("details", {}),
            occurred_at=parse_iso(d.get("occurred_at")) or utcnow(),
        )


@dataclass
class TimelineEntry:
    """A UI-facing agent activity entry on the recovery timeline."""

    entry_id: str
    trip_id: str
    incident_id: Optional[str]
    step: str                                 # observation_detected | risk_classified | ...
    message: str
    evidence_kind: Optional[str] = None
    occurred_at: datetime = field(default_factory=utcnow)
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict:
        d = asdict(self)
        d["occurred_at"] = iso(self.occurred_at)
        return d

    @classmethod
    def from_dict(cls, d: dict) -> "TimelineEntry":
        return cls(
            entry_id=d["entry_id"],
            trip_id=d["trip_id"],
            incident_id=d.get("incident_id"),
            step=d.get("step", ""),
            message=d.get("message", ""),
            evidence_kind=d.get("evidence_kind"),
            occurred_at=parse_iso(d.get("occurred_at")) or utcnow(),
            details=d.get("details", {}),
        )
