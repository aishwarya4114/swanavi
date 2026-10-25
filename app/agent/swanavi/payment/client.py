"""Mastercard AP4M payment client.

A thin HTTP adapter around the protected payment server (``payments.mjs`` /
``server.mjs`` / ``ap4m_executor.mjs``, which we never modify). The transport is
injectable so tests run with no network and no keys. The token is read from the
config (env only) and sent as ``X-Swanavi-Token``; it is never logged.

This client never signs anything, never opens a channel, never reads wallet
keys — all of that lives in the protected server. It only calls the documented
HTTP routes.
"""

from __future__ import annotations

import json as _json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional, Protocol

from ..config import SwanaviConfig
from .errors import PaymentError, PaymentTimeout

log = logging.getLogger("swanavi.payment")


class Transport(Protocol):
    """A minimal HTTP transport. Tests inject a fake; the default uses urllib."""

    def request(
        self, base_url: str, method: str, path: str, body: Optional[dict],
        headers: dict, timeout: float,
    ) -> tuple[int, Any]:
        """Return (http_status, parsed_json_or_raw_body). Raise on transport errors."""


class UrllibTransport:
    """Stdlib HTTP transport with the remote route allowlist.

    GET /health, /budget, /trip, and /escrows/{id} may retry after a connection
    failure. POST is never retried: an uncertain create or release is reconciled
    by reading the original escrow, not by creating another one.
    """

    def __init__(self, get_attempts: int = 3, retry_backoff_seconds: float = 0.05):
        self.get_attempts = max(1, int(get_attempts))
        self.retry_backoff_seconds = max(0.0, float(retry_backoff_seconds))

    def request(self, base_url, method, path, body, headers, timeout):
        from .allowlist import assert_remote_allowed
        assert_remote_allowed(method, path, body)
        attempts = self.get_attempts if (method or "").upper() == "GET" else 1
        last: Optional[Exception] = None
        for attempt in range(attempts):
            try:
                return self._once(base_url, method, path, body, headers, timeout)
            except PaymentTimeout as exc:
                last = exc
            except PaymentError as exc:
                if exc.code != "unreachable":
                    raise
                last = exc
            if attempt + 1 < attempts and self.retry_backoff_seconds:
                time.sleep(self.retry_backoff_seconds)
        assert last is not None
        raise last

    def _once(self, base_url, method, path, body, headers, timeout):
        url = base_url.rstrip("/") + path
        data = None
        outgoing = dict(headers)
        if body is not None:
            data = _json.dumps(body).encode("utf-8")
            outgoing["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=outgoing)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
                status = resp.status
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8") if exc.fp else ""
            status = exc.code
        except urllib.error.URLError as exc:
            raise PaymentError("unreachable", "payment server unreachable") from exc
        except TimeoutError as exc:
            raise PaymentTimeout() from exc
        log.info("payment_http method=%s path=%s status=%s", method, path.split("?")[0], status)
        return status, _parse_body(raw)


def _parse_body(raw: str) -> Any:
    if not raw:
        return None
    try:
        return _json.loads(raw)
    except _json.JSONDecodeError:
        return raw


class MastercardClient:
    """HTTP adapter for the Mastercard AP4M payment server."""

    def __init__(self, config: SwanaviConfig, transport: Optional[Transport] = None):
        self._config = config
        self._transport = transport or UrllibTransport()

    # ------------------------------------------------------------------ internals
    def _headers(self) -> dict:
        h = {}
        if self._config.payment_token:
            h["X-Swanavi-Token"] = self._config.payment_token
        return h

    def _call(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        try:
            status, data = self._transport.request(
                self._config.payment_url, method, path, body,
                self._headers(), self._config.request_timeout_seconds,
            )
        except PaymentError:
            raise
        except Exception as exc:  # network/parse errors -> timeout-style
            raise PaymentError("timeout", f"payment call failed: {exc}") from exc

        if status >= 400:
            raise PaymentError.from_response(status, data)
        if not isinstance(data, dict):
            raise PaymentError("internal", f"unexpected non-JSON response: {data!r}", status)
        return data

    # ------------------------------------------------------------------ agent-safe ops
    def create_escrow(self, seller_id: str, amount: str, deadline_seconds: int) -> dict:
        return self._call("POST", "/escrows", {
            "sellerId": seller_id, "amount": amount, "deadlineSeconds": deadline_seconds,
        })

    def release(self, escrow_id: str, final_bill: Optional[str] = None) -> dict:
        body: dict = {}
        if final_bill is not None:
            body["finalBill"] = final_bill
        return self._call("POST", f"/escrows/{escrow_id}/release", body)

    def refund(self, escrow_id: str) -> dict:
        return self._call("POST", f"/escrows/{escrow_id}/refund", {})

    def finish(self, escrow_id: str) -> dict:
        return self._call("POST", f"/escrows/{escrow_id}/finish", {})

    def get_status(self, escrow_id: str) -> dict:
        return self._call("GET", f"/escrows/{escrow_id}")

    def list_escrows(self) -> dict:
        return self._call("GET", "/escrows")

    def get_budget(self) -> dict:
        return self._call("GET", "/budget")

    # ------------------------------------------------------------------ read-only discovery
    def get_health(self) -> dict:
        return self._call("GET", "/health")

    def list_merchants(self) -> dict:
        return self._call("GET", "/merchants")

    def get_merchant(self, seller_id: str) -> dict:
        return self._call("GET", f"/merchants/{seller_id}")

    def get_trip(self) -> dict:
        return self._call("GET", "/trip")

    def list_stores(self, city: Optional[str] = None, category: Optional[str] = None) -> dict:
        params = []
        if city:
            params.append(f"city={urllib.parse.quote(city)}")
        if category:
            params.append(f"category={category}")
        qs = ("?" + "&".join(params)) if params else ""
        return self._call("GET", f"/stores{qs}")

    def search_catalog(self, store_id: str, query: Optional[str] = None) -> dict:
        qs = f"?query={urllib.parse.quote(query)}" if query else ""
        return self._call("GET", f"/stores/{store_id}/catalog{qs}")

    def get_store_quote(self, store_id: str, sku: str) -> dict:
        return self._call("POST", f"/stores/{store_id}/quote", {"sku": sku})

    # ------------------------------------------------------------------ NOT agent-exposed
    # These exist on the client because the booker/operator may use them, but they
    # are deliberately NOT wrapped as autonomous agent tools (see agents/tools.py).
    def fund(self, method: str, amount: str) -> dict:
        return self._call("POST", "/fund", {"method": method, "amount": amount})

    def set_kill_switch(self, enabled: bool) -> dict:
        return self._call("POST", "/kill-switch", {"enabled": enabled})

    def close_trip(self) -> dict:
        return self._call("POST", "/trip/close", {})

    def set_merchant_switch(self, seller_id: str, outcome: str, final_bill: Optional[str] = None) -> dict:
        body = {"outcome": outcome}
        if final_bill is not None:
            body["finalBill"] = final_bill
        return self._call("POST", f"/merchants/{seller_id}/switch", body)

