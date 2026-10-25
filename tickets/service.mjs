/**
 * Demo ticket orders. One process owns the state file. The queue below is the
 * single writer for that file and for slot capacity, which have to move together.
 */

import { randomBytes } from 'node:crypto';
import { parseRlusd } from '../payments.mjs';
import {
  attractionById,
  checkQuantity,
  listOffers as catalogOffers,
  slotIdFor,
  slotsFor,
} from './catalog.mjs';
import { TicketError, rejectUnknown } from './errors.mjs';
import { readState, writeState } from './state.mjs';

export const PER_TICKET_MAX = '0.30';
export const TRIP_CEILING = '0.50';
export const POLICY_VERSION = 1;
export const QUOTE_TTL_MS = 120_000;
export const ESCROW_DEADLINE_SECONDS = 7 * 24 * 60 * 60;
export const DEMO_LABEL = 'Demo ticket — not valid for admission';
const HOLDING = new Set(['payment_pending', 'ticket_pending', 'issued']);

function wei(value) {
  if (value === 0 || value === '0' || value === '0.0' || value === '0.00') return 0n;
  return parseRlusd(value);
}

function smaller(left, right) {
  return left < right ? left : right;
}

function opaque(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export function createTicketService({
  payments,
  statePath,
  now = () => Date.now(),
  mode = 'mock',
  channelId = null,
  readSellerPrice = null,
  fault = null,
} = {}) {
  if (mode !== 'mock' && mode !== 'ap4m') {
    throw new TicketError('invalid_request', 'mode must be mock or ap4m.');
  }
  if (!payments || typeof payments.getBudget !== 'function') {
    throw new TicketError('invalid_request', 'Ticket service needs the payment budget.');
  }
  const identity = { mode, channelId: channelId ?? null };
  let state = null;
  let tail = Promise.resolve();

  function openState() {
    const saved = readState(statePath);
    if (!saved) {
      return {
        version: 1,
        mode: identity.mode,
        channelId: identity.channelId,
        orders: {},
        approvals: {},
        idempotency: {},
      };
    }
    if (saved.version !== 1 || saved.orders == null || typeof saved.orders !== 'object') {
      throw new TicketError('invalid_request', 'Ticket state version is not supported.');
    }
    if (saved.mode !== identity.mode || (saved.channelId ?? null) !== identity.channelId) {
      throw new TicketError('invalid_request', 'Ticket state belongs to a different payment mode or channel.');
    }
    const next = {
      version: 1,
      mode: saved.mode,
      channelId: saved.channelId ?? null,
      orders: saved.orders,
      approvals: saved.approvals ?? {},
      idempotency: saved.idempotency ?? {},
    };
    if (expireOrders(next)) writeState(statePath, next);
    return next;
  }

  function exclusive(work) {
    const run = tail.then(() => work());
    tail = run.then(() => {}, () => {});
    return run;
  }

  function persist() {
    if (statePath) writeState(statePath, state);
  }

  function crash(point) {
    if (fault !== point) return;
    const error = new Error(`injected crash at ${point}`);
    error.code = 'injected_crash';
    throw error;
  }

  function stamp(order) {
    order.updatedAt = new Date(now()).toISOString();
  }

  function expireOrders(target = state) {
    let changed = false;
    for (const order of Object.values(target.orders)) {
      if (order.status === 'quoted' && Date.parse(order.quote.expiresAt) <= now()) {
        order.status = 'expired';
        order.updatedAt = new Date(now()).toISOString();
        changed = true;
      }
    }
    return changed;
  }

  function holding(order) {
    if (order.status === 'quoted') return Date.parse(order.quote.expiresAt) > now();
    return HOLDING.has(order.status);
  }

  function usage() {
    const counts = {};
    for (const order of Object.values(state.orders)) {
      if (!holding(order)) continue;
      counts[order.quote.slotId] = (counts[order.quote.slotId] ?? 0) + 1;
    }
    return counts;
  }

  function view(order) {
    return {
      orderId: order.orderId,
      quoteId: order.quoteId,
      escrowId: order.escrowId,
      status: order.status,
      paymentStatus: order.paymentStatus,
      ticket: order.ticket,
      payment: order.payment,
      error: order.error,
    };
  }

  function mustGet(orderId) {
    if (typeof orderId !== 'string' || orderId.length === 0) {
      throw new TicketError('invalid_request', 'orderId is required.');
    }
    const order = state.orders[orderId];
    if (!order) throw new TicketError('not_found', `Unknown order ${orderId}.`);
    return order;
  }

  async function policyRoom(amountWei) {
    const budget = await payments.getBudget();
    const perTicket = smaller(
      wei(PER_TICKET_MAX),
      budget.maxBooking == null ? wei(PER_TICKET_MAX) : wei(budget.maxBooking),
    );
    const ceiling = smaller(
      wei(TRIP_CEILING),
      budget.spendCeiling == null ? wei(TRIP_CEILING) : wei(budget.spendCeiling),
    );
    if (amountWei > perTicket) {
      throw new TicketError('policy_denied', 'The ticket price is above the per-ticket maximum.');
    }
    if (wei(budget.reserved) + wei(budget.spent) + amountWei > ceiling) {
      throw new TicketError('policy_denied', 'The ticket would exceed the trip budget.');
    }
  }

  async function listOffers(input) {
    return { offers: catalogOffers(input).map((offer) => ({ ...offer })) };
  }

  function getSlots(input) {
    return exclusive(() => {
      rejectUnknown(input, ['attractionId', 'date']);
      if (expireOrders()) persist();
      return { slots: slotsFor(input.attractionId, input.date, now(), usage()) };
    });
  }

  function quote(input) {
    return exclusive(async () => {
      rejectUnknown(input, ['attractionId', 'sku', 'slotId', 'quantity']);
      checkQuantity(input.quantity);
      if (typeof input.sku !== 'string' || typeof input.slotId !== 'string') {
        throw new TicketError('invalid_request', 'sku and slotId are required.');
      }
      const row = attractionById(input.attractionId);
      if (!row.verified) throw new TicketError('policy_denied', 'That attraction is not on the demo allowlist.');
      if (input.sku !== row.sku) throw new TicketError('not_found', `Unknown sku ${input.sku}.`);
      const slotMatch = /^(.+):(\d{4}-\d{2}-\d{2}):(\d{2}:\d{2})$/.exec(input.slotId);
      if (!slotMatch || slotMatch[1] !== row.attractionId) {
        throw new TicketError('invalid_request', 'slotId does not match the attraction.');
      }
      const date = slotMatch[2];
      const localTime = slotMatch[3];
      if (slotIdFor(row.attractionId, date, localTime) !== input.slotId) {
        throw new TicketError('invalid_request', 'slotId does not match the attraction.');
      }
      if (expireOrders()) persist();
      const slots = slotsFor(row.attractionId, date, now(), usage());
      const slot = slots.find((item) => item.slotId === input.slotId);
      if (!slot) throw new TicketError('not_available', 'That slot is not bookable.');
      if (slot.available < 1) throw new TicketError('not_available', 'That slot is full.');
      const amountWei = wei(row.unitAmount);
      await policyRoom(amountWei);
      if (readSellerPrice) {
        let asked;
        try {
          asked = await readSellerPrice(row.sellerId, row.sku);
        } catch {
          throw new TicketError('supplier_unavailable', 'The seller did not return a price.');
        }
        if (wei(asked) !== amountWei) {
          throw new TicketError('price_changed', 'The seller price does not match the catalog price.');
        }
      }
      const created = new Date(now()).toISOString();
      const quoteId = opaque('qt');
      const orderId = opaque('ord');
      const snapshot = {
        quoteId,
        attractionId: row.attractionId,
        sellerId: row.sellerId,
        sku: row.sku,
        slotId: slot.slotId,
        date: slot.date,
        localTime: slot.localTime,
        timezone: slot.timezone,
        quantity: 1,
        amount: row.unitAmount,
        currency: 'RLUSD',
        expiresAt: new Date(now() + QUOTE_TTL_MS).toISOString(),
        policyVersion: POLICY_VERSION,
        demo: true,
      };
      state.orders[orderId] = {
        orderId,
        quoteId,
        escrowId: null,
        status: 'quoted',
        paymentStatus: 'unpaid',
        quote: snapshot,
        ticket: null,
        payment: null,
        error: null,
        createdAt: created,
        updatedAt: created,
      };
      persist();
      return { orderId, quote: { ...snapshot } };
    });
  }

  function orderByQuote(quoteId) {
    return Object.values(state.orders).find((order) => order.quoteId === quoteId) ?? null;
  }

  function paymentView(status) {
    const live = status.live === true;
    return {
      mode: status.mode,
      live,
      paidVia: live ? (status.paidVia ?? null) : null,
      txHash: live ? (status.txHash ?? null) : null,
      explorerUrl: live ? (status.explorerUrl ?? null) : null,
      receiptUrl: live ? (status.receiptUrl ?? null) : null,
    };
  }

  function notePayment(order, status) {
    order.payment = paymentView(status);
    order.paymentStatus = 'confirmed';
    order.status = 'ticket_pending';
    order.error = null;
    stamp(order);
    persist();
  }

  function fail(order, code, message) {
    order.status = 'failed';
    order.paymentStatus = 'unpaid';
    order.error = { code, message };
    stamp(order);
    persist();
  }

  function issue(order) {
    if (order.ticket) {
      order.status = 'issued';
      order.paymentStatus = 'confirmed';
      order.error = null;
      stamp(order);
      persist();
      return;
    }
    order.status = 'ticket_pending';
    order.paymentStatus = 'confirmed';
    persist();
    crash('before_ticket');
    const issuedAt = new Date(now()).toISOString();
    order.ticket = {
      ticketId: opaque('tkt'),
      label: DEMO_LABEL,
      attractionId: order.quote.attractionId,
      sku: order.quote.sku,
      slotId: order.quote.slotId,
      quantity: 1,
      confirmationCode: `DEMO-${randomBytes(4).toString('hex').toUpperCase()}`,
      issuedAt,
    };
    order.status = 'issued';
    order.error = null;
    stamp(order);
    persist();
  }

  async function releaseUnpaidLock(order) {
    if (!order.escrowId) return;
    const status = await payments.getStatus(order.escrowId);
    if (status.status === 'locked' || status.status === 'quoted') await payments.refund(order.escrowId);
  }

  async function onPaymentFailure(order, error) {
    if (error?.code === 'injected_crash') throw error;
    const code = error?.code;
    if (code === 'redeem_unconfirmed' || code === 'chain_unavailable') {
      order.paymentStatus = 'pending';
      order.error = { code, message: String(error.message).slice(0, 300) };
      stamp(order);
      persist();
      return;
    }
    if (code === 'overcharged') {
      fail(order, 'price_changed', 'The seller price changed. Request a new quote.');
      throw new TicketError('price_changed', order.error.message, { orderId: order.orderId });
    }
    await releaseUnpaidLock(order);
    const mapped = code === 'redeem_failed' ? 'redeem_failed' : 'supplier_unavailable';
    fail(order, mapped, String(error.message).slice(0, 300));
    throw new TicketError(mapped, order.error.message, { orderId: order.orderId });
  }

  async function assertSellerPrice(order) {
    if (!readSellerPrice) return;
    let asked;
    try {
      asked = await readSellerPrice(order.quote.sellerId, order.quote.sku);
    } catch {
      throw new TicketError('supplier_unavailable', 'The seller did not return a price.', { orderId: order.orderId });
    }
    if (wei(asked) !== wei(order.quote.amount)) {
      throw new TicketError('price_changed', 'The seller price does not match the approved quote.', { orderId: order.orderId });
    }
  }

  async function settle(order) {
    if (order.status === 'ticket_pending') {
      issue(order);
      return;
    }
    if (order.status !== 'payment_pending' || !order.escrowId) return;
    const current = await payments.getStatus(order.escrowId);
    if (current.status === 'delivered') {
      notePayment(order, current);
      issue(order);
      return;
    }
    if (current.status === 'paying') return;
    if (current.status === 'overcharged') {
      fail(order, 'price_changed', 'The seller price changed. Request a new quote.');
    }
  }

  async function pay(order) {
    if (!order.escrowId) {
      const escrowId = await payments.createEscrow(
        order.quote.sellerId,
        order.quote.amount,
        ESCROW_DEADLINE_SECONDS,
        order.quote.sku,
        `ticket:${order.orderId}`,
      );
      crash('after_escrow_created');
      order.escrowId = escrowId;
      stamp(order);
      persist();
      crash('after_escrow');
    }
    const current = await payments.getStatus(order.escrowId);
    if (current.status === 'delivered') {
      crash('after_confirmation');
      notePayment(order, current);
      issue(order);
      return;
    }
    if (current.status === 'paying') {
      try {
        const paid = await payments.release(order.escrowId);
        crash('after_confirmation');
        notePayment(order, paid);
        issue(order);
      } catch (error) {
        await onPaymentFailure(order, error);
      }
      return;
    }
    if (current.status === 'overcharged') {
      fail(order, 'price_changed', 'The seller price changed. Request a new quote.');
      throw new TicketError('price_changed', order.error.message, { orderId: order.orderId });
    }
    if (current.status !== 'locked') {
      await onPaymentFailure(order, { code: 'seller_unavailable', message: 'The payment did not stay reserved.' });
      return;
    }
    try {
      const paid = await payments.release(order.escrowId);
      crash('after_confirmation');
      notePayment(order, paid);
      issue(order);
    } catch (error) {
      await onPaymentFailure(order, error);
    }
  }

  function remembered(order, key, bound) {
    if (!bound) {
      state.idempotency[key] = { quoteId: order.quoteId, orderId: order.orderId };
      persist();
    }
  }

  async function resume(order) {
    if (order.status === 'expired') {
      throw new TicketError('quote_expired', 'The quote expired.', { orderId: order.orderId });
    }
    if (order.status === 'cancelled') {
      throw new TicketError('invalid_request', 'That hold is cancelled.', { orderId: order.orderId });
    }
    if (order.status === 'failed') {
      throw new TicketError(order.error.code, order.error.message, { orderId: order.orderId });
    }
    if (order.status === 'issued') return { order: view(order) };
    if (order.status === 'ticket_pending') {
      issue(order);
      return { order: view(order) };
    }
    await pay(order);
    return { order: view(order) };
  }

  function getOrder(input) {
    return exclusive(async () => {
      rejectUnknown(input, ['orderId']);
      const order = mustGet(input.orderId);
      if (expireOrders()) persist();
      await settle(order);
      return { order: view(order) };
    });
  }

  function approve(input) {
    return exclusive(() => {
      rejectUnknown(input, ['quoteId']);
      if (typeof input.quoteId !== 'string' || input.quoteId.length === 0) {
        throw new TicketError('invalid_request', 'quoteId is required.');
      }
      const order = orderByQuote(input.quoteId);
      if (!order) throw new TicketError('not_found', 'Unknown quote.');
      if (expireOrders()) persist();
      if (order.status !== 'quoted') {
        throw new TicketError(order.status === 'expired' ? 'quote_expired' : 'invalid_request', 'That quote can no longer be confirmed.', { orderId: order.orderId });
      }
      state.approvals[order.quoteId] = {
        quoteId: order.quoteId,
        orderId: order.orderId,
        policyVersion: POLICY_VERSION,
        expiresAt: order.quote.expiresAt,
        snapshot: { ...order.quote },
      };
      persist();
      return { quoteId: order.quoteId, orderId: order.orderId, expiresAt: order.quote.expiresAt };
    });
  }

  function purchase(input) {
    return exclusive(async () => {
      rejectUnknown(input, ['quoteId', 'idempotencyKey']);
      const key = input.idempotencyKey;
      if (typeof key !== 'string' || key.length < 1 || key.length > 128) {
        throw new TicketError('invalid_request', 'idempotencyKey must be 1 to 128 characters.');
      }
      if (typeof input.quoteId !== 'string' || input.quoteId.length === 0) {
        throw new TicketError('invalid_request', 'quoteId is required.');
      }
      if (expireOrders()) persist();
      const bound = state.idempotency[key];
      if (bound && bound.quoteId !== input.quoteId) {
        throw new TicketError('idempotency_conflict', 'idempotencyKey is already bound to another quote.');
      }
      const order = bound ? state.orders[bound.orderId] : orderByQuote(input.quoteId);
      if (!order || order.quoteId !== input.quoteId) throw new TicketError('not_found', 'Unknown quote.');
      if (order.status !== 'quoted') {
        if (order.status === 'payment_pending' || order.status === 'ticket_pending' || order.status === 'issued' || order.status === 'failed') {
          remembered(order, key, bound);
        }
        return resume(order);
      }
      const approval = state.approvals[order.quoteId];
      if (!approval || approval.policyVersion !== POLICY_VERSION || approval.snapshot.amount !== order.quote.amount || approval.snapshot.slotId !== order.quote.slotId) {
        throw new TicketError('approval_required', 'The traveler has not confirmed this quote.', { orderId: order.orderId });
      }
      await policyRoom(wei(order.quote.amount));
      await assertSellerPrice(order);
      state.idempotency[key] = { quoteId: order.quoteId, orderId: order.orderId };
      order.status = 'payment_pending';
      order.paymentStatus = 'pending';
      order.error = null;
      stamp(order);
      persist();
      crash('after_intent');
      return resume(order);
    });
  }

  function reconcile() {
    return exclusive(async () => {
      if (expireOrders()) persist();
      for (const order of Object.values(state.orders)) await settle(order);
    });
  }

  function cancel(input) {
    return exclusive(() => {
      rejectUnknown(input, ['orderId']);
      const order = mustGet(input.orderId);
      if (expireOrders()) persist();
      if (order.status !== 'quoted') {
        throw new TicketError('cannot_cancel', 'Only an unpaid hold can be cancelled.', { orderId: order.orderId });
      }
      order.status = 'cancelled';
      stamp(order);
      persist();
      return { order: view(order) };
    });
  }

  function sweep() {
    return exclusive(() => {
      if (expireOrders()) persist();
    });
  }

  state = openState();

  return {
    listOffers,
    getSlots,
    quote,
    approve,
    purchase,
    getOrder,
    cancel,
    sweep,
    reconcile,
  };
}
