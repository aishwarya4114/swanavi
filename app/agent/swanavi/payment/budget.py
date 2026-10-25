"""Budget snapshot parsed from the payment server's ``GET /budget`` response.

Holds the fields the dashboard shows and the logic the booker uses to decide
whether new bookings are allowed (drift, spend ceiling, kill switch).
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Optional


def _d(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except Exception:
        return None


@dataclass
class BudgetSnapshot:
    version: int
    currency: str
    mode: str                       # "mock" | "ap4m"
    live: bool
    badge: str                       # "LIVE" | "MOCK"
    source: str                      # "memory" | "chain"
    total: Decimal
    remaining: Decimal
    reserved: Decimal
    spent: Decimal
    refunded_total: Decimal
    max_booking: Decimal
    spend_ceiling: Decimal
    killed: bool
    trip: Optional[dict] = None
    fund: Optional[dict] = None
    drift: Optional[dict] = None

    @classmethod
    def from_budget(cls, body: dict) -> "BudgetSnapshot":
        return cls(
            version=int(body.get("version", 3)),
            currency=body.get("currency", "RLUSD"),
            mode=body.get("mode", "mock"),
            live=bool(body.get("live", False)),
            badge=body.get("badge", "MOCK"),
            source=body.get("source", "memory"),
            total=_d(body.get("total")) or Decimal("0"),
            remaining=_d(body.get("remaining")) or Decimal("0"),
            reserved=_d(body.get("reserved")) or Decimal("0"),
            spent=_d(body.get("spent")) or Decimal("0"),
            refunded_total=_d(body.get("refundedTotal")) or Decimal("0"),
            max_booking=_d(body.get("maxBooking")) or Decimal("4"),
            spend_ceiling=_d(body.get("spendCeiling")) or Decimal("6"),
            killed=bool(body.get("killed", False)),
            trip=body.get("trip"),
            fund=body.get("fund"),
            drift=body.get("drift"),
        )

    @property
    def has_drift(self) -> bool:
        """When local bookings disagree with the chain, new bookings must stop."""
        return self.drift is not None

    @property
    def can_book(self) -> bool:
        """The booker's gate: not killed, not drifted, and there is remaining budget."""
        if self.killed or self.has_drift:
            return False
        return self.remaining > 0

    @property
    def chain_unavailable(self) -> bool:
        return self.mode == "ap4m" and self.source == "memory" and not self.live

    def to_dict(self) -> dict:
        def fmt(v: Optional[Decimal]) -> Optional[str]:
            return str(v) if v is not None else None
        return {
            "version": self.version,
            "currency": self.currency,
            "mode": self.mode,
            "live": self.live,
            "badge": self.badge,
            "source": self.source,
            "total": fmt(self.total),
            "remaining": fmt(self.remaining),
            "reserved": fmt(self.reserved),
            "spent": fmt(self.spent),
            "refundedTotal": fmt(self.refunded_total),
            "maxBooking": fmt(self.max_booking),
            "spendCeiling": fmt(self.spend_ceiling),
            "killed": self.killed,
            "trip": self.trip,
            "fund": self.fund,
            "drift": self.drift,
        }
