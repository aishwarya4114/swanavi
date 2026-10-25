"""Observation sources and detectors.

The monitoring engine is deterministic: it does NOT run an LLM in a loop. It reads
external signals through injectable sources, classifies them into incident
candidates, deduplicates, and only wakes the Master Agent when warranted.

Sources are injectable so the suite runs with no network. A weather source that
returns ``None`` (missing/unavailable API) is handled gracefully — the detector
records an observation that it could not check the weather, and never fabricates
a forecast. Provider integrations that don't exist are clearly identified as
``unsupported`` rather than faked.
"""

from __future__ import annotations

from typing import Any, Optional, Protocol

from ..domain.enums import ActivityType, IncidentType, RiskLevel
from ..domain.models import Activity, Observation, new_id, utcnow
from .incidents import build_incident, classify_weather_for_activity


class WeatherSource(Protocol):
    """Returns a weather signal dict for a location, or None if unavailable.

    Implementations must NOT fabricate data. If the API key is missing or the
    service is down, return None (the detector treats that as 'could not check')."""

    def weather(self, lat: Optional[float], lng: Optional[float], when: Optional[Any] = None) -> Optional[dict]:
        ...


class TrafficSource(Protocol):
    """Returns travel-time context for an origin/destination, or None."""

    def travel_time(self, origin: dict, destination: dict) -> Optional[dict]:
        ...


class NoWeatherSource:
    """A weather source that is always unavailable. Used when no API key exists."""

    def weather(self, lat, lng, when=None) -> Optional[dict]:
        return None


class ScriptedWeatherSource:
    """A deterministic weather source for the demo and tests. Maps a location key
    (or a registered activity id) to a scripted forecast. Never claims to be live."""

    def __init__(self):
        self._signals: dict[str, dict] = {}

    def set(self, key: str, signal: dict) -> None:
        self._signals[key] = signal

    def weather(self, lat, lng, when=None) -> Optional[dict]:
        # Match by lat/lng rounded, or by an explicit key stored under a sentinel.
        for k, v in self._signals.items():
            if k.startswith("latlng:"):
                parts = k.split(":")[1].split(",")
                if lat is not None and lng is not None and abs(float(parts[0]) - lat) < 0.01 \
                        and abs(float(parts[1]) - lng) < 0.01:
                    return v
        return None


class WeatherDetector:
    """Detects rain/severe-weather incidents affecting outdoor activities."""

    def __init__(self, weather_source: WeatherSource):
        self.source = weather_source

    def observe(self, activities: list[Activity], trip_id: str) -> tuple[list[Observation], list[dict]]:
        observations: list[Observation] = []
        candidates: list[dict] = []
        for act in activities:
            weather = self.source.weather(act.lat, act.lng)
            observed_at = utcnow()
            obs = Observation(
                observation_id=new_id("obs"), trip_id=trip_id, source="weather",
                signal={"activity_id": act.activity_id, "weather": weather},
                observed_at=observed_at,
                dedup_key=f"weather:{trip_id}:{act.activity_id}:{_weather_sig(weather)}",
            )
            observations.append(obs)
            if weather is None:
                continue  # missing API -> no fabrication, no incident
            classified = classify_weather_for_activity(act, weather)
            if classified:
                candidates.append({
                    "incident": build_incident(
                        trip_id, classified["type"], classified["risk"],
                        classified["summary"], act.activity_id, act.booking_id,
                        {"weather": weather, "activity_title": act.title},
                    ),
                    "observation_id": obs.observation_id,
                })
        return observations, candidates


def _weather_sig(weather: Optional[dict]) -> str:
    if not weather:
        return "none"
    return f"{weather.get('condition','')}:{weather.get('severity','')}:{weather.get('precip_mm','')}"


