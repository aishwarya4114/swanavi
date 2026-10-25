"""Domain enumerations.

Statuses mirror the Mastercard AP4M payment server contract exactly so that the
booker can reconcile local booking records against server state without translation.
"""

from __future__ import annotations

from enum import Enum


class BookingStatus(str, Enum):
    """Escrow/booking lifecycle, matching the payment server states 1:1."""

    QUOTED = "quoted"          # price recorded, lock rejected, nothing reserved
    LOCKED = "locked"          # amount reserved from budget (local slice of channel cap)
    PAYING = "paying"          # ap4m only: voucher submitted, waiting for the block — poll
    DELIVERED = "delivered"    # seller paid (VoucherRedeemed on chain in ap4m)
    REFUNDED = "refunded"      # reservation returned to budget; nothing was ever signed
    OVERCHARGED = "overcharged"  # final bill above the lock; release refused before signing


class EscrowReason(str, Enum):
    """Why a booking reached its current terminal/transient state."""

    REFUND = "refund"               # explicit refund of an unpaid lock
    DEADLINE = "deadline"           # locked booking past its deadlineSeconds
    TRIP_CLOSED = "trip_closed"     # lock released by POST /trip/close
    REDEEM_FAILED = "redeem_failed"  # chain shows no payment; back to locked
    REDEEM_UNCONFIRMED = "redeem_unconfirmed"  # payment on chain, confirmation pending
    X402_PRICE_EXCEEDS_LOCK = "x402_price_exceeds_lock"
    SELLER_CANCELLED = "seller_cancelled"
    SELLER_FAILED = "seller_failed"
    RECOVERY_REPLACEMENT = "recovery_replacement"  # local: replaced by recovery flow


class ActivityType(str, Enum):
    """Kind of itinerary activity — drives recovery policy selection."""

    OUTDOOR_TOUR = "outdoor_tour"
    INDOOR_TOUR = "indoor_tour"
    HOTEL = "hotel"
    TRANSPORT = "transport"        # cab / flight / transit
    FOOD = "food"
    ATTRACTION = "attraction"      # general; booking bookability is NOT implied
    SHOPPING = "shopping"
    OTHER = "other"


class RiskLevel(str, Enum):
    """How badly an incident threatens the trip."""

    INFO = "info"          # informational, no action needed
    LOW = "low"            # minor; agent may auto-resolve within scope
    MEDIUM = "medium"      # needs recovery, possibly within preauthorization
    HIGH = "high"          # needs recovery and likely human approval
    CRITICAL = "critical"  # safety or large financial impact; human approval required


class IncidentType(str, Enum):
    """The ten travel disruptions Swanavi handles."""

    RAIN_OUTDOOR_TOUR = "rain_outdoor_tour"
    SEVERE_WEATHER = "severe_weather"
    FLIGHT_DELAY = "flight_delay"
    TRAFFIC_TIMED_BOOKING = "traffic_timed_booking"
    RESTAURANT_UNAVAILABLE = "restaurant_unavailable"
    TOUR_CANCELLATION = "tour_cancellation"
    ATTRACTION_CLOSURE = "attraction_closure"
    HOTEL_BOOKING_FAILURE = "hotel_booking_failure"
    OVERLAPPING_ITINERARY = "overlapping_itinerary"
    PAYMENT_CONFIRMATION_FAILURE = "payment_confirmation_failure"


class IncidentStatus(str, Enum):
    OPEN = "open"
    IN_REVIEW = "in_review"        # recovery agent is evaluating
    AWAITING_APPROVAL = "awaiting_approval"
    RECOVERING = "recovering"
    RESOLVED = "resolved"           # only after verification
    ESCALATED = "escalated"         # needs a human; agent stopped
    DROPPED = "dropped"             # false positive / superseded


class AgentRole(str, Enum):
    MASTER = "master"
    PLANNER = "planner"
    BOOKER = "booker"
    RECOVERY = "recovery"
    MONITOR = "monitor"


class ApprovalStatus(str, Enum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    EXPIRED = "expired"
    SUPERSEDED = "superseded"


class EvidenceKind(str, Enum):
    """How a booking claim is backed — the honesty axis."""

    LIVE = "live"            # confirmed on-chain transaction
    LOCAL = "local"          # ap4m mode, nothing on chain for this row
    MOCK = "mock"            # payment server mock mode
    SIMULATED = "simulated"  # recovery alternative we found but could not confirm
    SUGGESTION = "suggestion"  # a planner idea, not a booking at all


# The four supported base payment sellers. Demo stores are also valid sellers
# (their storeId is the sellerId), but only these four are the canonical AP4M
# merchants. Recovery substitutes use verified demo stores only.
SUPPORTED_BASE_SELLERS = frozenset({"hotel", "tour", "cab", "food"})
