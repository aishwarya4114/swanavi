"""Incident classification and state machine.

Detectors turn raw observations into incident candidates; this module decides the
incident type, risk, dedup key, and which (if any) booking/activity is affected.
The state machine transitions are enforced atomically by the store.
"""

from __future__ import annotations

from typing import Any, Optional

from ..domain.enums import IncidentStatus, IncidentType, RiskLevel
from ..domain.models import Activity, Incident, new_id, utcnow


# Incident type by activity + signal. Drives which recovery policy applies.
def classify_weather_for_activity(activity: Activity, signal: dict) -> Optional[dict]:
    """Given a weather signal for an outdoor activity, decide the incident.
    Returns None if the weather is benign for this activity."""
    if activity.indoor is True:
        return None
    condition = str(signal.get("condition", "")).lower()
    severity = str(signal.get("severity", "")).lower()
    precip_mm = float(signal.get("precip_mm", 0) or 0)

    is_outdoor = activity.activity_type.value in ("outdoor_tour", "transport") or activity.indoor is False
    if not is_outdoor:
        return None

    if severity in ("severe", "extreme", "storm", "hazard"):
        return {
            "type": IncidentType.SEVERE_WEATHER,
            "risk": RiskLevel.HIGH,
            "summary": f"Severe weather ({condition}) threatens outdoor activity '{activity.title}'.",
        }
    if "rain" in condition or precip_mm >= 1.0 or severity == "moderate":
        return {
            "type": IncidentType.RAIN_OUTDOOR_TOUR,
            "risk": RiskLevel.MEDIUM,
            "summary": f"Rain forecast affects outdoor activity '{activity.title}'.",
        }
    return None


def dedup_key_for(trip_id: str, incident_type: IncidentType, activity_id: Optional[str]) -> str:
    """Stable dedup key: one open incident per (trip, type, activity)."""
    return f"{trip_id}:{incident_type.value}:{activity_id or '*'}"


# Valid incident status transitions. Enforced by the store's atomic write.
TRANSITIONS = {
    IncidentStatus.OPEN: {IncidentStatus.IN_REVIEW, IncidentStatus.DROPPED, IncidentStatus.ESCALATED},
    IncidentStatus.IN_REVIEW: {IncidentStatus.AWAITING_APPROVAL, IncidentStatus.RECOVERING,
                                IncidentStatus.DROPPED, IncidentStatus.ESCALATED},
    IncidentStatus.AWAITING_APPROVAL: {IncidentStatus.RECOVERING, IncidentStatus.ESCALATED,
                                        IncidentStatus.DROPPED},
    IncidentStatus.RECOVERING: {IncidentStatus.RESOLVED, IncidentStatus.ESCALATED,
                                               IncidentStatus.IN_REVIEW},
    IncidentStatus.RESOLVED: set(),
    IncidentStatus.ESCALATED: {IncidentStatus.IN_REVIEW, IncidentStatus.DROPPED},
    IncidentStatus.DROPPED: set(),
}


def can_transition(from_status: IncidentStatus, to_status: IncidentStatus) -> bool:
    return to_status in TRANSITIONS.get(from_status, set())


def build_incident(
    trip_id: str, incident_type: IncidentType, risk: RiskLevel, summary: str,
    activity_id: Optional[str], booking_id: Optional[str], details: dict,
    correlation_id: Optional[str] = None,
) -> Incident:
    return Incident(
        incident_id=new_id("inc"), trip_id=trip_id, incident_type=incident_type,
        risk_level=risk, summary=summary, affected_activity_id=activity_id,
        affected_booking_id=booking_id, details=details,
        dedup_key=dedup_key_for(trip_id, incident_type, activity_id),
        correlation_id=correlation_id,
    )
