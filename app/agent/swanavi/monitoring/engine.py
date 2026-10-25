"""The monitoring engine.

Deterministic, not an LLM loop. A "tick" reads trip state, gathers observations
from registered sources, classifies them, deduplicates against existing incidents,
creates new incidents (atomic), and emits them to a callback that the orchestrator
wires to the Master Agent. Execution locks prevent overlapping recovery for one
incident; idempotency keys prevent duplicate booking. Intervals are configurable.

In local development a tick is triggered manually (``run_tick``). The eventual AWS
deployment schedules ticks with EventBridge; the engine is the same.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Callable, Optional

from ..config import SwanaviConfig
from ..domain.enums import IncidentStatus, RiskLevel
from ..domain.models import Incident, Trip, utcnow
from ..storage.store import SwanaviStore
from .detectors import (
    DETECTOR_TYPES, ScheduleDetector, TrafficDetector, WeatherDetector,
)


IncidentHandler = Callable[[Incident], None]


class MonitoringEngine:
    def __init__(self, store: SwanaviStore, config: SwanaviConfig, handlers: Optional[list[IncidentHandler]] = None):
        self.store = store
        self.config = config
        self.handlers: list[IncidentHandler] = handlers or []
        self._detectors: list = []

    def add_detector(self, detector) -> None:
        self._detectors.append(detector)

    def register_default_detectors(self, weather_detector: WeatherDetector,
                                     traffic_detector: TrafficDetector) -> None:
        self._detectors = [weather_detector, ScheduleDetector(), traffic_detector]

    def add_handler(self, handler: IncidentHandler) -> None:
        self.handlers.append(handler)

    # ------------------------------------------------------------------ scheduling
    def next_interval(self, trip: Trip, has_critical: bool = False) -> int:
        if has_critical:
            return self.config.critical_interval
        if self._trip_is_active(trip):
            return self.config.active_travel_interval
        return self.config.pre_travel_interval

    @staticmethod
    def _trip_is_active(trip: Trip) -> bool:
        now = utcnow()
        if trip.start_at and trip.end_at:
            return trip.start_at <= now <= trip.end_at
        if trip.start_at:
            return now >= trip.start_at
        return trip.status == "active"

    # ------------------------------------------------------------------ tick
    def run_tick(self, trip_id: str, emit: bool = True) -> dict:
        """Run one monitoring tick for a trip. Returns a summary dict (for the UI/log).
        Never raises on a missing source — records 'unsupported' instead."""
        trip = self.store.get("trip", trip_id)
        if not trip:
            raise KeyError(f"unknown trip {trip_id}")
        activities = self.store.list("activity", trip_id)
        new_observations: list = []
        new_incidents: list[Incident] = []
        deduped: list[str] = []
        unsupported: list[str] = []

        for detector in self._detectors:
            try:
                obs_list, candidates = detector.observe(activities, trip_id)
            except Exception:
                unsupported.append(type(detector).__name__)
                continue
            for obs in obs_list:
                if obs.signal.get("status") == "unsupported":
                    unsupported.append(obs.source)
                # dedup observations by dedup_key (avoid storing duplicates forever)
                if obs.dedup_key and self.store.observation_seen(trip_id, obs.dedup_key):
                    continue
                self.store.save("observation", obs)
                new_observations.append(obs)
            for cand in candidates:
                incident = cand["incident"]
                existing = self.store.open_incident_for(trip_id, incident.dedup_key)
                if existing:
                    deduped.append(incident.dedup_key)
                    continue
                # transition: create as OPEN
                self.store.save("incident", incident)
                new_incidents.append(incident)

        # schedule next check
        has_critical = any(i.risk_level == RiskLevel.CRITICAL for i in
                           self.store.list("incident", trip_id))
        trip.next_check_at = utcnow() + timedelta(seconds=self.next_interval(trip, has_critical))
        trip.updated_at = utcnow()
        self.store.save("trip", trip)

        # emit new incidents to handlers (e.g. the Master Agent)
        if emit:
            for incident in new_incidents:
                for handler in self.handlers:
                    try:
                        handler(incident)
                    except Exception:
                        # a handler failure must not block other incidents
                        pass

        return {
            "trip_id": trip_id,
            "observations": len(new_observations),
            "new_incidents": len(new_incidents),
            "deduped": deduped,
            "unsupported_sources": list(set(unsupported)),
            "next_check_at": trip.next_check_at.isoformat() if trip.next_check_at else None,
        }

    # ------------------------------------------------------------------ recovery lock
    def acquire_recovery_lock(self, incident: Incident) -> Optional[str]:
        """Acquire the execution lock for an incident's recovery. Returns the lock id
        or None if recovery is already running (no overlapping recovery)."""
        scope = f"incident:{incident.incident_id}"
        lock = self.store.acquire_lock(
            incident.trip_id, scope,
            held_by=f"recovery:{incident.incident_id}",
            ttl_seconds=max(self.config.critical_interval * 5, 300),
        )
        return lock.lock_id if lock else None

    def release_recovery_lock(self, lock_id: str) -> None:
        if lock_id:
            self.store.release_lock(lock_id)

    def begin_recovery(self, incident_id: str) -> Optional[str]:
        """Transition an incident to IN_REVIEW and acquire its lock atomically-ish.
        Returns the lock id, or None if the incident is already being handled."""
        incident = self.store.get("incident", incident_id)
        if not incident:
            return None
        lock_id = self.acquire_recovery_lock(incident)
        if not lock_id:
            return None
        incident.status = IncidentStatus.IN_REVIEW
        incident.lock_id = lock_id
        self.store.save("incident", incident)
        return lock_id

    def incident_resolved(self, incident_id: str, lock_id: Optional[str]) -> None:
        incident = self.store.get("incident", incident_id)
        if incident:
            incident.status = IncidentStatus.RESOLVED
            incident.resolved_at = utcnow()
            self.store.save("incident", incident)
        if lock_id:
            self.release_recovery_lock(lock_id)