class ScheduleDetector:
    """Detects invalid activity schedules and overlapping itinerary events.
    Needs no external API — pure local computation."""

    def observe(self, activities: list[Activity], trip_id: str) -> tuple[list[Observation], list[dict]]:
        observations: list[Observation] = []
        candidates: list[dict] = []
        # invalid schedule: end before start
        for act in activities:
            if act.start_at and act.end_at and act.end_at <= act.start_at:
                obs = Observation(
                    observation_id=new_id("obs"), trip_id=trip_id, source="schedule",
                    signal={"problem": "end_before_start", "activity_id": act.activity_id},
                    dedup_key=f"schedule:{trip_id}:{act.activity_id}:invalid",
                )
                observations.append(obs)
                candidates.append({
                    "incident": build_incident(
                        trip_id, IncidentType.OVERLAPPING_ITINERARY, RiskLevel.LOW,
                        f"Activity '{act.title}' has an invalid schedule (end before start).",
                        act.activity_id, act.booking_id,
                        {"problem": "invalid_schedule"},
                    ),
                    "observation_id": obs.observation_id,
                })
        # overlaps: sort by start, flag overlapping pairs
        timed = sorted(
            [a for a in activities if a.start_at and a.end_at],
            key=lambda a: a.start_at,
        )
        for i in range(len(timed) - 1):
            a, b = timed[i], timed[i + 1]
            if a.end_at > b.start_at and a.activity_id != b.activity_id:
                obs = Observation(
                    observation_id=new_id("obs"), trip_id=trip_id, source="schedule",
                    signal={"overlap": [a.activity_id, b.activity_id]},
                    dedup_key=f"schedule:{trip_id}:overlap:{a.activity_id}:{b.activity_id}",
                )
                observations.append(obs)
                candidates.append({
                    "incident": build_incident(
                        trip_id, IncidentType.OVERLAPPING_ITINERARY, RiskLevel.LOW,
                        f"Activities '{a.title}' and '{b.title}' overlap in time.",
                        a.activity_id, None,
                        {"overlap_with": b.activity_id},
                    ),
                    "observation_id": obs.observation_id,
                })
        return observations, candidates


class TrafficDetector:
    """Detects traffic that threatens a timed booking. Needs a TrafficSource;
    with no source it records 'unsupported' and never fabricates delays."""

    def __init__(self, traffic_source: Optional[TrafficSource] = None):
        self.source = traffic_source

    def observe(self, activities: list[Activity], trip_id: str) -> tuple[list[Observation], list[dict]]:
        observations: list[Observation] = []
        candidates: list[dict] = []
        transport = [a for a in activities if a.activity_type == ActivityType.TRANSPORT]
        for act in transport:
            if not self.source:
                observations.append(Observation(
                    observation_id=new_id("obs"), trip_id=trip_id, source="traffic",
                    signal={"activity_id": act.activity_id, "status": "unsupported"},
                    dedup_key=f"traffic:{trip_id}:{act.activity_id}:unsupported",
                ))
                continue
            tt = self.source.travel_time({"lat": act.lat, "lng": act.lng}, {})
            obs = Observation(
                observation_id=new_id("obs"), trip_id=trip_id, source="traffic",
                signal={"activity_id": act.activity_id, "travel": tt},
                dedup_key=f"traffic:{trip_id}:{act.activity_id}:{tt.get('delay_min') if tt else 'none'}",
            )
            observations.append(obs)
            if tt and tt.get("delay_min") and float(tt["delay_min"]) >= 20:
                candidates.append({
                    "incident": build_incident(
                        trip_id, IncidentType.TRAFFIC_TIMED_BOOKING, RiskLevel.MEDIUM,
                        f"Traffic threatens timed booking '{act.title}'.",
                        act.activity_id, act.booking_id,
                        {"delay_min": tt["delay_min"]},
                    ),
                    "observation_id": obs.observation_id,
                })
        return observations, candidates


# A registry of detectors the engine runs. Each contributes observations + candidates.
DETECTOR_TYPES = {
    IncidentType.RAIN_OUTDOOR_TOUR: "weather",
    IncidentType.SEVERE_WEATHER: "weather",
    IncidentType.TRAFFIC_TIMED_BOOKING: "traffic",
    IncidentType.OVERLAPPING_ITINERARY: "schedule",
    # The remaining incident types are detected via provider signals or booking
    # reconciliation, not free-text web data:
    #   FLIGHT_DELAY -> flight provider (unsupported: no live flight API)
    #   RESTAURANT_UNAVAILABLE / TOUR_CANCELLATION / ATTRACTION_CLOSURE -> provider/webhook
    #   HOTEL_BOOKING_FAILURE / PAYMENT_CONFIRMATION_FAILURE -> booker reconciliation
}
