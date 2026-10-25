"""Read-only probe of the configured Mastercard HTTP server.

Does not create, release, or refund an escrow. A separate ``escrow`` subcommand
exists for the approved hotel workflow and refuses to run unless
``SWANAVI_ALLOW_MOCK_ESCROW=1``.

The token is read from the environment and is never printed.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Optional
from urllib.parse import urlparse

from ..config import DEFAULT_PAYMENT_URL, load_config
from .client import MastercardClient
from .errors import PaymentError, PaymentTimeout


def _host(url: str) -> str:
    parsed = urlparse(url)
    return parsed.hostname or "(unset)"


def _require_remote_config():
    cfg = load_config()
    if not cfg.payment_token:
        print("SWANAVI_PAYMENT_TOKEN is not set. Refusing to call the payment API.")
        return None
    if not cfg.payment_url or cfg.payment_url == DEFAULT_PAYMENT_URL:
        if os.getenv("SWANAVI_ALLOW_LOCAL_PAYMENT") != "1":
            print("SWANAVI_PAYMENT_URL is not set to a remote payment server. Refusing to call.")
            return None
    print(f"payment_host={_host(cfg.payment_url)} token_configured=true")
    return cfg


def _public_budget(body: dict) -> dict:
    keys = (
        "version", "currency", "mode", "live", "badge", "source",
        "total", "remaining", "reserved", "spent", "refundedTotal",
        "maxBooking", "spendCeiling", "killed", "drift",
    )
    return {k: body.get(k) for k in keys}


def check_read_only() -> int:
    """Authenticated GET /health, then GET /budget. No mutations."""
    cfg = _require_remote_config()
    if cfg is None:
        return 2
    client = MastercardClient(cfg)
    try:
        health = client.get_health()
    except PaymentTimeout as exc:
        print(f"health=timeout code={exc.code}")
        return 3
    except PaymentError as exc:
        print(f"health=error code={exc.code} http={exc.http_status}")
        return 3
    if not isinstance(health, dict):
        print("health=malformed")
        return 3
    print("health=" + json.dumps({
        "ok": health.get("ok"),
        "mode": health.get("mode"),
        "live": health.get("live"),
        "badge": health.get("badge"),
        "network": health.get("network"),
        "version": health.get("version"),
    }))
    try:
        budget = client.get_budget()
    except PaymentTimeout as exc:
        print(f"budget=timeout code={exc.code}")
        return 4
    except PaymentError as exc:
        print(f"budget=error code={exc.code} http={exc.http_status}")
        return 4
    if not isinstance(budget, dict):
        print("budget=malformed")
        return 4
    print("budget=" + json.dumps(_public_budget(budget)))
    return 0


def authorized_hotel_escrow() -> int:
    """Create one hotel escrow and release that same id. Requires an explicit flag.

    If release times out, the original escrow is re-read. A second escrow is not
    created.
    """
    if os.getenv("SWANAVI_ALLOW_MOCK_ESCROW") != "1":
        print("Refusing POST /escrows. SWANAVI_ALLOW_MOCK_ESCROW is not 1.")
        return 2
    cfg = _require_remote_config()
    if cfg is None:
        return 2
    client = MastercardClient(cfg)
    try:
        created = client.create_escrow("hotel", "4", 600)
    except PaymentError as exc:
        print(f"create=error code={exc.code} http={exc.http_status}")
        return 3
    escrow_id = created.get("escrowId") if isinstance(created, dict) else None
    if not escrow_id:
        print("create=malformed missing escrowId")
        return 3
    print(f"escrow_id={escrow_id} create_status={created.get('status')} badge={created.get('badge')}")
    try:
        released = client.release(escrow_id)
        print(f"release_status={released.get('status')} badge={released.get('badge')} live={released.get('live')}")
    except (PaymentTimeout, PaymentError) as exc:
        code = getattr(exc, "code", "timeout")
        print(f"release=uncertain code={code}; reconciling the same escrow")
        try:
            current = client.get_status(escrow_id)
        except PaymentError as status_exc:
            print(f"reconcile=error code={status_exc.code}")
            return 4
        print(f"reconcile_status={current.get('status')} escrow_id={current.get('escrowId')}")
    budget = client.get_budget()
    status = client.get_status(escrow_id)
    print("budget=" + json.dumps(_public_budget(budget)))
    print(f"final_status={status.get('status')} escrow_id={status.get('escrowId')} badge={status.get('badge')}")
    if status.get("escrowId") != escrow_id:
        print("reconcile=escrow id changed; refusing to continue")
        return 5
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    from ..envfile import load_local_env
    load_local_env()
    argv = list(argv if argv is not None else sys.argv[1:])
    cmd = argv[0] if argv else "check"
    if cmd == "check":
        return check_read_only()
    if cmd == "escrow":
        return authorized_hotel_escrow()
    print("usage: python -m swanavi.payment.probe [check|escrow]")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
