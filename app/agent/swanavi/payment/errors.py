"""Payment errors mapped from the Mastercard AP4M server contract.

The server returns JSON ``{ error, message, ...details }`` with an HTTP status.
We normalise that into a :class:`PaymentError` carrying the stable ``code`` (the
server's ``error`` field) plus an ``http_status`` and the raw details, so the
booker and recovery policies can branch on the documented error codes (the same
codes used in API.md) rather than on HTTP statuses alone.
"""

from __future__ import annotations

from typing import Any, Optional


# HTTP status -> the default error code the server uses for that status. The real
# code comes from the body's ``error`` field; this is only a fallback.
_STATUS_DEFAULT = {
    400: "bad_request",
    401: "unauthorized",
    404: "not_found",
    409: "invalid_state",
    502: "seller_unavailable",
    503: "chain_unavailable",
}


class PaymentError(Exception):
    """A payment-server failure, normalised to the documented error codes."""

    def __init__(self, code: str, message: str, http_status: int = 0, details: Optional[dict] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status
        self.details = details or {}

    def __str__(self) -> str:
        return f"{self.code}: {self.message}"

    @classmethod
    def from_response(cls, status: int, body: Any) -> "PaymentError":
        if isinstance(body, dict) and body.get("error"):
            return cls(
                code=str(body["error"]),
                message=str(body.get("message", body["error"])),
                http_status=status,
                details={k: v for k, v in body.items() if k not in ("error", "message")},
            )
        return cls(
            code=_STATUS_DEFAULT.get(status, "internal"),
            message=f"HTTP {status}" + (f": {body}" if body else ""),
            http_status=status,
            details={"body": body} if body else {},
        )


class PaymentTimeout(PaymentError):
    def __init__(self, message: str = "Payment server timed out"):
        super().__init__("timeout", message, http_status=0)


# Convenience flags for policy branching.
REFUSAL_CODES = {
    "over_budget", "amount_limit", "spend_ceiling", "killed", "channel_closed",
    "invalid_state", "seller_cancelled", "seller_failed", "overcharged", "over_cap",
    "live_mode", "in_progress",
}
AMBIGUOUS_CODES = {"redeem_unconfirmed"}     # payment may be on chain; preserve escrow id
CHAIN_DOWN_CODES = {"chain_unavailable", "redeem_failed", "seller_unavailable", "close_failed"}
BUDGET_STOP_CODES = {"over_budget", "amount_limit", "spend_ceiling", "over_cap", "killed"}


def is_refusal(err: PaymentError) -> bool:
    return err.code in REFUSAL_CODES


def is_ambiguous_payment(err: PaymentError) -> bool:
    return err.code in AMBIGUOUS_CODES


def is_budget_stop(err: PaymentError) -> bool:
    return err.code in BUDGET_STOP_CODES
