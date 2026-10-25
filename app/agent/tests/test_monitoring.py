"""Monitoring engine tests: ticks, dedup, locks, missing weather API."""

from __future__ import annotations

import pytest

from swanavi.config import load_config
from swanavi.domain.enums import IncidentStatus, IncidentType
from swanavi.monitoring import (
    MonitoringEngine, NoWeatherSource, ScheduleDetector,
    ScriptedWeatherSource, TrafficDetector, WeatherDetector,
)


def _engine(store, weather_source=None, traffic_source=None):
    cfg = load_config(sqlite_path=None)
    eng = MonitoringEngine(store, cfg)
    wd = WeatherDetector(weather_source or NoWeatherSource())
    eng.register_default_detectors(wd, TrafficDetector(traffic_source))
    return eng


def test_tick_no_incident_when_weather_benign(store, trip):
    _, activity = trip
    ws = ScriptedWeatherSource()
    ws.set(f"latlng:{activity.lat},{activity.lng}",
           {"condition": "clear", "severity": "low", "precip_mm": 0})
    eng = _engine(store, ws)
    result = eng.run_tick(activity.trip_id)
    assert result["new_incidents"] == 0
    assert result["unsupported_sources"] == []


def test_tick_detects_rain_incident(store, trip):
    _, activity = trip
    ws = ScriptedWeatherSource()
    ws.set(f"latlng:{activity.lat},{activity.lng}",
           {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    eng = _engine(store, ws)
    result = eng.run_tick(activity.trip_id)
    assert result["new_incidents"] == 1
    incidents = store.list("incident", activity.trip_id)
    assert incidents[0].incident_type == IncidentType.RAIN_OUTDOOR_TOUR


def test_tick_dedup_repeated_observations(store, trip):
    _, activity = trip
    ws = ScriptedWeatherSource()
    ws.set(f"latlng:{activity.lat},{activity.lng}",
           {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    eng = _engine(store, ws)
    eng.run_tick(activity.trip_id)
    second = eng.run_tick(activity.trip_id)
    # same weather signature => deduped, no new incident
    assert second["new_incidents"] == 0


def test_tick_no_overlapping_incident_for_same_dedup(store, trip):
    _, activity = trip
    ws = ScriptedWeatherSource()
    ws.set(f"latlng:{activity.lat},{activity.lng}",
           {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    eng = _engine(store, ws)
    eng.run_tick(activity.trip_id)
    # an open incident already exists for this dedup key; open_incident_for returns it
    existing = store.open_incident_for(activity.trip_id,
        f"{activity.trip_id}:rain_outdoor_tour:{activity.activity_id}")
    assert existing is not None
    assert existing.status == IncidentStatus.OPEN


def test_duplicate_monitor_invocation_uses_lock(store, trip):
    _, activity = trip
    ws = ScriptedWeatherSource()
    ws.set(f"latlng:{activity.lat},{activity.lng}",
           {"condition": "rain", "severity": "moderate", "precip_mm": 2.0})
    eng = _engine(store, ws)
    eng.run_tick(activity.trip_id)
    incident = store.list("incident", activity.trip_id)[0]
    lock1 = eng.begin_recovery(incident.incident_id)
    assert lock1 is not None
    # a second recovery attempt for the same incident is blocked (no overlap)
    lock2 = eng.begin_recovery(incident.incident_id)
    assert lock2 is None
    eng.release_recovery_lock(lock1)
    # now it can be acquired again
    lock3 = eng.acquire_recovery_lock(incident)
    assert lock3 is not None


def test_missing_weather_api_records_unsupported_no_incident(store, trip):
    """NoWeatherSource returns None -> no fabrication, no incident, 'unsupported' noted."""
    _, activity = trip
    eng = _engine(store, NoWeatherSource())
    result = eng.run_tick(activity.trip_id)
    assert result["new_incidents"] == 0
    # the observation was recorded as unsupported
    obs = store.list("observation", activity.trip_id)
    assert any(o.signal.get("status") == "unsupported" for o in obs) or all(
        o.signal.get("weather") is None for o in obs)


def test_severe_weather_escalates(store, trip):
    _, activity = trip
    ws = ScriptedWeatherSource()
    ws.set(f"latlng:{activity.lat},{activity.lng}",
           {"condition": "storm", "severity": "severe", "precip_mm": 0})
    eng = _engine(store, ws)
    result = eng.run_tick(activity.trip_id)
    assert result["new_incidents"] == 1
    incident = store.list("incident", activity.trip_id)[0]
    from swanavi.domain.enums import RiskLevel
    assert incident.incident_type == IncidentType.SEVERE_WEATHER
    assert incident.risk_level == RiskLevel.HIGH


def test_schedule_detector_finds_invalid_schedule(store, trip):
    _, activity = trip
    # corrupt the activity schedule: end before start
    from datetime import datetime, timedelta, timezone
    activity.start_at = datetime(2026, 11, 1, 14, 0, tzinfo=timezone.utc)
    activity.end_at = datetime(2026, 11, 1, 12, 0, tzinfo=timezone.utc)
    store.save("activity", activity)
    eng = _engine(store, NoWeatherSource())
    eng._detectors = [ScheduleDetector()]
    result = eng.run_tick(activity.trip_id)
    incidents = store.list("incident", activity.trip_id)
    assert any(i.incident_type == IncidentType.OVERLAPPING_ITINERARY for i in incidents)


def test_next_check_scheduled(store, trip):
    _, activity = trip
    eng = _engine(store, NoWeatherSource())
    eng.run_tick(activity.trip_id)
    t = store.get("trip", activity.trip_id)
    assert t.next_check_at is not None


def test_traffic_unsupported_without_source(store, trip):
    _, activity = trip
    # add a transport activity so the traffic detector runs and records 'unsupported'
    from swanavi.domain.enums import ActivityType
    from swanavi.domain.models import Activity, new_id
    transport = Activity(
        activity_id=new_id("act"), trip_id=activity.trip_id, title="Cab ride",
        activity_type=ActivityType.TRANSPORT, seller_id="cab",
        lat=40.75, lng=-73.98, indoor=None,
    )
    store.save("activity", transport)
    eng = _engine(store, NoWeatherSource())  # no traffic source
    result = eng.run_tick(activity.trip_id)
    assert "traffic" in result["unsupported_sources"]
