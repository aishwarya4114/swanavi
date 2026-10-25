"""Swanavi Master Trip Agent — AgentCore Runtime entrypoint.

Preserves the generated structure (BedrockAgentCoreApp, parse_payload, per-session
agent caching) and wires in the Swanavi orchestrator: the deterministic core
(domain, store, payment client, booker, monitoring, recovery) plus the Strands
Master Agent that uses the safe payment/discovery tools.

Two invocation shapes:

* ``{"prompt": "...", "actorId": "..."}`` (or ``messages``) — free-form chat routed
  to the Master Agent (Strands + Bedrock). Safety invariants are enforced by the
  deterministic tools, not the prompt.
* ``{"action": "createTrip" | "runTick" | "handleIncident" | "dashboard" | ...,
     "actorId": "...", ...}`` — structured operations handled deterministically
  and returned as JSON. This is what the frontend and the monitoring scheduler call.

State persists across invocations via the configured store (SQLite file when
``SWANAVI_SQLITE_PATH`` is set; in-memory otherwise). The payment token comes from
the environment only (``SWANAVI_PAYMENT_TOKEN``) and is never logged.
"""

from __future__ import annotations

import json
import os
from functools import lru_cache
from typing import Any

from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager

from memory.session import get_memory_session_manager
from model.load import load_model
from parse import parse_payload

from swanavi.config import load_config
from swanavi.monitoring.detectors import ScriptedWeatherSource
from swanavi.observability import new_correlation_id, span
from swanavi.orchestrator import SwanaviOrchestrator
from swanavi.payment.client import MastercardClient, UrllibTransport
from swanavi.storage.store import SwanaviStore

# One orchestrator per process; the store backs all sessions.
_CONFIG = load_config()
_STORE = SwanaviStore(_CONFIG.sqlite_path) if _CONFIG.sqlite_path else SwanaviStore()
_CLIENT = MastercardClient(_CONFIG, transport=UrllibTransport())
_WEATHER = ScriptedWeatherSource()
_ORCHESTRATOR = SwanaviOrchestrator(_CLIENT, _STORE, _CONFIG, weather_source=_WEATHER)


def _make_conversation_manager():
    return NullConversationManager()


@lru_cache(maxsize=128)
def _get_agent(session_id: str, actor_id: str):
    """Return the Swanavi Master Agent (Strands) for a session. The agent uses the
    safe tools bound to the orchestrator's store + payment client."""
    from swanavi.agents.master import build_master_agent
    # session_id maps to a trip_id conceptually; for the runtime we use a per-actor
    # default trip unless the payload names one.
    trip_id = _ensure_actor_trip(actor_id)
    agent = build_master_agent(_ORCHESTRATOR, trip_id)
    # attach the memory session manager when AgentCore Memory is configured
    sm = get_memory_session_manager(session_id, actor_id)
    if sm is not None:
        agent.session_manager = sm
    agent.conversation_manager = _make_conversation_manager()
    return agent


@lru_cache(maxsize=128)
def _ensure_actor_trip(actor_id: str) -> str:
    """Each actor gets a working trip on first use so free-form chat has state."""
    existing = [t for t in _STORE.list("trip") if t.traveler_id == actor_id]
    if existing:
        return existing[0].trip_id
    trip = _ORCHESTRATOR.create_trip(actor_id, title=f"{actor_id} trip",
                                     destination="New York")
    return trip.trip_id


def _handle_action(payload: dict, actor_id: str) -> dict:
    """Structured operations handled deterministically (no LLM)."""
    action = payload.get("action")
    cid = new_correlation_id()
    with span("swanavi.action", correlation_id=cid, action=action, actor_id=actor_id):
        if action == "createTrip":
            trip = _ORCHESTRATOR.create_trip(
                actor_id,
                title=payload.get("title", ""), destination=payload.get("destination", ""),
                budget_rlusd=payload.get("budget", "19"),
            )
            return {"trip_id": trip.trip_id, "correlation_id": cid}
        if action == "addActivity":
            from swanavi.domain.enums import ActivityType
            from swanavi.domain.models import Activity, new_id
            from datetime import datetime, timezone
            trip_id = payload["tripId"]
            act = Activity(
                activity_id=new_id("act"), trip_id=trip_id,
                title=payload.get("title", ""), activity_type=ActivityType(payload.get("type", "other")),
                seller_id=payload.get("sellerId"), store_id=payload.get("storeId"),
                sku=payload.get("sku"), amount=payload.get("amount"),
                indoor=payload.get("indoor"), refundable=payload.get("refundable"),
                verified=payload.get("verified"), lat=payload.get("lat"), lng=payload.get("lng"),
            )
            _STORE.save("activity", act)
            return {"activity_id": act.activity_id, "correlation_id": cid}
        if action == "lock":
            return {"booking": _ORCHESTRATOR.lock_activity(
                payload["tripId"], payload["activityId"], payload["sellerId"],
                payload["amount"], deadline_seconds=payload.get("deadlineSeconds", 3600)),
                "correlation_id": cid}
        if action == "deliver":
            booking = _ORCHESTRATOR.booker(payload["tripId"]).deliver(payload["bookingId"])
            return {"booking": booking.to_dict(), "correlation_id": cid}
        if action == "runTick":
            return {**_ORCHESTRATOR.run_monitoring_tick(payload["tripId"], emit=True),
                    "correlation_id": cid}
        if action == "handleIncident":
            return _ORCHESTRATOR.handle_incident(payload["incidentId"]).__dict__
        if action == "dashboard":
            return _ORCHESTRATOR.trip_dashboard(payload["tripId"])
        if action == "recoveryPanel":
            return {"panels": _ORCHESTRATOR.recovery_panel(payload["tripId"])}
        if action == "decideApproval":
            return _ORCHESTRATOR.decide_approval(payload["requestId"], payload["approved"])
        if action == "injectWeather":
            # demo-only: seed the scripted weather source for a lat/lng
            _WEATHER.set(f"latlng:{payload['lat']},{payload['lng']}", payload["weather"])
            return {"ok": True, "correlation_id": cid, "demo": True,
                    "note": "scripted weather scenario; not live data"}
        return {"error": "unknown_action", "action": action}


def create_app():
    app = BedrockAgentCoreApp()
    log = app.logger

    @app.entrypoint
    async def invoke(payload, context):
        log.info("Invoking Swanavi Agent.....")
        if not isinstance(payload, dict):
            raise ValueError("payload must be a JSON object")
        session_id = getattr(context, "session_id", None) or "default-session"
        actor_id = payload.get("actorId", "default") or "default"

        # structured actions are deterministic and do not need the LLM
        if "action" in payload:
            yield _handle_action(payload, actor_id)
            return

        prompt, actor_id = parse_payload(payload)
        log.info(f"Invoking with session_id={session_id} and actor_id={actor_id}")
        agent = _get_agent(session_id, actor_id)

        async for event in agent.stream_async(prompt):
            if not isinstance(event, dict) or "event" not in event:
                continue
            cbs = event["event"].get("contentBlockStart")
            if cbs is not None and not cbs.get("start"):
                continue
            yield event

    return app


app = create_app()
if __name__ == "__main__":
    app.run()
