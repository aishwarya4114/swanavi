"""Local dashboard API. Listens on 127.0.0.1 only.

Offline trip actions use the in-process fake payment server and are labeled
OFFLINE. Remote Mastercard calls are reads: health, budget, and one known
escrow. This process never creates, releases, or refunds a payment.
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Optional

from .live import LiveBoard, LiveError
from .cli import _build_orchestrator
from .config import DEFAULT_PAYMENT_URL, load_config
from .domain.enums import ActivityType
from .domain.models import Activity, Itinerary, new_id
from .envfile import load_local_env
from .payment.client import MastercardClient
from .payment.errors import PaymentError, PaymentTimeout

_SECRET_KEYS = {
    "token", "payment_token", "authorization", "x-swanavi-token",
    "cf-access-client-id", "cf-access-client-secret", "password", "secret",
}


class Desk:
    def __init__(self):
        self.orch = None
        self.trip_id: Optional[str] = None
        self.outdoor = None
        self.owner: Optional[str] = None
        self.simulated_rain = False
        self.live = LiveBoard()

    def plan(self, actor: str) -> dict:
        orch, _server = _build_orchestrator(use_fake=True)
        orch.create_traveler(actor, "Ada Lovelace")
        trip = orch.create_trip(actor, title="NYC weekend", destination="New York", budget_rlusd="19")
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
        orch.weather_source.set(
            f"latlng:{outdoor.lat},{outdoor.lng}",
            {"condition": "clear", "severity": "low", "precip_mm": 0},
        )
        _timeline(orch, trip.trip_id, "agent_delegated",
                  "Master Agent delegated NYC planning to the Planner Agent.")
        _timeline(orch, trip.trip_id, "itinerary_ready",
                  "Planner Agent proposed an outdoor Central Park bike rental. This is not a reservation yet.")
        _timeline(orch, trip.trip_id, "agent_delegated",
                  "Master Agent delegated the outdoor offer to the Booking Agent.")
        booking = orch.lock_activity(trip.trip_id, outdoor.activity_id, "central-park-bikes", "0.15")
        outdoor.booking_id = booking["booking_id"]
        orch.store.save("activity", outdoor)
        self.orch = orch
        self.trip_id = trip.trip_id
        self.outdoor = outdoor
        self.owner = actor
        self.simulated_rain = False
        return self.view(actor)

    def rain(self, actor: str) -> dict:
        self._owned(actor)
        outdoor = self.outdoor
        orch = self.orch
        orch.weather_source.set(
            f"latlng:{outdoor.lat},{outdoor.lng}",
            {"condition": "rain", "severity": "moderate", "precip_mm": 2.0},
        )
        self.simulated_rain = True
        tick = orch.run_monitoring_tick(self.trip_id, emit=False)
        incidents = orch.store.list("incident", self.trip_id)
        if incidents and incidents[0].status.value not in {"resolved", "dropped"}:
            orch.handle_incident(incidents[0].incident_id)
        view = self.view(actor)
        view["monitoring"] = {k: tick.get(k) for k in ("observations", "new_incidents")}
        return view

    def view(self, actor: str) -> dict:
        if self.trip_id is None:
            return {
                "transport": "OFFLINE",
                "payment_badge": "MOCK",
                "weather": {"kind": "NONE", "note": "No simulated weather has been applied."},
                "trip": None,
                "activities": [],
                "bookings": [],
                "budget": None,
                "incidents": [],
                "pending_approvals": [],
                "timeline": [],
                "trip_health": "empty",
                "summary": {},
                "honesty": "Offline demo has not been started. No Mastercard call was made.",
            }
        self._owned(actor)
        dash = self.orch.trip_dashboard(self.trip_id)
        activities = [a.to_dict() for a in self.orch.store.list("activity", self.trip_id)]
        bookings = dash["bookings"]
        delivered = [b for b in bookings if b["status"] == "delivered"]
        refunded = [b for b in bookings if b["status"] == "refunded"]
        attempts = [a.to_dict() for a in self.orch.store.list("recovery_attempt")
                    if a.trip_id == self.trip_id]
        additional = next((a.get("additional_cost") for a in attempts if a.get("additional_cost")), None)
        return {
            "transport": "OFFLINE",
            "payment_badge": "MOCK",
            "payment_mode": "mock",
            "weather": {
                "kind": "SIMULATED" if self.simulated_rain else "NONE",
                "note": "Scripted rain demonstration. This is not a live forecast.",
            },
            "aws": {"deployed": False, "runtime_endpoint": None},
            "trip": dash["trip"],
            "activities": activities,
            "bookings": [_public_booking(b) for b in bookings],
            "budget": dash["budget"],
            "incidents": dash["incidents"],
            "pending_approvals": dash["pending_approvals"],
            "timeline": dash["timeline"],
            "trip_health": dash["trip_health"],
            "summary": {
                "additional_cost": additional,
                "delivered": len(delivered),
                "refunded": len(refunded),
                "resolution": dash["incidents"][-1]["status"] if dash["incidents"] else None,
            },
            "honesty": (
                "OFFLINE in-process fake. Badge MOCK means no blockchain transaction. "
                "The outdoor-to-indoor replacement is not the remote hotel escrow."
            ),
        }

    def _owned(self, actor: str) -> None:
        if self.owner != actor:
            raise PermissionError("cross_trip")


def remote_read() -> dict:
    """Read health, budget, and the saved escrow. Never writes."""
    load_local_env()
    cfg = load_config()
    if not cfg.payment_token or not cfg.payment_url or cfg.payment_url == DEFAULT_PAYMENT_URL:
        return {"configured": False, "mutated": False}
    client = MastercardClient(cfg)
    try:
        health = client.get_health()
    except (PaymentError, PaymentTimeout) as exc:
        return {"configured": True, "mutated": False, "error": exc.code}
    if not isinstance(health, dict):
        return {"configured": True, "mutated": False, "error": "malformed"}
    halted = not (health.get("mode") == "mock" and health.get("live") is False and health.get("badge") == "MOCK")
    result = {
        "configured": True,
        "mutated": False,
        "halted": halted,
        "health": {k: health.get(k) for k in ("ok", "mode", "live", "badge", "network", "service", "version")},
    }
    if halted:
        return result
    try:
        budget = client.get_budget()
        result["budget"] = _public_budget(budget)
    except (PaymentError, PaymentTimeout) as exc:
        result["budget_error"] = exc.code
    escrow_id = _saved_escrow_id()
    if escrow_id:
        try:
            escrow = client.get_status(escrow_id)
            result["escrow"] = _public_escrow(escrow)
        except (PaymentError, PaymentTimeout) as exc:
            result["escrow_error"] = exc.code
            result["escrow_id"] = escrow_id
    return result


def _saved_escrow_id() -> Optional[str]:
    for parent in __import__("pathlib").Path(__file__).resolve().parents:
        path = parent / "agentcore" / ".last-mock-escrow.json"
        if path.is_file():
            try:
                data = json.loads(path.read_text())
            except (OSError, json.JSONDecodeError):
                return None
            escrow_id = data.get("escrowId") if isinstance(data, dict) else None
            return escrow_id if isinstance(escrow_id, str) else None
    return None


def _public_budget(body: dict) -> dict:
    keys = (
        "currency", "mode", "live", "badge", "source", "total", "remaining",
        "reserved", "spent", "refundedTotal", "maxBooking", "spendCeiling",
        "killed", "drift",
    )
    return {k: body.get(k) for k in keys}


def _public_escrow(body: dict) -> dict:
    keys = (
        "escrowId", "sellerId", "amount", "finalBill", "status", "badge",
        "live", "mode", "txHash", "explorerUrl", "reason", "chainStatus",
    )
    out = {k: body.get(k) for k in keys}
    live = out.get("badge") == "LIVE" and out.get("chainStatus") == "confirmed" and out.get("explorerUrl")
    out["receipt_url"] = out.get("explorerUrl") if live else None
    return out


def _public_booking(booking: dict) -> dict:
    evidence = booking.get("evidence") or {}
    live = (
        evidence.get("badge") == "LIVE"
        and evidence.get("chain_status") == "confirmed"
        and evidence.get("explorer_url")
    )
    booking = dict(booking)
    booking["receipt_url"] = evidence.get("explorer_url") if live else None
    return booking


def _timeline(orch, trip_id: str, step: str, message: str) -> None:
    from .domain.models import TimelineEntry
    orch.store.save("timeline_entry", TimelineEntry(
        entry_id=new_id("tl"), trip_id=trip_id, incident_id=None,
        step=step, message=message,
    ))


def _scrub(value):
    if isinstance(value, dict):
        return {
            k: ("***" if k.lower() in _SECRET_KEYS else _scrub(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_scrub(item) for item in value]
    if isinstance(value, str):
        token = os.getenv("SWANAVI_PAYMENT_TOKEN") or os.getenv("SWANAVI_TOKEN") or ""
        if token and token in value:
            return value.replace(token, "***")
    return value


class ApiError(Exception):
    def __init__(self, status: int, code: str):
        self.status = status
        self.code = code


def _live_route(path: str):
    prefix = "/api/live/runs"
    if path == prefix:
        return ("create", None, None)
    if not path.startswith(prefix + "/"):
        return None
    parts = path[len(prefix) + 1:].split("/")
    if len(parts[0]) != 20 or not parts[0].startswith("run_"):
        return ("bad", None, None)
    run_id = parts[0]
    tail = parts[1:]
    if not tail:
        return ("run", run_id, None)
    if tail == ["events"]:
        return ("events", run_id, None)
    if tail == ["nova"]:
        return ("nova", run_id, None)
    if tail == ["booking", "prepare"]:
        return ("prepare", run_id, None)
    if tail == ["booking", "approve"]:
        return ("approve", run_id, None)
    if len(tail) == 2 and tail[0] == "disruptions" and tail[1] in {"rain", "overcharge", "timeout", "rebook"}:
        return ("disruption", run_id, tail[1])
    return ("bad", None, None)


def make_handler(desk: Desk):
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            path = urlparse(self.path).path
            try:
                live = _live_route(path)
                if path == "/api/meta":
                    self._send(200, {
                        "service": "swanavi-desk",
                        "binds": "127.0.0.1",
                        "mutations": False,
                        "payment_writes": "approval-required",
                    })
                elif path == "/api/dashboard":
                    self._send(200, {"offline": desk.view(self._actor()), "mastercard": remote_read()})
                elif live and live[0] == "run":
                    self._send(200, {"run": desk.live.get(live[1])})
                elif live and live[0] == "events":
                    self._stream(live[1])
                elif live:
                    self._send(404, {"error": "not_found"})
                else:
                    self._send(404, {"error": "not_found"})
            except LiveError as exc:
                self._send(exc.status, {"error": exc.code})
            except PermissionError:
                self._send(403, {"error": "cross_trip"})
            except Exception as exc:
                self._send(500, {"error": "internal", "type": type(exc).__name__})

        def do_POST(self):
            path = urlparse(self.path).path
            try:
                actor = self._actor()
                live = _live_route(path)
                body = self._json()
                if path == "/api/demo/plan":
                    self._send(200, {"offline": desk.plan(actor), "mastercard": remote_read()})
                elif path == "/api/demo/rain":
                    self._send(200, {"offline": desk.rain(actor), "mastercard": remote_read()})
                elif path == "/api/remote/read":
                    self._send(200, {"mastercard": remote_read()})
                elif live and live[0] == "create":
                    self._send(201, {"run": desk.live.create(body), "mutated": False})
                elif live and live[0] == "nova":
                    self._send(200, {"run": desk.live.record_nova(live[1], body), "mutated": False})
                elif live and live[0] == "prepare":
                    status, payload = desk.live.prepare_booking(live[1], body, remote_read())
                    self._send(status, payload)
                elif live and live[0] == "approve":
                    from .live import remote_payment_client
                    status, payload = desk.live.approve_booking(live[1], body, remote_payment_client())
                    self._send(status, payload)
                elif live and live[0] == "disruption":
                    self._send(200, {"run": desk.live.simulate(live[1], live[2]), "mutated": False})
                else:
                    self._send(404, {"error": "not_found"})
            except LiveError as exc:
                self._send(exc.status, {"error": exc.code, "mutated": False})
            except PermissionError:
                self._send(403, {"error": "cross_trip"})
            except Exception as exc:
                self._send(500, {"error": "internal", "type": type(exc).__name__})

        def _stream(self, run_id: str) -> None:
            once = "once=1" in urlparse(self.path).query
            desk.live.events(run_id)
            self.close_connection = False
            self.protocol_version = "HTTP/1.1"
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            sent = 0
            deadline = time.monotonic() + (0 if once else 50)
            try:
                while True:
                    events = desk.live.events(run_id)
                    for event in events[sent:]:
                        self._chunk(f"id: {event['event_id']}\ndata: {json.dumps(_scrub(event))}\n\n")
                        sent += 1
                    if once or time.monotonic() >= deadline:
                        break
                    self._chunk(": ping\n\n")
                    desk.live.wait(1)
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                return

        def _chunk(self, text: str) -> None:
            data = text.encode("utf-8")
            self.wfile.write(f"{len(data):x}\r\n".encode("ascii"))
            self.wfile.write(data)
            self.wfile.write(b"\r\n")
            self.wfile.flush()

        def _json(self) -> dict:
            length = int(self.headers.get("Content-Length") or "0")
            if length <= 0:
                return {}
            if length > 16384:
                raise LiveError(413, "body_too_large")
            try:
                data = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
            except (UnicodeDecodeError, json.JSONDecodeError):
                raise LiveError(400, "invalid_json")
            if not isinstance(data, dict):
                raise LiveError(400, "invalid_json")
            return data

        def _actor(self) -> str:
            return self.headers.get("X-Swanavi-Actor") or "traveler_ada"

        def _send(self, status: int, payload: dict) -> None:
            raw = json.dumps(_scrub(payload)).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, fmt, *args):
            return

    return Handler


def serve(host: str = "127.0.0.1", port: int = 8791) -> None:
    if host not in {"127.0.0.1", "localhost"}:
        raise RuntimeError("The dashboard API must bind to loopback.")
    server = ThreadingHTTPServer((host, port), make_handler(Desk()))
    print(f"swanavi desk http://{host}:{port}")
    server.serve_forever()


def main() -> None:
    serve(os.getenv("SWANAVI_API_HOST", "127.0.0.1"), int(os.getenv("SWANAVI_API_PORT", "8791")))


if __name__ == "__main__":
    main()
