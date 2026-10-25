"""Observability: correlation ids and structured audit, OpenTelemetry-ready.

Provides a correlation id linking trip → incident → escrow across agent
invocations, specialist delegations, gateway tool calls, monitoring ticks, and
booking transitions — without ever embedding secrets or payment credentials.
The OTel spans are emitted only when the OpenTelemetry SDK is configured (the
runtime already pulls in ``aws-opentelemetry-distro``); in local mode we fall
back to structured log lines so observability works with no extra setup.
"""

from __future__ import annotations

import logging
import uuid
from contextlib import contextmanager
from typing import Optional

log = logging.getLogger("swanavi")

try:
    from opentelemetry import trace  # type: ignore
    _tracer = trace.get_tracer("swanavi")
except Exception:  # pragma: no cover - OTel optional in local mode
    _tracer = None


def new_correlation_id() -> str:
    return f"corr_{uuid.uuid4().hex[:16]}"


@contextmanager
def span(name: str, trip_id: Optional[str] = None, correlation_id: Optional[str] = None,
         **attrs):
    """Emit an OTel span when configured; otherwise a structured log line.
    Never logs secret values (token, keys) — only ids and outcomes."""
    cid = correlation_id or new_correlation_id()
    payload = {"span": name, "trip_id": trip_id, "correlation_id": cid, **attrs}
    if _tracer is not None:
        with _tracer.start_as_current_span(name) as s:
            for k, v in attrs.items():
                if v is not None:
                    s.set_attribute(f"swanavi.{k}", str(v))
            if trip_id:
                s.set_attribute("swanavi.trip_id", trip_id)
            s.set_attribute("swanavi.correlation_id", cid)
            yield cid
    else:
        log.info("span %s", payload)
        yield cid


def emit_audit(store, trip_id: Optional[str], correlation_id: Optional[str],
               role: str, action: str, outcome: str, details: dict) -> None:
    """Persist a structured audit event with the correlation id."""
    from ..domain.enums import AgentRole
    from ..domain.models import AuditEvent, new_id
    try:
        role_enum = AgentRole(role) if role in AgentRole.__members__.values() else AgentRole.MASTER
    except ValueError:
        role_enum = AgentRole.MASTER
    if store is not None:
        store.save("audit_event", AuditEvent(
            event_id=new_id("evt"), trip_id=trip_id, correlation_id=correlation_id,
            role=role_enum, action=action, outcome=outcome, details=_safe(details),
        ))


def _safe(details: dict) -> dict:
    """Strip anything that looks like a credential before audit/logging."""
    redact = {"token", "authorization", "x-swanavi-token", "private_key",
              "agent_private_key", "password", "secret"}
    return {k: ("***" if k.lower() in redact else v) for k, v in details.items()}
