/**
 * Demo shop purchases: prepare -> host approval -> pay -> status. One process owns the state file;
 * the queue below is its single writer. Money moves only through payments.mjs (createEscrow with
 * operationKey 'shop:<purchaseId>', then release), so the executor's x402 path, the limits and the
 * confirmation recovery are the existing ones. This file signs nothing and holds no key.
 *
 *   prepared --approve--> approved --pay--> paying --> paid
 *      |                     |                 \----> failed   (definitely unpaid)
 *      +--> expired / cancelled                 \---> cancelled (unpaid, approval expired or cancel)
 */

import { createHash, randomBytes } from 'node:crypto';
import { formatRlusd, parseRlusd } from '../payments.mjs';
import { readState, writeState } from '../tickets/state.mjs';
import { getQuote } from './catalog.mjs';
import { storeResource } from './x402.mjs';

export const PREPARE_TTL_MS = 120_000;
export const ESCROW_DEADLINE_SECONDS = 600;
export const COMPATIBILITY_POLICY = 'compatibility';
const STATE_VERSION = 1;

const HTTP_STATUS = {
  invalid_request: 400,
  unknown_store: 400,
  unknown_sku: 400,
  unauthorized: 401,
  unverified_store: 403,
  price_above_maximum: 403,
  amount_limit: 403,
  spend_ceiling: 403,
  over_budget: 403,
  killed: 403,
  policy_required: 403,
  booking_facts_missing: 403,
  approval_required: 403,
  not_found: 404,
  purchase_expired: 409,
  invalid_state: 409,
  idempotency_conflict: 409,
  cannot_cancel: 409,
  price_changed: 409,
  over_cap: 409,
  channel_closed: 409,
};

export class ShopError extends Error {
  constructor(code, message, purchase = null) {
    super(message);
    this.name = 'ShopError';
    this.code = code;
    // Anything not named is a seller or payment-path failure.
    this.status = HTTP_STATUS[code] ?? 502;
    this.purchase = purchase;
  }
}

export function rejectUnknown(input, allowed) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ShopError('invalid_request', 'Input must be an object.');
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new ShopError('invalid_request', `Unknown field ${key}.`);
  }
}

function wei(value) {
  if (value == null || value === 0 || value === '0') return 0n;
  return parseRlusd(value);
}

function digestOf(snapshot) {
  const fields = ['storeId', 'sku', 'title', 'quantity', 'quotedAmount', 'maximumAmount', 'currency', 'expiresAt', 'mode', 'policyVersion'];
  return createHash('sha256').update(JSON.stringify(fields.map((field) => snapshot[field]))).digest('hex');
}

