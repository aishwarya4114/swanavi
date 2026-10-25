"""Booking Agent core logic (the "Booker").

Enforces every payment-safety invariant in code, never in a prompt:

* Never creates a duplicate escrow to retry an uncertain payment. A ``paying`` or
  ``redeem_unconfirmed`` booking is only reconciled (poll ``getStatus``); a retry
  ``release`` re-attempts the *confirmation* only and can never pay twice.
* Never refunds a delivered/paid booking. ``refund`` on a ``delivered`` (and
  especially on-chain ``live``) booking is refused locally with a clear message;
  a paid voucher requires an independent merchant cancellation workflow.
* Stops new bookings when the budget reports ``drift`` or the kill switch is on.
* Preserves escrow ids across an ambiguous payment and never invents a new one.
* Distinguishes MOCK / LOCAL / LIVE / SIMULATED evidence on every booking record.

The payment server and chain remain authoritative for financial outcomes; the
local :class:`BookingRecord` is the agent's reconciled operational view.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Optional

from ..domain.enums import BookingStatus, EvidenceKind
from ..domain.models import (
    AuditEvent, BookingRecord, PaymentEvidence, new_id, utcnow,
)
from ..payment.budget import BudgetSnapshot
from ..payment.client import MastercardClient
from ..payment.errors import (
    PaymentError, is_ambiguous_payment, is_budget_stop,
)
from ..storage.store import SwanaviStore


def _evidence_from_status(body: dict) -> PaymentEvidence:
    return PaymentEvidence(
        tx_hash=body.get("txHash"),
        explorer_url=body.get("explorerUrl"),
        claim_id=body.get("claimId"),
        block_number=body.get("blockNumber"),
        cumulative_amount=body.get("cumulativeAmount"),
        receipt_url=body.get("receiptUrl"),
        settlement=body.get("settlement"),
        channel_id=body.get("channelId"),
        chain_status=body.get("chainStatus"),
        paid_via=body.get("paidVia"),
        resource=body.get("resource"),
        badge=body.get("badge"),
    )


def _badge_for(body: dict) -> tuple[str, str, EvidenceKind]:
    badge = body.get("badge", "MOCK")
    note = body.get("note", "")
    live = bool(body.get("live", False))
    if live:
        return badge, note, EvidenceKind.LIVE
    if badge == "LOCAL":
        return badge, note, EvidenceKind.LOCAL
    return badge, note, EvidenceKind.MOCK


class Booker:
    def __init__(self, client: MastercardClient, store: SwanaviStore, trip_id: str):
        self.client = client
        self.store = store
        self.trip_id = trip_id

    # ------------------------------------------------------------------ discovery
    def discover_sellers(self) -> dict:
        """Return the supported base sellers plus the demo stores. Only these may be
        booked; the Booker refuses anything else."""
        merchants = self.client.list_merchants().get("merchants", [])
        stores = self.client.list_stores().get("stores", [])
        return {"merchants": merchants, "stores": stores}

    def quote(self, store_id: str, sku: str) -> dict:
        """Get a no-money quote for a store SKU. The quote's ``sellerId`` and ``amount``
        are what ``lock`` will use."""
        return self.client.get_store_quote(store_id, sku)

    # ------------------------------------------------------------------ budget
    def refresh_budget(self) -> BudgetSnapshot:
        return BudgetSnapshot.from_budget(self.client.get_budget())

    # ------------------------------------------------------------------ lock
    def lock(
        self,
        activity_id: str,
        seller_id: str,
        amount: str,
        deadline_seconds: int = 3600,
        idempotency_key: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> BookingRecord:
        """Create an escrow lock. Refuses if the budget cannot accept new bookings.
        Idempotent on ``idempotency_key`` and on an existing non-terminal booking for
        the same activity (prevents duplicate booking requests)."""
        self._assert_can_book()
        self._assert_amount_positive(amount)

        booking_id = new_id("bk")
        booking = BookingRecord(
            booking_id=booking_id, trip_id=self.trip_id, activity_id=activity_id,
            seller_id=seller_id, amount=amount, status=BookingStatus.QUOTED,
            idempotency_key=idempotency_key or f"lock:{activity_id}:{seller_id}:{amount}",
            deadline_at=utcnow() + timedelta(seconds=deadline_seconds),
        )
        created, existing = self.store.create_booking_if_absent(booking)
        if not created:
            # An equivalent booking already exists; reconcile and return it.
            self._audit("booker", "lock.duplicate", existing.booking_id, "ok",
                         {"activity_id": activity_id, "existing": existing.booking_id}, correlation_id)
            return self.reconcile(existing.booking_id)

        try:
            body = self.client.create_escrow(seller_id, amount, deadline_seconds)
        except PaymentError as exc:
            booking.status = BookingStatus.QUOTED
            booking.reason = exc.code
            booking.note = exc.message
            self.store.save("booking", booking)
            self._audit("booker", "lock.refused", booking_id, "denied",
                         {"error": exc.code, "message": exc.message}, correlation_id)
            raise

        self._apply_server_state(booking, body)
        self.store.save("booking", booking)
        self._audit("booker", "lock.created", booking_id, "ok",
                     {"escrow_id": booking.escrow_id, "amount": amount, "seller_id": seller_id},
                     correlation_id)
        return booking

    # ------------------------------------------------------------------ deliver
    def deliver(
        self, booking_id: str, final_bill: Optional[str] = None,
        correlation_id: Optional[str] = None,
    ) -> BookingRecord:
        """Release a locked booking after delivery. Honors the overcharge rule: a
        finalBill above the lock is refused by the server (409 overcharged) before
        anything is signed; we record it as ``overcharged`` and return the budget."""
        booking = self._must_get(booking_id)
        if booking.status not in (BookingStatus.LOCKED, BookingStatus.PAYING):
            raise PaymentError("invalid_state",
                f"cannot release booking in status {booking.status.value}", 409)
        # An ambiguous/paying payment: retry release ONLY retries confirmation,
        # never a second payment. We still call release (the server enforces this),
        # but we must never create a new escrow here.
        if booking.status == BookingStatus.PAYING:
            return self._retry_confirmation(booking, correlation_id)

        try:
            body = self.client.release(booking.escrow_id, final_bill)
        except PaymentError as exc:
            if exc.code == "overcharged":
                booking.status = BookingStatus.OVERCHARGED
                booking.reason = exc.code
                booking.final_bill = str(exc.details.get("finalBill")) if exc.details.get("finalBill") else booking.final_bill
                self.store.save("booking", booking)
                self._audit("booker", "deliver.overcharged", booking_id, "denied",
                             {"finalBill": exc.details.get("finalBill")}, correlation_id)
                raise
            if is_ambiguous_payment(exc):
                # payment may be on chain; preserve escrow id, mark paying, do NOT create a new escrow
                booking.status = BookingStatus.PAYING
                booking.reason = exc.code
                self.store.save("booking", booking)
                self._audit("booker", "deliver.unconfirmed", booking_id, "error",
                             {"escrow_id": booking.escrow_id, "reason": exc.code}, correlation_id)
                raise
            # redeem_failed / chain_unavailable / seller_unavailable -> lock unchanged
            self._apply_server_state(booking, self._safe_status(booking))
            self.store.save("booking", booking)
            self._audit("booker", "deliver.failed", booking_id, "error",
                         {"error": exc.code, "message": exc.message}, correlation_id)
            raise

        self._apply_server_state(booking, body)
        self.store.save("booking", booking)
        self._audit("booker", "deliver.released", booking_id, "ok",
                     {"status": booking.status.value,
                      "evidence_kind": booking.evidence.evidence_kind.value,
                      "tx": booking.evidence.tx_hash}, correlation_id)
        return booking

    # ------------------------------------------------------------------ cancel / refund
    def cancel(self, booking_id: str, correlation_id: Optional[str] = None) -> BookingRecord:
        """Return an UNPAID lock to the budget. Refuses a delivered/paid booking: a
        paid voucher is not refundable through this endpoint; it needs an independent
        merchant cancellation workflow. The server also enforces this (409 invalid_state),
        but we refuse locally first for a clear, honest message."""
        booking = self._must_get(booking_id)
        if booking.status == BookingStatus.DELIVERED:
            if booking.evidence.evidence_kind == EvidenceKind.LIVE:
                raise PaymentError(
                    "invalid_state",
                    "This booking is paid and confirmed on chain. The refund endpoint only "
                    "releases unpaid local locks; it cannot reverse an on-chain payment. A paid "
                    "voucher requires an independent merchant cancellation workflow.",
                    409,
                )
            # delivered but only LOCAL/MOCK: still refuse; nothing to refund
            raise PaymentError("invalid_state",
                "Cannot refund a delivered booking; the seller was already paid.", 409)
        if booking.status in (BookingStatus.OVERCHARGED, BookingStatus.REFUNDED):
            # nothing to do; idempotent
            return booking
        if booking.status == BookingStatus.PAYING:
            raise PaymentError("invalid_state",
                "Cannot refund a paying booking — the payment may already be on chain. "
                "Poll getStatus and reconcile before any refund decision.",
                409)
        # quoted or locked -> safe to refund (unpaid lock)
        try:
            body = self.client.refund(booking.escrow_id) if booking.escrow_id else {}
        except PaymentError:
            # reconcile and re-raise with the freshest state
            self._apply_server_state(booking, self._safe_status(booking))
            self.store.save("booking", booking)
            raise
        if body:
            self._apply_server_state(booking, body)
        else:
            booking.status = BookingStatus.REFUNDED
            booking.reason = "refund"
            booking.updated_at = utcnow()
        self.store.save("booking", booking)
        self._audit("booker", "cancel.refunded", booking_id, "ok",
                     {"escrow_id": booking.escrow_id}, correlation_id)
        return booking

    # ------------------------------------------------------------------ reconcile
    def reconcile(self, booking_id: str, correlation_id: Optional[str] = None) -> BookingRecord:
        """Poll the payment server and sync the local record. This is the ONLY valid
        action for a ``paying`` booking, and it can never create a duplicate payment."""
        booking = self._must_get(booking_id)
        body = self._safe_status(booking)
        prev_status = booking.status
        self._apply_server_state(booking, body)
        self.store.save("booking", booking)
        if prev_status != booking.status:
            self._audit("booker", "reconcile.changed", booking_id, "ok",
                         {"from": prev_status.value, "to": booking.status.value}, correlation_id)
        return booking

    def reconcile_all(self, correlation_id: Optional[str] = None) -> list[BookingRecord]:
        """Reconcile every booking for this trip against the server's escrow list."""
        server_escrows = {e.get("escrowId"): e for e in self.client.list_escrows().get("escrows", [])}
        updated: list[BookingRecord] = []
        for booking in self.store.list("booking", self.trip_id):
            if booking.escrow_id and booking.escrow_id in server_escrows:
                self._apply_server_state(booking, server_escrows[booking.escrow_id])
            elif booking.escrow_id is None:
                continue  # never reached the server
            self.store.save("booking", booking)
            updated.append(booking)
        self._audit("booker", "reconcile.all", None, "ok",
                     {"count": len(updated)}, correlation_id)
        return updated

    # ------------------------------------------------------------------ replace (recovery)
    def replace_unpaid_booking(
        self, old_booking_id: str, new_activity_id: str, new_seller_id: str,
        new_amount: str, deadline_seconds: int = 3600,
        correlation_id: Optional[str] = None,
    ) -> dict:
        """Recovery helper: refund an UNPAID lock and book an alternative. Refuses
        outright if the old booking is paid/delivered/paying — those are not safe to
        replace through the refund endpoint (the rules forbid cancelling an already-
        paid on-chain booking by invoking the unpaid-lock refund API)."""
        old = self._must_get(old_booking_id)
        if old.status != BookingStatus.LOCKED:
            raise PaymentError("invalid_state",
                f"replace_unpaid_booking requires the old booking to be LOCKED (unpaid); "
                f"it is {old.status.value}. A paid booking cannot be replaced via refund.",
                409)
        self.cancel(old_booking_id, correlation_id=correlation_id)
        new = self.lock(new_activity_id, new_seller_id, new_amount,
                         deadline_seconds=deadline_seconds,
                         idempotency_key=f"replace:{old_booking_id}:{new_seller_id}:{new_amount}",
                         correlation_id=correlation_id)
        old.replaced_by = new.booking_id
        self.store.save("booking", old)
        self._audit("booker", "replace.done", None, "ok",
                     {"old": old_booking_id, "new": new.booking_id}, correlation_id)
        return {"refunded": old_booking_id, "locked": new.booking_id,
                "new_escrow_id": new.escrow_id}

    # ------------------------------------------------------------------ internals
    def _retry_confirmation(self, booking: BookingRecord, correlation_id: Optional[str]) -> BookingRecord:
        """A release on a paying booking retries the confirmation only. We call the
        server's release (which the server enforces as confirmation-only), then update.
        We never create a new escrow."""
        try:
            body = self.client.release(booking.escrow_id)
        except PaymentError as exc:
            if is_ambiguous_payment(exc):
                booking.status = BookingStatus.PAYING
                booking.reason = exc.code
                self.store.save("booking", booking)
                self._audit("booker", "deliver.still_unconfirmed", booking.booking_id, "error",
                             {"escrow_id": booking.escrow_id}, correlation_id)
                raise
            self._apply_server_state(booking, self._safe_status(booking))
            self.store.save("booking", booking)
            raise
        self._apply_server_state(booking, body)
        self.store.save("booking", booking)
        self._audit("booker", "deliver.confirmed_on_retry", booking.booking_id, "ok",
                     {"status": booking.status.value, "tx": booking.evidence.tx_hash}, correlation_id)
        return booking

    def _safe_status(self, booking: BookingRecord) -> dict:
        if not booking.escrow_id:
            return booking.to_dict()
        try:
            return self.client.get_status(booking.escrow_id)
        except PaymentError:
            # if the status call itself fails (e.g. chain_unavailable), return the
            # current local record unchanged so the caller can decide.
            return booking.to_dict()

    def _apply_server_state(self, booking: BookingRecord, body: dict) -> None:
        if not body:
            return
        if "status" in body and body["status"]:
            try:
                booking.status = BookingStatus(body["status"])
            except ValueError:
                pass
        booking.reason = body.get("reason") or booking.reason
        booking.final_bill = body.get("finalBill") or booking.final_bill
        booking.escrow_id = body.get("escrowId") or booking.escrow_id
        booking.evidence = _evidence_from_status(body)
        badge, note, _kind = _badge_for(body)
        booking.badge = badge
        booking.note = note
        booking.mode = body.get("mode", booking.mode)
        if body.get("deadlineAt"):
            try:
                booking.deadline_at = datetime.fromisoformat(
                    str(body["deadlineAt"]).replace("Z", "+00:00"))
            except ValueError:
                pass
        if body.get("repaired"):
            booking.repaired = body["repaired"]
        booking.updated_at = utcnow()

    def _must_get(self, booking_id: str) -> BookingRecord:
        booking = self.store.get("booking", booking_id)
        if not booking or booking.trip_id != self.trip_id:
            raise PaymentError("not_found", f"unknown booking {booking_id} for this trip", 404)
        return booking

    def _assert_can_book(self) -> None:
        budget = self.refresh_budget()
        if budget.has_drift:
            raise PaymentError("invalid_state",
                "Budget drift detected — local bookings disagree with the chain. "
                "New bookings are stopped until reconciliation.",
                409, {"drift": budget.drift})
        if budget.killed:
            raise PaymentError("killed", "Kill switch is on; new locks are refused.", 409)
        if not budget.can_book:
            raise PaymentError("over_budget", "No remaining budget for a new lock.", 409)

    def _assert_amount_positive(self, amount: str) -> None:
        try:
            if Decimal(str(amount)) <= 0:
                raise ValueError
        except (InvalidOperation, ValueError):
            raise PaymentError("bad_amount", f"amount must be a positive decimal string, got {amount!r}", 400)

    def _audit(self, role: str, action: str, booking_id: Optional[str], outcome: str,
               details: dict, correlation_id: Optional[str]) -> None:
        from ..domain.enums import AgentRole
        self.store.save("audit_event", AuditEvent(
            event_id=new_id("evt"), trip_id=self.trip_id, correlation_id=correlation_id,
            role=AgentRole.BOOKER, action=action, outcome=outcome,
            details={**details, "booking_id": booking_id},
        ))
