"""Remote Mastercard route allowlist.

The in-process fake payment server used by offline tests is not subject to this
module. :class:`swanavi.payment.client.UrllibTransport` calls
:func:`assert_remote_allowed` before any socket is opened, so the agent cannot
reach administrative or undocumented routes on a real HTTP server.

Confirmed remote operations are the seven routes below. Seller locks on that
transport are limited to the four base sellers the payment server documents
(hotel, tour, cab, food).
"""

from __future__ import annotations

import re
from typing import Optional

from .errors import PaymentError


REMOTE_SELLERS = frozenset({"hotel", "tour", "cab", "food"})

_ESCROW_ID = re.compile(r"^escrow_[A-Za-z0-9_-]{1,128}$")

# (method, regex) — path is normalized and has no query string.
_ALLOWED = (
    ("GET", re.compile(r"^/health$")),
    ("GET", re.compile(r"^/budget$")),
    ("GET", re.compile(r"^/trip$")),
    ("POST", re.compile(r"^/escrows$")),
    ("GET", re.compile(r"^/escrows/(escrow_[A-Za-z0-9_-]{1,128})$")),
    ("POST", re.compile(r"^/escrows/(escrow_[A-Za-z0-9_-]{1,128})/release$")),
    ("POST", re.compile(r"^/escrows/(escrow_[A-Za-z0-9_-]{1,128})/refund$")),
)


def normalize_payment_path(path: str) -> str:
    """Return a canonical path or raise ``forbidden_route``.

    Query strings, fragments, traversal, and encoded separators are refused so
    the adapter cannot be turned into an open proxy.
    """
    if not isinstance(path, str) or not path:
        raise PaymentError("forbidden_route", "Payment path is missing.", 403)
    if path.startswith("//") or "\\" in path or ".." in path:
        raise PaymentError("forbidden_route", "Payment path was refused.", 403)
    lowered = path.lower()
    if "%" in path and any(token in lowered for token in ("%2f", "%5c", "%2e", "%00")):
        raise PaymentError("forbidden_route", "Encoded payment path was refused.", 403)
    if "?" in path or "#" in path:
        raise PaymentError("forbidden_route", "Payment query strings are not used by the adapter.", 403)
    if not path.startswith("/"):
        raise PaymentError("forbidden_route", "Payment path was refused.", 403)
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    return path


def assert_remote_allowed(method: str, path: str, body: Optional[dict] = None) -> str:
    """Raise ``PaymentError(forbidden_route)`` when the remote call is not allowed.

    Returns the normalized path when the call may proceed.
    """
    method = (method or "").upper()
    normalized = normalize_payment_path(path)
    if method not in {"GET", "POST"}:
        raise PaymentError("forbidden_route", f"{method or 'UNKNOWN'} is not a payment-adapter method.", 403)
    matched = False
    for allowed_method, pattern in _ALLOWED:
        if method == allowed_method and pattern.match(normalized):
            matched = True
            break
    if not matched:
        raise PaymentError(
            "forbidden_route",
            "That payment route is outside the agent allowlist.",
            403,
        )
    if method == "POST" and normalized == "/escrows":
        seller = (body or {}).get("sellerId") if isinstance(body, dict) else None
        if seller not in REMOTE_SELLERS:
            raise PaymentError(
                "forbidden_route",
                "Remote escrow is limited to the confirmed sellers hotel, tour, cab, and food.",
                403,
            )
    return normalized


def escrow_id_from_path(path: str) -> Optional[str]:
    normalized = normalize_payment_path(path)
    parts = [p for p in normalized.split("/") if p]
    if len(parts) >= 2 and parts[0] == "escrows" and _ESCROW_ID.match(parts[1]):
        return parts[1]
    return None
