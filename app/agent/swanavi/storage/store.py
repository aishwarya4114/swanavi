"""Durable state store.

A SQLite-backed store that also runs in-memory (``:memory:``). Every entity is one
JSON row, so the eventual DynamoDB implementation can share the same schemas.
Atomic conditional writes and execution locks prevent double-booking and
overlapping recovery for the same incident.

Thread-safe via a re-entrant lock; safe for the single-process local runtime and
the monitoring engine. (DynamoDB conditional writes are the production analogue.)
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Callable, Optional

from ..domain.models import (
    Activity,
    ApprovalRequest,
    AuditEvent,
    BookingRecord,
    ExecutionLock,
    Incident,
    Itinerary,
    Observation,
    RecoveryAttempt,
    TimelineEntry,
    Traveler,
    Trip,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS travelers (traveler_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS trips (trip_id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS itineraries (itinerary_id TEXT PRIMARY KEY, trip_id TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_itin_trip ON itineraries(trip_id);
CREATE TABLE IF NOT EXISTS activities (activity_id TEXT PRIMARY KEY, trip_id TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_act_trip ON activities(trip_id);
CREATE TABLE IF NOT EXISTS bookings (booking_id TEXT PRIMARY KEY, trip_id TEXT, activity_id TEXT,
    seller_id TEXT, idempotency_key TEXT, status TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_book_trip ON bookings(trip_id);
CREATE INDEX IF NOT EXISTS idx_book_idem ON bookings(idempotency_key);
CREATE TABLE IF NOT EXISTS observations (observation_id TEXT PRIMARY KEY, trip_id TEXT, dedup_key TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_obs_trip ON observations(trip_id);
CREATE TABLE IF NOT EXISTS incidents (incident_id TEXT PRIMARY KEY, trip_id TEXT, status TEXT, dedup_key TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_inc_trip ON incidents(trip_id);
CREATE TABLE IF NOT EXISTS recovery_attempts (attempt_id TEXT PRIMARY KEY, incident_id TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_rec_inc ON recovery_attempts(incident_id);
CREATE TABLE IF NOT EXISTS approval_requests (request_id TEXT PRIMARY KEY, trip_id TEXT, status TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_appr_trip ON approval_requests(trip_id);
CREATE TABLE IF NOT EXISTS execution_locks (lock_id TEXT PRIMARY KEY, scope TEXT UNIQUE, expires_at TEXT, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_events (event_id TEXT PRIMARY KEY, trip_id TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_trip ON audit_events(trip_id);
CREATE TABLE IF NOT EXISTS timeline (entry_id TEXT PRIMARY KEY, trip_id TEXT, incident_id TEXT, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tl_trip ON timeline(trip_id);
CREATE INDEX IF NOT EXISTS idx_tl_inc ON timeline(incident_id);
"""

# Map: entity kind -> (table, pk field, from_dict class)
_ENTITIES = {
    "traveler": ("travelers", "traveler_id", Traveler),
    "trip": ("trips", "trip_id", Trip),
    "itinerary": ("itineraries", "itinerary_id", Itinerary),
    "activity": ("activities", "activity_id", Activity),
    "booking": ("bookings", "booking_id", BookingRecord),
    "observation": ("observations", "observation_id", Observation),
    "incident": ("incidents", "incident_id", Incident),
    "recovery_attempt": ("recovery_attempts", "attempt_id", RecoveryAttempt),
    "approval_request": ("approval_requests", "request_id", ApprovalRequest),
    "audit_event": ("audit_events", "event_id", AuditEvent),
    "timeline_entry": ("timeline", "entry_id", TimelineEntry),
}