export function createShopPurchases({
  payments,
  statePath,
  now = () => Date.now(),
  mode = 'mock',
  channelId = null,
  readChallengePrice = null,
  fault = null,
} = {}) {
  if (mode !== 'mock' && mode !== 'ap4m') throw new ShopError('invalid_request', 'mode must be mock or ap4m.');
  if (!payments || typeof payments.createEscrow !== 'function') throw new ShopError('invalid_request', 'Shop purchases need the payment service.');
  const guardrailMode = payments.guardrailMode ?? COMPATIBILITY_POLICY;
  const identity = { mode, channelId: channelId ?? null };
  let tail = Promise.resolve();
  const state = openState();

  function openState() {
    const saved = readState(statePath);
    if (!saved) return { version: STATE_VERSION, kind: 'shop-purchases', ...identity, purchases: {}, idempotency: {} };
    if (saved.version !== STATE_VERSION || saved.kind !== 'shop-purchases' || saved.purchases == null || typeof saved.purchases !== 'object') {
      throw new ShopError('invalid_request', `Shop state at ${statePath} is not a known version. Move it aside; it is never deleted.`);
    }
    if (saved.mode !== identity.mode || (saved.channelId ?? null) !== identity.channelId) {
      throw new ShopError('invalid_request', `Shop state at ${statePath} belongs to mode ${saved.mode} channel ${saved.channelId}, not ${identity.mode} ${identity.channelId}.`);
    }
    return { ...saved, idempotency: saved.idempotency ?? {} };
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

  function stamp(record) {
    record.updatedAt = new Date(now()).toISOString();
  }

  const pastExpiry = (record) => Date.parse(record.snapshot.expiresAt) <= now();

  function expireDue() {
    let changed = false;
    for (const record of Object.values(state.purchases)) {
      if ((record.status === 'prepared' || record.status === 'approved') && pastExpiry(record)) {
        record.status = 'expired';
        stamp(record);
        changed = true;
      }
    }
    if (changed) persist();
  }

  function view(record) {
    const live = record.payment?.live === true;
    let settlementStatus = 'not_started';
    if (record.status === 'paid' && live) settlementStatus = record.payment.receiptUrl ? 'settled' : 'pending';
    return {
      purchaseId: record.purchaseId,
      storeId: record.snapshot.storeId,
      sku: record.snapshot.sku,
      title: record.snapshot.title,
      quantity: 1,
      quotedAmount: record.snapshot.quotedAmount,
      maximumAmount: record.snapshot.maximumAmount,
      currency: 'RLUSD',
      expiresAt: record.snapshot.expiresAt,
      status: record.status,
      escrowId: record.escrowId,
      chargedAmount: record.chargedAmount,
      mode,
      demo: true,
      live,
      paidVia: live ? record.payment.paidVia : null,
      txHash: live ? record.payment.txHash : null,
      explorerUrl: live ? record.payment.explorerUrl : null,
      settlementStatus,
      receiptUrl: live ? record.payment.receiptUrl : null,
      resource: record.resource,
      error: record.error,
    };
  }

  const result = (record) => ({ purchase: view(record) });

  function mustGet(purchaseId) {
    if (typeof purchaseId !== 'string' || purchaseId.length === 0) throw new ShopError('invalid_request', 'purchaseId is required.');
    const record = state.purchases[purchaseId];
    if (!record) throw new ShopError('not_found', `Unknown purchase ${purchaseId}.`);
    return record;
  }

  function stop(record, status, code, message) {
    record.status = status;
    record.error = { code, message };
    stamp(record);
    persist();
    return new ShopError(code, message, view(record));
  }

  /** Trusted catalog row for an agent-chosen store and SKU. Merchant text never reaches a decision. */
  function catalogRow(storeId, sku) {
    let quote;
    try {
      quote = getQuote(storeId, sku);
    } catch (error) {
      if (error.code === 'store_not_found') throw new ShopError('unknown_store', `Unknown store ${storeId}.`);
      throw new ShopError('unknown_sku', `No SKU ${sku} at ${storeId}.`);
    }
    storeResource(storeId, sku);
    if (!quote.verified) throw new ShopError('unverified_store', `${storeId} is not a verified demo shop. Nothing can be bought there.`);
    return quote;
  }

  function requirePolicyFacts() {
    if (guardrailMode !== 'required') return;
    throw new ShopError('booking_facts_missing', 'Required guardrail mode needs a trusted visit date and area for this item. The shop catalog does not supply them, so the purchase is refused.');
  }

  async function limitsRoom(amountWei) {
    const budget = await payments.getBudget();
    if (budget.maxBooking != null && amountWei > wei(budget.maxBooking)) {
      throw new ShopError('amount_limit', `${formatRlusd(amountWei)} RLUSD is above the per-item maximum of ${budget.maxBooking} RLUSD.`);
    }
    const committed = wei(budget.reserved) + wei(budget.spent);
    if (budget.spendCeiling != null && committed + amountWei > wei(budget.spendCeiling)) {
      throw new ShopError('spend_ceiling', `This purchase would put reserved plus spent above the ${budget.spendCeiling} RLUSD ceiling.`);
    }
    if (budget.remaining != null && amountWei > wei(budget.remaining)) {
      throw new ShopError('over_budget', `${formatRlusd(amountWei)} RLUSD is above the remaining ${budget.remaining} RLUSD.`);
    }
  }

  async function checkChallenge(storeId, sku, amountWei) {
    if (!readChallengePrice) {
      if (mode === 'mock') return;
      throw new ShopError('seller_unavailable', 'Live shop purchases need the x402 challenge reader. Nothing was prepared.');
    }
    let asked;
    try {
      asked = await readChallengePrice(storeId, sku);
    } catch (error) {
      const code = error?.code === 'challenge_mismatch' ? 'challenge_mismatch' : 'seller_unavailable';
      throw new ShopError(code, `The shop gave no acceptable x402 challenge: ${String(error?.message).slice(0, 200)}`);
    }
    if (asked !== amountWei) {
      throw new ShopError('price_changed', `The shop asks ${formatRlusd(asked)} RLUSD over x402, not the catalog ${formatRlusd(amountWei)} RLUSD.`);
    }
  }

  function prepare(input) {
    return exclusive(async () => {
      rejectUnknown(input, ['storeId', 'sku', 'maximumAmount', 'idempotencyKey']);
      const { storeId, sku, maximumAmount, idempotencyKey: key } = input;
      if (typeof key !== 'string' || key.length < 1 || key.length > 128) {
        throw new ShopError('invalid_request', 'idempotencyKey must be 1 to 128 characters.');
      }
      if (typeof storeId !== 'string' || storeId.length === 0 || typeof sku !== 'string' || sku.length === 0) {
        throw new ShopError('invalid_request', 'storeId and sku are required.');
      }
      if (typeof maximumAmount !== 'string') throw new ShopError('invalid_request', 'maximumAmount must be an RLUSD decimal string such as "0.15".');
      let maximumWei;
      try { maximumWei = parseRlusd(maximumAmount); } catch (error) { throw new ShopError('invalid_request', error.message); }
      const maximum = formatRlusd(maximumWei);
      expireDue();
      const bound = state.idempotency[key];
      if (bound) {
        if (bound.storeId !== storeId || bound.sku !== sku || bound.maximumAmount !== maximum) {
          throw new ShopError('idempotency_conflict', 'idempotencyKey is already bound to a different purchase.');
        }
        return result(state.purchases[bound.purchaseId]);
      }
      const row = catalogRow(storeId, sku);
      const quotedWei = parseRlusd(row.amount);
      if (quotedWei > maximumWei) {
        throw new ShopError('price_above_maximum', `${storeId} ${sku} costs ${row.amount} RLUSD, above the maximum ${maximum} RLUSD.`);
      }
      requirePolicyFacts();
      await limitsRoom(quotedWei);
      await checkChallenge(storeId, sku, quotedWei);
      const purchaseId = `shp_${randomBytes(12).toString('hex')}`;
      const createdAt = new Date(now()).toISOString();
      const snapshot = {
        storeId,
        sku,
        title: row.title,
        quantity: 1,
        quotedAmount: formatRlusd(quotedWei),
        maximumAmount: maximum,
        currency: 'RLUSD',
        expiresAt: new Date(now() + PREPARE_TTL_MS).toISOString(),
        mode,
        policyVersion: COMPATIBILITY_POLICY,
      };
      state.purchases[purchaseId] = {
        purchaseId,
        idempotencyKey: key,
        snapshot,
        digest: digestOf(snapshot),
        status: 'prepared',
        approval: null,
        intentAt: null,
        operationKey: `shop:${purchaseId}`,
        escrowId: null,
        chargedAmount: null,
        payment: null,
        resource: null,
        error: null,
        createdAt,
        updatedAt: createdAt,
      };
      state.idempotency[key] = { purchaseId, storeId, sku, maximumAmount: maximum };
      persist();
      return result(state.purchases[purchaseId]);
    });
  }

  /** Trusted host only (server.mjs checks X-Store-Approval-Token). Not an agent tool. */
  function approve(input) {
    return exclusive(() => {
      rejectUnknown(input, ['purchaseId']);
      const record = mustGet(input.purchaseId);
      expireDue();
      if (record.status === 'approved') return result(record);
      if (record.status === 'expired') throw new ShopError('purchase_expired', 'The preparation expired. Prepare a new purchase.', view(record));
      if (record.status !== 'prepared') throw new ShopError('invalid_state', `A ${record.status} purchase cannot be approved.`, view(record));
      record.approval = {
        digest: record.digest,
        policyVersion: record.snapshot.policyVersion,
        expiresAt: record.snapshot.expiresAt,
        approvedAt: new Date(now()).toISOString(),
      };
      record.status = 'approved';
      stamp(record);
      persist();
      return result(record);
    });
  }

  function approvalHolds(record) {
    const approval = record.approval;
    return Boolean(approval)
      && approval.digest === digestOf(record.snapshot)
      && approval.digest === record.digest
      && approval.policyVersion === COMPATIBILITY_POLICY
      && approval.expiresAt === record.snapshot.expiresAt
      && !pastExpiry(record);
  }

  function markPaid(record, escrow) {
    const live = escrow.live === true;
    record.status = 'paid';
    record.chargedAmount = escrow.finalBill ?? escrow.amount;
    record.payment = {
      live,
      paidVia: live ? escrow.paidVia : null,
      txHash: live ? escrow.txHash : null,
      explorerUrl: live ? escrow.explorerUrl : null,
      receiptUrl: live ? escrow.receiptUrl : null,
    };
    record.resource = escrow.resource ?? (mode === 'mock'
      ? { storeId: record.snapshot.storeId, sku: record.snapshot.sku, title: record.snapshot.title, demo: true, note: 'Mock payment: fictional shop, nothing charged or delivered.' }
      : null);
    record.error = null;
    stamp(record);
    persist();
  }

  function notePending(record, code, message) {
    record.error = { code, message: String(message).slice(0, 300) };
    stamp(record);
    persist();
  }

  async function onPaymentFailure(record, escrowId, error) {
    if (error?.code === 'injected_crash') throw error;
    const code = error?.code ?? 'seller_unavailable';
    const message = String(error?.message ?? 'Payment failed.').slice(0, 300);
    if (code === 'overcharged') {
      throw stop(record, 'failed', 'price_changed', 'The shop raised its x402 price above the approved quote. Nothing was signed. Prepare a new purchase.');
    }
    const current = await payments.getStatus(escrowId);
    if (current.status === 'paying' || payments.hasSignedPayment(escrowId)) return notePending(record, code, message);
    if (current.status === 'locked') await payments.refund(escrowId);
    throw stop(record, 'failed', code, message);
  }

  async function release(record, escrowId) {
    try {
      const paid = await payments.release(escrowId);
      crash('after_confirmation');
      markPaid(record, paid);
    } catch (error) {
      await onPaymentFailure(record, escrowId, error);
    }
  }

  /** Drive a 'paying' purchase. Signs only through release() of its own locked escrow while approval holds. */
  async function advance(record) {
    let escrowId = record.escrowId ?? payments.escrowForOperation(record.operationKey);
    if (!escrowId) {
      if (pastExpiry(record)) throw stop(record, 'cancelled', 'purchase_expired', 'The approval expired before anything was reserved. Nothing was signed.');
      try {
        escrowId = await payments.createEscrow(record.snapshot.storeId, record.snapshot.quotedAmount, ESCROW_DEADLINE_SECONDS, record.snapshot.sku, record.operationKey);
      } catch (error) {
        throw stop(record, 'failed', error?.code ?? 'invalid_state', String(error?.message ?? 'Reservation failed.').slice(0, 300));
      }
      crash('after_escrow_created');
    }
    if (!record.escrowId) {
      record.escrowId = escrowId;
      stamp(record);
      persist();
      crash('after_escrow');
    }
    const current = await payments.getStatus(escrowId);
    if (current.status === 'delivered') return markPaid(record, current);
    if (current.status === 'paying') return release(record, escrowId);
    if (current.status === 'overcharged') throw stop(record, 'failed', 'price_changed', 'The shop price changed before signing. Nothing was signed.');
    if (current.status === 'locked') {
      if (!pastExpiry(record)) return release(record, escrowId);
      if (payments.hasSignedPayment(escrowId)) return notePending(record, 'payment_unresolved', 'A signed payment exists; waiting for chain evidence.');
      await payments.refund(escrowId);
      throw stop(record, 'cancelled', 'purchase_expired', 'The approval expired before payment started. The reservation was released; nothing was signed.');
    }
    if (payments.hasSignedPayment(escrowId)) return notePending(record, 'payment_unresolved', 'A signed payment exists; waiting for chain evidence.');
    throw stop(record, 'failed', 'reservation_released', `The reservation is ${current.status}; nothing was paid.`);
  }

  function pay(input) {
    return exclusive(async () => {
      rejectUnknown(input, ['purchaseId']);
      const record = mustGet(input.purchaseId);
      expireDue();
      if (record.status === 'paid') {
        await refreshReceipt(record);
        return result(record);
      }
      if (record.status === 'paying') {
        await advance(record);
        return result(record);
      }
      if (record.status === 'prepared') throw new ShopError('approval_required', 'The user has not approved this purchase in the host app.', view(record));
      if (record.status === 'expired') throw new ShopError('purchase_expired', 'The preparation expired. Prepare a new purchase with a new idempotencyKey.', view(record));
      if (record.status === 'failed') throw new ShopError(record.error.code, record.error.message, view(record));
      if (record.status !== 'approved') throw new ShopError('invalid_state', `A ${record.status} purchase cannot be paid.`, view(record));
      if (!approvalHolds(record)) throw new ShopError('approval_required', 'The approval does not match this purchase.', view(record));
      const row = catalogRow(record.snapshot.storeId, record.snapshot.sku);
      if (formatRlusd(parseRlusd(row.amount)) !== record.snapshot.quotedAmount) {
        throw stop(record, 'failed', 'price_changed', 'The catalog price changed after approval. Nothing was reserved or signed.');
      }
      requirePolicyFacts();
      await limitsRoom(parseRlusd(record.snapshot.quotedAmount));
      record.status = 'paying';
      record.intentAt = new Date(now()).toISOString();
      record.error = null;
      stamp(record);
      persist();
      crash('after_intent');
      await advance(record);
      return result(record);
    });
  }

  async function refreshReceipt(record) {
    if (!record.payment?.live || record.payment.receiptUrl || !record.escrowId) return;
    const current = await payments.getStatus(record.escrowId);
    if (!current.receiptUrl) return;
    record.payment.receiptUrl = current.receiptUrl;
    stamp(record);
    persist();
  }

  /** Never signs: confirms an already signed payment or reads the receipt. */
  async function reconcileOne(record) {
    if (record.status === 'paid') return refreshReceipt(record);
    if (record.status !== 'paying') return;
    const escrowId = record.escrowId ?? payments.escrowForOperation(record.operationKey);
    if (!escrowId) return;
    if (!record.escrowId) {
      record.escrowId = escrowId;
      stamp(record);
      persist();
    }
    const current = await payments.getStatus(escrowId);
    if (current.status === 'delivered') return markPaid(record, current);
    if (current.status !== 'paying' || !payments.hasSignedPayment(escrowId)) return;
    try {
      markPaid(record, await payments.release(escrowId));
    } catch (error) {
      notePending(record, error?.code ?? 'payment_unresolved', error?.message ?? 'Confirmation not available yet.');
    }
  }

  function get(input) {
    return exclusive(async () => {
      rejectUnknown(input, ['purchaseId']);
      const record = mustGet(input.purchaseId);
      expireDue();
      await reconcileOne(record);
      return result(record);
    });
  }

  function cancel(input) {
    return exclusive(async () => {
      rejectUnknown(input, ['purchaseId']);
      const record = mustGet(input.purchaseId);
      expireDue();
      if (record.status === 'cancelled') return result(record);
      const refuse = () => new ShopError('cannot_cancel', `A ${record.status} purchase cannot be cancelled. There is no automatic refund after payment.`, view(record));
      if (record.status === 'paying') {
        const escrowId = record.escrowId ?? payments.escrowForOperation(record.operationKey);
        if (escrowId) {
          if (payments.hasSignedPayment(escrowId)) throw refuse();
          const current = await payments.getStatus(escrowId);
          if (current.status === 'locked') await payments.refund(escrowId);
          else if (current.status !== 'refunded' && current.status !== 'overcharged' && current.status !== 'quoted') throw refuse();
          record.escrowId = escrowId;
        }
      } else if (record.status !== 'prepared' && record.status !== 'approved') {
        throw refuse();
      }
      record.status = 'cancelled';
      record.error = null;
      stamp(record);
      persist();
      return result(record);
    });
  }

  function sweep() {
    return exclusive(() => expireDue());
  }

  function reconcile() {
    return exclusive(async () => {
      expireDue();
      for (const record of Object.values(state.purchases)) await reconcileOne(record);
    });
  }

  return { prepare, approve, pay, get, cancel, sweep, reconcile, guardrailMode };
}
