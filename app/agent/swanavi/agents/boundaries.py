"""Tool-permission boundaries and authorization scoping.

The Master Agent delegates to specialists but never bypasses their scope. A
traveler's authorization scope (per-trip budget, allowed sellers, preauthorized
recovery cost) is associated with their trip and checked before any binding
action. These are code-level checks that complement (not replace) Cedar policies
at the Gateway.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import Decimal
from typing import Optional

from ..domain.enums import SUPPORTED_BASE_SELLERS
from ..domain.models import Trip


@dataclass
class AuthorizationScope:
    """What a traveler preauthorized the agent to do for this trip."""
    trip_id: str
    traveler_id: str
    budget_rlusd: Decimal
    allowed_sellers: set[str] = field(default_factory=lambda: set(SUPPORTED_BASE_SELLERS))
    preauthorized_recovery_cost: Decimal = Decimal("0.10")
    can_close_trip: bool = False          # trip closure is human-controlled by default
    can_fund: bool = False
    can_kill_switch: bool = False

    def allows_seller(self, seller_id: str) -> bool:
        return seller_id in self.allowed_sellers or seller_id in SUPPORTED_BASE_SELLERS


def check_authorization_scope(scope: AuthorizationScope, trip: Trip) -> None:
    """Confirm the scope matches the trip and the traveler owns it."""
    if scope.trip_id != trip.trip_id:
        raise PermissionError("authorization scope does not match this trip")
    if scope.traveler_id != trip.traveler_id:
        raise PermissionError("authorization scope belongs to a different traveler")


def can_agent_act(scope: AuthorizationScope, action: str, *, cost: Optional[Decimal] = None) -> bool:
    """Decide whether an action is within preauthorization (no human approval needed)."""
    if action in {"closeTrip", "fund", "killSwitch", "setMerchantSwitch"}:
        return False
    if action == "recovery_replacement" and cost is not None:
        return cost <= scope.preauthorized_recovery_cost
    if action == "createEscrow" and cost is not None:
        return cost <= scope.budget_rlusd
    return True