class SwanaviStore:
    """SQLite/in-memory durable store with conditional writes and execution locks."""

    def __init__(self, path: Optional[str] = None):
        # ":memory:" must be shared across calls on the same connection.
        self._path = path or ":memory:"
        self._conn = sqlite3.connect(self._path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    # ------------------------------------------------------------------ low level
    def _put_json(self, table: str, pk: str, key: str, data: dict, extra_cols: dict | None = None) -> bool:
        """Insert or replace a JSON row. Returns True."""
        cols = [pk, "data"]
        vals: list[object] = [key, json.dumps(data)]
        if extra_cols:
            for col, val in extra_cols.items():
                cols.append(col)
                vals.append(val if val is not None else None)
        placeholders = ",".join("?" for _ in cols)
        col_list = ",".join(cols)
        # ON CONFLICT on the primary key replaces the row.
        sql = f"INSERT INTO {table} ({col_list}) VALUES ({placeholders}) " \
              f"ON CONFLICT({pk}) DO UPDATE SET data=excluded.data"
        for col in (extra_cols or {}):
            sql += f", {col}=excluded.{col}"
        with self._lock:
            self._conn.execute(sql, vals)
            self._conn.commit()
        return True

    def _get_json(self, table: str, pk: str, key: str) -> Optional[dict]:
        with self._lock:
            row = self._conn.execute(
                f"SELECT data FROM {table} WHERE {pk}=?", (key,)
            ).fetchone()
        return json.loads(row["data"]) if row else None

    def _list_json(self, table: str, where: str = "", params: tuple = ()) -> list[dict]:
        sql = f"SELECT data FROM {table}"
        if where:
            sql += f" WHERE {where}"
        sql += " ORDER BY rowid"
        with self._lock:
            rows = self._conn.execute(sql, params).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def _delete(self, table: str, pk: str, key: str) -> bool:
        with self._lock:
            cur = self._conn.execute(f"DELETE FROM {table} WHERE {pk}=?", (key,))
            self._conn.commit()
        return cur.rowcount > 0

    # ------------------------------------------------------------------ generic entity API
    def save(self, kind: str, obj) -> bool:
        table, pk, _ = _ENTITIES[kind]
        extra = {}
        if kind == "trip":
            pass
        elif kind == "itinerary":
            extra["trip_id"] = getattr(obj, "trip_id", None)
        elif kind == "activity":
            extra["trip_id"] = getattr(obj, "trip_id", None)
        elif kind == "booking":
            extra = {
                "trip_id": obj.trip_id, "activity_id": obj.activity_id,
                "seller_id": obj.seller_id, "idempotency_key": obj.idempotency_key,
                "status": obj.status.value,
            }
        elif kind == "observation":
            extra = {"trip_id": obj.trip_id, "dedup_key": obj.dedup_key}
        elif kind == "incident":
            extra = {"trip_id": obj.trip_id, "status": obj.status.value, "dedup_key": obj.dedup_key}
        elif kind == "recovery_attempt":
            extra = {"incident_id": obj.incident_id}
        elif kind == "approval_request":
            extra = {"trip_id": obj.trip_id, "status": obj.status.value}
        elif kind == "audit_event":
            extra = {"trip_id": obj.trip_id}
        elif kind == "timeline_entry":
            extra = {"trip_id": obj.trip_id, "incident_id": obj.incident_id}
        return self._put_json(table, pk, getattr(obj, pk), obj.to_dict(), extra)

    def get(self, kind: str, key: str):
        table, pk, cls = _ENTITIES[kind]
        data = self._get_json(table, pk, key)
        return cls.from_dict(data) if data else None

    def list(self, kind: str, trip_id: Optional[str] = None) -> list:
        table, _pk, cls = _ENTITIES[kind]
        if trip_id is not None and kind in (
            "itinerary", "activity", "booking", "observation", "incident",
            "approval_request", "audit_event", "timeline_entry",
        ):
            return [cls.from_dict(d) for d in self._list_json(table, "trip_id=?", (trip_id,))]
        return [cls.from_dict(d) for d in self._list_json(table)]

    def delete(self, kind: str, key: str) -> bool:
        table, pk, _ = _ENTITIES[kind]
        return self._delete(table, pk, key)

    # ------------------------------------------------------------------ conditional writes
    def create_booking_if_absent(self, booking: BookingRecord) -> tuple[bool, Optional[BookingRecord]]:
        """Insert a booking only if no booking with the same idempotency key exists.
        Returns (created, existing_or_created). Prevents duplicate booking requests."""
        with self._lock:
            existing = None
            if booking.idempotency_key:
                row = self._conn.execute(
                    "SELECT data FROM bookings WHERE idempotency_key=? LIMIT 1",
                    (booking.idempotency_key,),
                ).fetchone()
                if row:
                    existing = BookingRecord.from_dict(json.loads(row["data"]))
                    return False, existing
            # also prevent two active bookings for the same activity (not terminal)
            row = self._conn.execute(
                "SELECT data FROM bookings WHERE activity_id=? AND status NOT IN ('delivered','refunded','overcharged')",
                (booking.activity_id,),
            ).fetchone()
            if row:
                existing = BookingRecord.from_dict(json.loads(row["data"]))
                return False, existing
            self.save("booking", booking)
            return True, booking

    def transition_incident(
        self, incident_id: str, expected_from: list[str], new_obj: Incident
    ) -> bool:
        """Atomic incident state transition: only applies if current status is in
        expected_from. Returns True on success."""
        with self._lock:
            row = self._conn.execute(
                "SELECT status FROM incidents WHERE incident_id=?", (incident_id,)
            ).fetchone()
            if not row:
                return False
            if row["status"] not in expected_from:
                return False
            self.save("incident", new_obj)
            return True

    # ------------------------------------------------------------------ execution locks
    def acquire_lock(
        self, trip_id: str, scope: str, held_by: str, ttl_seconds: Optional[int] = None
    ) -> Optional[ExecutionLock]:
        """Acquire an execution lock for a scope (e.g. ``incident:<id>``). Returns the
        lock if acquired, None if already held (and not expired). Prevents overlapping
        recovery for the same incident."""
        from ..domain.models import new_id, utcnow
        from datetime import timedelta
        now = utcnow()
        expires = now + timedelta(seconds=ttl_seconds) if ttl_seconds else None
        lock = ExecutionLock(
            lock_id=new_id("lock"), trip_id=trip_id, scope=scope,
            held_by=held_by, acquired_at=now, expires_at=expires,
        )
        with self._lock:
            # release expired locks first
            self._conn.execute(
                "DELETE FROM execution_locks WHERE expires_at IS NOT NULL AND expires_at < ?",
                (_now_iso(),),
            )
            try:
                self._conn.execute(
                    "INSERT INTO execution_locks (lock_id, scope, expires_at, data) VALUES (?,?,?,?)",
                    (lock.lock_id, scope, expires.isoformat() if expires else None, json.dumps(lock.to_dict())),
                )
                self._conn.commit()
                return lock
            except sqlite3.IntegrityError:
                # scope is UNIQUE and already held
                return None

    def release_lock(self, lock_id: str) -> bool:
        with self._lock:
            cur = self._conn.execute("DELETE FROM execution_locks WHERE lock_id=?", (lock_id,))
            self._conn.commit()
        return cur.rowcount > 0

    def lock_held(self, scope: str) -> bool:
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM execution_locks WHERE scope=? AND (expires_at IS NULL OR expires_at >= ?)",
                (scope, _now_iso()),
            ).fetchone()
        return row is not None

    # ------------------------------------------------------------------ dedup helpers
    def observation_seen(self, trip_id: str, dedup_key: str) -> bool:
        if not dedup_key:
            return False
        with self._lock:
            row = self._conn.execute(
                "SELECT 1 FROM observations WHERE trip_id=? AND dedup_key=?", (trip_id, dedup_key)
            ).fetchone()
        return row is not None

    def open_incident_for(self, trip_id: str, dedup_key: str) -> Optional[Incident]:
        if not dedup_key:
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT data FROM incidents WHERE trip_id=? AND dedup_key=? "
                "AND status NOT IN ('resolved','dropped','escalated') LIMIT 1",
                (trip_id, dedup_key),
            ).fetchone()
        return Incident.from_dict(json.loads(row["data"])) if row else None

    # ------------------------------------------------------------------ snapshot
    def trip_state(self, trip_id: str) -> dict:
        """Return the full operational view of a trip for the Master Agent."""
        trip = self.get("trip", trip_id)
        if not trip:
            raise KeyError(f"unknown trip {trip_id}")
        itineraries = self.list("itinerary", trip_id)
        current = None
        if trip.current_itinerary_id:
            current = self.get("itinerary", trip.current_itinerary_id)
        return {
            "trip": trip.to_dict(),
            "current_itinerary": current.to_dict() if current else None,
            "itinerary_history": [i.to_dict() for i in itineraries],
            "activities": [a.to_dict() for a in self.list("activity", trip_id)],
            "bookings": [b.to_dict() for b in self.list("booking", trip_id)],
            "incidents": [i.to_dict() for i in self.list("incident", trip_id)],
            "pending_approvals": [
                a.to_dict() for a in self.list("approval_request", trip_id)
                if a.status.value == "pending"
            ],
        }

    @contextmanager
    def transaction(self):
        """Serialize a multi-write change under the store lock."""
        with self._lock:
            try:
                yield
                self._conn.commit()
            except Exception:
                self._conn.rollback()
                raise

    def close(self) -> None:
        with self._lock:
            self._conn.close()
