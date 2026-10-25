/**
 * Booking escrow, version 3. Two modes behind the same four functions
 * (createEscrow, release, refund, getStatus) and the same JSON shapes.
 *
 *   mock  Local ledger in memory. Nothing touches a chain. For rehearsals.
 *   ap4m  One AP4M channel per TRIP. A booking lock is a slice of the channel's remaining cap.
 *         release signs one cumulative voucher (previous total + this bill) and submits it:
 *         that is the on-chain event (VoucherRedeemed). refund of a booking frees its slice
 *         locally; the on-chain return of everything unspent happens when the trip channel is
 *         closed (vault PayoutClosed). The budget numbers come from chain reads, not memory.
 *
 * Nothing is ever signed above the quoted amount, for a seller marked cancel or fail, or above
 * the channel cap. All four functions are async in both modes.
 *
 * This file holds no key and imports no SDK. The live executor (ap4m_executor.mjs) is injected.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const BUDGET_RLUSD = '19';
export const STATES = ['quoted', 'locked', 'paying', 'delivered', 'refunded', 'overcharged'];
export const API_VERSION = 3;

const DECIMALS = 18n;
const UNIT = 10n ** DECIMALS;
const CHANNEL_CACHE_MS = 4000;
const FUND_CACHE_MS = 10000;

export class PaymentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PaymentError';
    this.code = code;
    this.details = details;
  }
}

export function parseRlusd(value) {
  let text;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new PaymentError('bad_amount', 'Fractional RLUSD must be a decimal string such as "0.40".');
    }
    text = String(value);
  } else if (typeof value === 'string') {
    text = value.trim();
  } else {
    throw new PaymentError('bad_amount', 'Amount must be a positive RLUSD decimal string.');
  }
  const match = /^(?:0|[1-9]\d*)(?:\.(\d{1,18}))?$/.exec(text);
  if (!match) {
    throw new PaymentError('bad_amount', 'Amount must be a positive RLUSD decimal with at most 18 places.');
  }
  const [whole, frac = ''] = text.split('.');
  const wei = BigInt(whole) * UNIT + BigInt(frac.padEnd(Number(DECIMALS), '0'));
  if (wei <= 0n) throw new PaymentError('bad_amount', 'Amount must be positive.');
  return wei;
}

export function formatRlusd(wei) {
  const negative = wei < 0n;
  const abs = negative ? -wei : wei;
  const whole = abs / UNIT;
  const frac = (abs % UNIT).toString().padStart(Number(DECIMALS), '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

function parseWei(value) {
  if (value === undefined || value === null || value === 0 || value === '0' || value === '0.0') return 0n;
  return parseRlusd(value);
}

export function createPayments({
  mode = 'mock',
  now = () => Date.now(),
  budget = BUDGET_RLUSD,
  sellerStatus = null,
  maxBooking = null,
  spendCeiling = null,
  storePath = null,
  onEvent = null,
  executor = null,
  log = console,
  settleDelayMs = 5000,
  resumeWaitMs = 6000,
} = {}) {
  if (mode !== 'mock' && mode !== 'ap4m') throw new PaymentError('bad_request', 'mode must be mock or ap4m.');
  if (typeof now !== 'function') throw new PaymentError('bad_request', 'now must be a function.');
  if (mode === 'ap4m' && !executor) throw new PaymentError('bad_request', 'ap4m mode needs a live executor. There is no stub.');
  const live = mode === 'ap4m';

  let budgetWei = parseRlusd(budget);
  let sellerOf = sellerStatus ?? (() => null);
  let resourceOf = () => null;
  let onChange = onEvent;
  let storeExtra = () => ({});
  let loadedSellers = [];
  const maxBookingWei = maxBooking == null ? null : parseRlusd(String(maxBooking));
  const ceilingWei = spendCeiling == null ? null : parseRlusd(String(spendCeiling));
  const escrows = new Map();
  let reserved = 0n;
  let spent = 0n;
  let refunded = 0n;
  let killed = false;
  let chainQueue = Promise.resolve();
  let settlementTimer = null;
  let settlementRunning = false;

  // Trip channel state (ap4m). Chain reads are cached briefly; events refresh them.
  const trip = {
    channelId: executor?.channelId ?? null,
    channel: null,
    channelAt: 0,
    fund: null,
    fundAt: 0,
    closed: null, // { closeTx, payoutClosedTx, returned, at }
  };

  // ---- totals ---------------------------------------------------------------------------

  function recompute() {
    reserved = 0n;
    spent = 0n;
    refunded = 0n;
    for (const escrow of escrows.values()) {
      if (escrow.status === 'locked' || escrow.status === 'paying') reserved += escrow.amountWei;
      else if (escrow.status === 'delivered') spent += escrow.finalBillWei ?? escrow.amountWei;
      refunded += escrow.returnedWei;
    }
  }

  function remainingMock() {
    return budgetWei - reserved - spent;
  }

  function remainingLive(channel) {
    return channel.cap - channel.redeemed - reserved;
  }

  async function readChannel(force = false) {
    if (!live) return null;
    if (!force && trip.channel && now() - trip.channelAt < CHANNEL_CACHE_MS) return trip.channel;
    try {
      trip.channel = await executor.readChannel();
      trip.channelAt = now();
    } catch (error) {
      if (trip.channel) return trip.channel;
      throw new PaymentError('chain_unavailable', `Could not read the trip channel: ${String(error.message).slice(0, 160)}`);
    }
    return trip.channel;
  }

  async function readFund(force = false) {
    if (!live) return null;
    if (!force && trip.fund && now() - trip.fundAt < FUND_CACHE_MS) return trip.fund;
    const channel = await readChannel();
    try {
      trip.fund = await executor.readFund(channel.allocationId);
      trip.fundAt = now();
    } catch (error) {
      if (trip.fund) return trip.fund;
      log.warn?.(`fund read failed: ${String(error.message).slice(0, 160)}`);
      return null;
    }
    return trip.fund;
  }

  // ---- views ----------------------------------------------------------------------------

  function mustGet(escrowId) {
    const escrow = escrows.get(escrowId);
    if (!escrow) throw new PaymentError('not_found', `Unknown escrow ${escrowId}.`, { escrowId });
    return escrow;
  }

  function noteFor(escrow) {
    if (!live) return 'mock: numbers in memory, nothing on chain';
    switch (escrow.status) {
      case 'locked': return 'reserved inside the trip channel cap (local); the cap itself is on chain';
      case 'paying': return 'voucher signed and submitted; waiting for the block';
      case 'delivered': return escrow.chainStatus === 'confirmed' ? (escrow.x402 ? 'x402: 402 read, voucher signed, seller redeemed it on chain (VoucherRedeemed)' : 'VoucherRedeemed on chain') : `redeem transaction ${escrow.chainStatus ?? 'unverified'}`;
      case 'refunded': return escrow.reason === 'trip_closed' ? 'unused cap returned on chain at trip close (PayoutClosed)' : 'nothing was signed; slice freed locally, cap returns on chain at trip close';
      case 'overcharged': return escrow.reason === 'x402_price_exceeds_lock' ? 'seller\'s 402 price above the lock; refused before signing' : 'bill above the quote; nothing was signed';
      default: return 'nothing reserved';
    }
  }

  function view(escrow) {
    const isLive = live && Boolean(escrow.txHash) && escrow.chainStatus === 'confirmed';
    return {
      escrowId: escrow.escrowId,
      sellerId: escrow.sellerId,
      amount: formatRlusd(escrow.amountWei),
      finalBill: escrow.finalBillWei === null ? null : formatRlusd(escrow.finalBillWei),
      status: escrow.status,
      reason: escrow.reason,
      createdAt: new Date(escrow.createdAt).toISOString(),
      updatedAt: new Date(escrow.updatedAt).toISOString(),
      deadlineAt: new Date(escrow.deadlineAt).toISOString(),
      txHash: escrow.txHash,
      explorerUrl: escrow.txHash && executor ? executor.links.tx(escrow.txHash) : null,
      claimId: escrow.claimId,
      blockNumber: escrow.blockNumber,
      cumulativeAmount: escrow.cumulativeWei === null ? null : formatRlusd(escrow.cumulativeWei),
      receiptUrl: escrow.settlement?.receiptUrl ?? null,
      settlement: escrow.settlement,
      channelId: live ? trip.channelId : null,
      chainStatus: escrow.chainStatus,
      paidVia: escrow.status === 'delivered' && live ? (escrow.x402 ? 'x402' : 'voucher') : null,
      resource: escrow.resource ?? null,
      repaired: escrow.repaired ?? null,
      live: isLive,
      badge: isLive ? 'LIVE' : live ? 'LOCAL' : 'MOCK',
      note: noteFor(escrow),
      mode,
    };
  }

  function tripView(channel) {
    if (!live || !channel) return null;
    return {
      channelId: trip.channelId,
      status: trip.closed ? 'closed' : channel.status,
      cap: formatRlusd(channel.cap),
      redeemed: formatRlusd(channel.redeemed),
      settled: trip.fund ? formatRlusd(trip.fund.thisChannel.settled) : null,
      merchantPayout: channel.payout,
      agent: channel.agent,
      validBefore: new Date(channel.validBefore * 1000).toISOString(),
      openedTxUrl: executor.links.tx(channel.openedTx),
      closeTxUrl: executor.links.tx(trip.closed?.closeTx ?? null),
      payoutClosedTxUrl: executor.links.tx(trip.closed?.payoutClosedTx ?? null),
      returned: trip.closed?.returned != null ? formatRlusd(trip.closed.returned) : null,
      live: true,
    };
  }

  function fundView(fund) {
    if (!fund) return null;
    return {
      deposit: formatRlusd(fund.allocation.cap),
      locked: formatRlusd(fund.reservation.locked),
      spent: formatRlusd(fund.allocation.spent),
      settled: formatRlusd(fund.reservation.settled),
      free: formatRlusd(fund.allocation.available),
      refunded: formatRlusd(fund.refunded),
      block: fund.block,
      asOf: fund.asOf,
      links: fund.links,
      live: true,
    };
  }

  function driftView(channel) {
    if (!live || !channel) return null;
    const delivered = [...escrows.values()].filter((e) => e.status === 'delivered').reduce((sum, e) => sum + (e.finalBillWei ?? e.amountWei), 0n);
    if (delivered === channel.redeemed) return null;
    return { chainRedeemed: formatRlusd(channel.redeemed), localDelivered: formatRlusd(delivered) };
  }

  function budgetView(channel = trip.channel, fund = trip.fund) {
    const base = {
      version: API_VERSION,
      currency: 'RLUSD',
      mode,
      live,
      badge: live ? 'LIVE' : 'MOCK',
      source: live ? 'chain' : 'memory',
      asOf: live && channel ? new Date(trip.channelAt).toISOString() : new Date(now()).toISOString(),
      block: fund?.block ?? null,
      maxBooking: maxBookingWei === null ? null : formatRlusd(maxBookingWei),
      spendCeiling: ceilingWei === null ? null : formatRlusd(ceilingWei),
      killed,
    };
    if (!live) {
      return {
        ...base,
        total: formatRlusd(budgetWei),
        remaining: formatRlusd(remainingMock()),
        reserved: formatRlusd(reserved),
        spent: formatRlusd(spent),
        refundedTotal: formatRlusd(refunded),
        trip: null,
        fund: null,
        drift: null,
      };
    }
    const onChainReturned = trip.closed?.returned ?? 0n;
    return {
      ...base,
      total: channel ? formatRlusd(channel.cap) : null,
      remaining: channel ? formatRlusd(trip.closed ? 0n : remainingLive(channel)) : null,
      reserved: formatRlusd(reserved),
      spent: channel ? formatRlusd(channel.redeemed) : null,
      refundedTotal: formatRlusd(refunded + onChainReturned),
      trip: tripView(channel),
      fund: fundView(fund),
      drift: driftView(channel),
    };
  }

  function changed(escrow, extra = {}) {
    const event = {
      type: 'booking',
      at: new Date(now()).toISOString(),
      booking: escrow ? view(escrow) : null,
      budget: budgetView(),
      ...extra,
    };
    onChange?.(event);
    save();
  }

  // ---- persistence ----------------------------------------------------------------------

  function save() {
    if (!storePath) return;
    const body = {
      version: 2,
      mode,
      killed,
      budgetTotal: formatRlusd(budgetWei),
      trip: live ? { channelId: trip.channelId, closed: trip.closed ? { ...trip.closed, returned: trip.closed.returned == null ? null : formatRlusd(trip.closed.returned) } : null } : null,
      bookings: [...escrows.values()].map((escrow) => ({
        escrowId: escrow.escrowId,
        sellerId: escrow.sellerId,
        amount: formatRlusd(escrow.amountWei),
        finalBill: escrow.finalBillWei === null ? null : formatRlusd(escrow.finalBillWei),
        status: escrow.status,
        reason: escrow.reason,
        createdAt: escrow.createdAt,
        updatedAt: escrow.updatedAt,
        deadlineAt: escrow.deadlineAt,
        txHash: escrow.txHash,
        claimId: escrow.claimId,
        blockNumber: escrow.blockNumber,
        cumulativeAmount: escrow.cumulativeWei === null ? null : formatRlusd(escrow.cumulativeWei),
        settlement: escrow.settlement,
        chainStatus: escrow.chainStatus,
        x402: escrow.x402 === true,
        resource: escrow.resource ?? null,
        repaired: escrow.repaired ?? null,
        returned: formatRlusd(escrow.returnedWei),
      })),
      sellers: storeExtra().sellers ?? [],
    };
    mkdirSync(dirname(storePath), { recursive: true });
    const temporary = `${storePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(body)}\n`);
    renameSync(temporary, storePath);
  }

  function load() {
    if (!storePath || !existsSync(storePath)) return;
    const saved = JSON.parse(readFileSync(storePath, 'utf8'));
    if (![1, 2].includes(saved.version) || !Array.isArray(saved.bookings)) {
      throw new PaymentError('bad_request', 'bookings file is not a known version.');
    }
    budgetWei = parseRlusd(saved.budgetTotal);
    killed = saved.killed === true;
    loadedSellers = Array.isArray(saved.sellers) ? saved.sellers : [];
    if (live && saved.trip?.channelId && saved.trip.channelId.toLowerCase() !== trip.channelId.toLowerCase()) {
      throw new PaymentError('bad_request', `bookings.json belongs to trip channel ${saved.trip.channelId}, not ${trip.channelId}. Move it aside or set TRIP_CHANNEL_ID to match.`);
    }
    if (live && saved.trip?.closed) {
      trip.closed = { ...saved.trip.closed, returned: saved.trip.closed.returned == null ? null : parseWei(saved.trip.closed.returned) };
    }
    escrows.clear();
    for (const row of saved.bookings) {
      escrows.set(row.escrowId, {
        escrowId: row.escrowId,
        sellerId: row.sellerId,
        amountWei: parseRlusd(row.amount),
        finalBillWei: row.finalBill == null ? null : parseRlusd(row.finalBill),
        status: row.status,
        reason: row.reason ?? null,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt ?? row.createdAt,
        deadlineAt: row.deadlineAt,
        txHash: row.txHash ?? null,
        claimId: row.claimId ?? null,
        blockNumber: row.blockNumber ?? null,
        cumulativeWei: row.cumulativeAmount == null ? null : parseWei(row.cumulativeAmount),
        settlement: row.settlement ?? null,
        chainStatus: row.chainStatus ?? (row.txHash ? 'unverified' : null),
        x402: row.x402 === true,
        resource: row.resource ?? null,
        repaired: row.repaired ?? null,
        returnedWei: parseWei(row.returned),
      });
    }
    recompute();
  }

  // ---- deadlines ------------------------------------------------------------------------

  /**
   * A deadline never refunds a booking the chain may have paid. In live mode a 'locked' row whose
   * payment was attempted (a retained x402 purchase exists for it) is handed to repairFromChain()
   * instead: the chain decides between delivered and refunded. 'paying' rows are never expired.
   */
  function expire(escrow) {
    if (escrow.status !== 'locked' || now() < escrow.deadlineAt) return;
    if (live && retainedPurchase(escrow)) {
      if (!escrow.repairing) {
        escrow.repairing = chainQueue.then(() => repairFromChain(escrow, 'deadline')).catch((error) => {
          log.warn?.(`${escrow.escrowId}: deadline repair failed, booking kept locked: ${String(error.message).slice(0, 120)}`);
        }).finally(() => { escrow.repairing = null; });
        chainQueue = escrow.repairing;
      }
      return;
    }
    escrow.returnedWei += escrow.amountWei;
    escrow.status = 'refunded';
    escrow.reason = 'deadline';
    escrow.updatedAt = now();
    recompute();
    changed(escrow);
  }

  function sweep() {
    for (const escrow of escrows.values()) expire(escrow);
  }

  /** The retained x402 purchase (agent-state/<operation>/purchase.json, complete: false) for this booking, if any. */
  function retainedPurchase(escrow) {
    if (!live || typeof executor.pendingPurchases !== 'function') return null;
    try {
      return executor.pendingPurchases().find((p) => p.operation === operationOf(escrow)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Repair a booking from chain evidence. Used when a deadline hits a row with a retained purchase,
   * and on restart for locked/redeem_failed or refunded/deadline rows. Never signs: if the retained
   * purchase's redemption (previous + maximum) is on chain the row becomes delivered (seller
   * confirmation via resume when possible, else the VoucherRedeemed event); if it is not on chain
   * and the deadline has passed the row is refunded; otherwise it is left alone.
   * Returns a change record or null.
   */
  async function repairFromChain(escrow, trigger) {
    const p = retainedPurchase(escrow);
    if (!p) return null;
    const expected = p.previousCumulativeAmount + p.maximumAmount;
    const hit = await executor.findRedemption(expected);
    const from = escrow.status;
    if (!hit) {
      if (escrow.status === 'locked' && now() >= escrow.deadlineAt) {
        escrow.returnedWei += escrow.amountWei;
        escrow.status = 'refunded';
        escrow.reason = 'deadline';
        escrow.updatedAt = now();
        recompute();
        changed(escrow);
        return { escrowId: escrow.escrowId, from, to: 'refunded', trigger };
      }
      return null;
    }
    let resumed = null;
    try { resumed = await executor.resume({ operation: p.operation }); } catch (error) { log.warn?.(`${escrow.escrowId}: resume failed, using the VoucherRedeemed event: ${String(error.message).slice(0, 120)}`); }
    const result = resumed ?? { ...hit, cumulativeAmount: expected, resource: null };
    if (escrow.status === 'refunded') escrow.returnedWei -= escrow.amountWei; // undo the wrong refund
    escrow.status = 'delivered';
    escrow.reason = null;
    escrow.txHash = result.txHash;
    escrow.claimId = result.claimId;
    escrow.blockNumber = result.blockNumber;
    escrow.chainStatus = 'confirmed';
    escrow.x402 = true;
    escrow.resource = result.resource ?? null;
    escrow.finalBillWei = result.amount ?? p.maximumAmount;
    escrow.cumulativeWei = expected;
    escrow.returnedWei += escrow.amountWei - escrow.finalBillWei;
    escrow.repaired = { from, reason: from === 'refunded' ? 'deadline' : 'redeem_failed', trigger, via: resumed ? 'resume' : 'VoucherRedeemed', at: new Date(now()).toISOString() };
    escrow.updatedAt = now();
    if (trip.channel && trip.channel.redeemed < expected) trip.channel = { ...trip.channel, redeemed: expected };
    recompute();
    changed(escrow);
    afterRedeem(result.txHash);
    return { escrowId: escrow.escrowId, from, to: 'delivered', txHash: result.txHash, via: escrow.repaired.via, trigger };
  }

  // ---- the four functions ---------------------------------------------------------------

  async function createEscrow(sellerId, amount, deadlineSeconds) {
    sweep();
    if (typeof sellerId !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(sellerId)) {
      throw new PaymentError('bad_request', 'sellerId must be a short lowercase id.');
    }
    if (!Number.isSafeInteger(deadlineSeconds) || deadlineSeconds <= 0) {
      throw new PaymentError('bad_request', 'deadlineSeconds must be a positive integer.');
    }
    if (killed) throw new PaymentError('killed', 'New locks are stopped.', { killed: true });
    const amountWei = parseRlusd(amount);
    const channel = await readChannel();
    if (live && (channel.status !== 'open' || trip.closed)) {
      throw new PaymentError('channel_closed', 'The trip channel is closed. No new lock is possible.', { channelId: trip.channelId });
    }
    const createdAt = now();
    const escrow = {
      escrowId: `escrow_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
      sellerId,
      amountWei,
      finalBillWei: null,
      status: 'quoted',
      reason: null,
      createdAt,
      updatedAt: createdAt,
      deadlineAt: createdAt + deadlineSeconds * 1000,
      txHash: null,
      claimId: null,
      blockNumber: null,
      cumulativeWei: null,
      settlement: null,
      chainStatus: null,
      x402: false,
      resource: null,
      returnedWei: 0n,
    };
    escrows.set(escrow.escrowId, escrow);
    const refuse = (code, reason, message, details) => {
      escrow.reason = reason;
      recompute();
      changed(escrow);
      throw new PaymentError(code, message, { escrowId: escrow.escrowId, status: 'quoted', amount: formatRlusd(amountWei), ...details });
    };
    if (maxBookingWei !== null && amountWei > maxBookingWei) {
      refuse('amount_limit', 'amount_limit', `Booking of ${formatRlusd(amountWei)} RLUSD exceeds the per-booking maximum of ${formatRlusd(maxBookingWei)} RLUSD.`, { maxBooking: formatRlusd(maxBookingWei) });
    }
    const spentForCeiling = live ? channel.redeemed : spent;
    if (ceilingWei !== null && reserved + spentForCeiling + amountWei > ceilingWei) {
      refuse('spend_ceiling', 'spend_ceiling', `This lock would put reserved plus spent above the ${formatRlusd(ceilingWei)} RLUSD ceiling.`, {
        spendCeiling: formatRlusd(ceilingWei), reserved: formatRlusd(reserved), spent: formatRlusd(spentForCeiling),
      });
    }
    const remaining = live ? remainingLive(channel) : remainingMock();
    if (amountWei > remaining) {
      refuse('over_budget', 'over_budget', `Lock of ${formatRlusd(amountWei)} RLUSD exceeds remaining ${formatRlusd(remaining)} RLUSD.`, { remaining: formatRlusd(remaining) });
    }
    escrow.status = 'locked';
    escrow.updatedAt = now();
    recompute();
    changed(escrow);
    return escrow.escrowId;
  }

  async function release(escrowId, finalBill) {
    const escrow = mustGet(escrowId);
    expire(escrow);
    if (live && escrow.status === 'paying' && escrow.cumulativeWei !== null) {
      // Paid on chain, confirmation missing: this release only retries the confirmation. No signature.
      const run = chainQueue.then(() => redeemLive(escrow, escrow.finalBillWei ?? escrow.amountWei));
      chainQueue = run.catch(() => {});
      return run;
    }
    if (escrow.status !== 'locked') {
      throw new PaymentError('invalid_state', `Cannot release an escrow that is ${escrow.status}.`, { escrowId, status: escrow.status });
    }
    const outcome = sellerOf(escrow.sellerId);
    if (outcome === 'cancel' || outcome === 'fail') {
      const code = outcome === 'cancel' ? 'seller_cancelled' : 'seller_failed';
      throw new PaymentError(code, `Seller ${escrow.sellerId} is ${outcome}. Release was refused. Nothing was signed. The lock is unchanged.`, {
        escrowId, status: 'locked', sellerId: escrow.sellerId, outcome,
      });
    }
    const billWei = finalBill === undefined ? escrow.amountWei : parseRlusd(finalBill);
    escrow.finalBillWei = billWei;
    if (billWei > escrow.amountWei) {
      escrow.status = 'overcharged';
      escrow.reason = 'final_bill_exceeds_lock';
      escrow.updatedAt = now();
      recompute();
      changed(escrow);
      throw new PaymentError('overcharged', 'Final bill exceeds the locked amount. Release was refused before any signature. The reservation returned to the budget.', {
        escrowId, status: 'overcharged', amount: formatRlusd(escrow.amountWei), finalBill: formatRlusd(billWei),
      });
    }
    if (!live) {
      escrow.returnedWei += escrow.amountWei - billWei;
      escrow.status = 'delivered';
      escrow.updatedAt = now();
      recompute();
      changed(escrow);
      return view(escrow);
    }
    // Live: one payment at a time. x402 when the seller has a resource URL, else a direct voucher.
    const run = chainQueue.then(() => redeemLive(escrow, billWei));
    chainQueue = run.catch(() => {});
    return run;
  }

  const operationOf = (escrow) => escrow.escrowId.replaceAll('_', '-');

  /**
   * The chain decides what a failed payment call meant. If the channel's redeemed total now equals
   * exactly what this booking was about to pay up to, the payment happened and only the confirmation
   * was lost. It is recovered WITHOUT signing anything: x402 -> executor.resume (re-sends the retained,
   * already-signed header; the seller replays its stored outcome), direct voucher -> the VoucherRedeemed
   * event. Returns { paid: false } when the chain shows no payment, { paid: 'unknown' } when the chain
   * cannot be read, { paid: true, result } when recovered, { paid: true, result: null } when not yet.
   */
  async function recoverPayment(escrow, expectedCumulative, resourceUrl, cause) {
    let fresh;
    try {
      fresh = await executor.readChannel();
    } catch (error) {
      log.warn?.(`${escrow.escrowId}: payment call failed and the chain cannot be read (${String(error.message).slice(0, 100)}); keeping the booking in 'paying'`);
      return { paid: 'unknown' };
    }
    trip.channel = fresh;
    trip.channelAt = now();
    if (fresh.redeemed !== expectedCumulative) return { paid: false };
    log.warn?.(`${escrow.escrowId}: the payment is on chain (redeemed ${formatRlusd(fresh.redeemed)}) but confirmation failed: ${String(cause?.message ?? cause).slice(0, 120)}. Recovering without signing.`);
    if (resumeWaitMs > 0) await new Promise((resolve) => setTimeout(resolve, resumeWaitMs));
    try {
      if (resourceUrl) {
        return { paid: true, result: await executor.resume({ operation: operationOf(escrow) }) };
      }
      const hit = await executor.findRedemption(expectedCumulative);
      return { paid: true, result: hit ? { ...hit, cumulativeAmount: expectedCumulative, resource: null } : null };
    } catch (error) {
      log.warn?.(`${escrow.escrowId}: recovery did not complete: ${String(error.message).slice(0, 120)}`);
      return { paid: true, result: null };
    }
  }

  function markDelivered(escrow, result, channel, billWei, resourceUrl) {
    if (result.amount != null && result.amount !== billWei) {
      // The chain is the truth: record what was actually paid.
      billWei = result.amount;
      escrow.finalBillWei = billWei;
    }
    escrow.cumulativeWei = result.cumulativeAmount ?? (channel.redeemed + billWei);
    escrow.status = 'delivered';
    escrow.reason = null;
    escrow.txHash = result.txHash;
    escrow.claimId = result.claimId;
    escrow.blockNumber = result.blockNumber;
    escrow.chainStatus = 'confirmed';
    escrow.x402 = Boolean(resourceUrl);
    escrow.resource = result.resource ?? null;
    escrow.returnedWei += escrow.amountWei - billWei;
    escrow.updatedAt = now();
    trip.channel = { ...channel, redeemed: escrow.cumulativeWei };
    trip.channelAt = now();
    recompute();
    changed(escrow);
    afterRedeem(result.txHash);
    return view(escrow);
  }

  function unconfirmed(escrow, resourceUrl) {
    // Paid on chain, confirmation still missing. The booking stays 'paying': it blocks a second payment,
    // the next release (or a restart) retries the recovery, and nothing is ever signed again for it.
    escrow.reason = 'redeem_unconfirmed';
    escrow.updatedAt = now();
    recompute();
    changed(escrow);
    return new PaymentError('redeem_unconfirmed', `The payment for ${escrow.escrowId} is on chain (channel redeemed ${formatRlusd(escrow.cumulativeWei)}) but the ${resourceUrl ? "seller's confirmation" : 'transaction lookup'} is not available yet. Nothing more will be signed for this booking. POST release again to retry the confirmation only.`, {
      escrowId: escrow.escrowId, status: 'paying', cumulativeAmount: formatRlusd(escrow.cumulativeWei),
    });
  }

  /** release() on a 'paying' booking: confirmation only, never a signature. */
  async function confirmPaying(escrow) {
    const resourceUrl = escrow.x402 ? resourceOf(escrow.sellerId) : null;
    const channel = trip.channel ?? await readChannel(true);
    const outcome = await recoverPayment(escrow, escrow.cumulativeWei, resourceUrl, 'release called while paying');
    if (outcome.paid === false) {
      escrow.status = 'locked';
      escrow.reason = 'redeem_failed';
      escrow.cumulativeWei = null;
      escrow.x402 = false;
      escrow.updatedAt = now();
      recompute();
      changed(escrow);
      throw new PaymentError('redeem_failed', 'The chain shows no payment for this booking. The lock is unchanged; release again to pay.', { escrowId: escrow.escrowId, status: 'locked' });
    }
    if (outcome.result) return markDelivered(escrow, outcome.result, channel, escrow.finalBillWei ?? escrow.amountWei, resourceUrl);
    throw unconfirmed(escrow, resourceUrl);
  }

  async function redeemLive(escrow, billWei) {
    if (escrow.status === 'paying' && escrow.cumulativeWei !== null) return confirmPaying(escrow);
    if (escrow.status !== 'locked') {
      throw new PaymentError('invalid_state', `Cannot release an escrow that is ${escrow.status}.`, { escrowId: escrow.escrowId, status: escrow.status });
    }
    const channel = await readChannel(true);
    if (channel.status !== 'open' || trip.closed) {
      throw new PaymentError('channel_closed', 'The trip channel is closed. Nothing was signed.', { escrowId: escrow.escrowId, status: 'locked' });
    }
    const resourceUrl = resourceOf(escrow.sellerId);
    const cumulative = channel.redeemed + billWei;
    if (cumulative > channel.cap) {
      throw new PaymentError('over_cap', `Paying ${formatRlusd(billWei)} would put the channel at ${formatRlusd(cumulative)}, above its cap ${formatRlusd(channel.cap)}. Nothing was signed.`, {
        escrowId: escrow.escrowId, status: 'locked', cap: formatRlusd(channel.cap), redeemed: formatRlusd(channel.redeemed),
      });
    }
    if (resourceUrl) {
      // x402: read the seller's 402 first. A price above this booking's bill is refused here, before any signature.
      let q;
      try {
        q = await executor.quote(resourceUrl);
      } catch (error) {
        throw new PaymentError('seller_unavailable', `Seller ${escrow.sellerId} gave no 402 at ${resourceUrl}: ${String(error.message).slice(0, 160)}. Nothing was signed.`, {
          escrowId: escrow.escrowId, status: 'locked', resourceUrl,
        });
      }
      if (q.price > billWei) {
        escrow.finalBillWei = q.price;
        escrow.status = 'overcharged';
        escrow.reason = 'x402_price_exceeds_lock';
        escrow.updatedAt = now();
        recompute();
        changed(escrow);
        throw new PaymentError('overcharged', `Seller ${escrow.sellerId} asks ${formatRlusd(q.price)} RLUSD over x402, above the ${formatRlusd(billWei)} this booking may pay. Refused before any signature. The reservation returned to the budget.`, {
          escrowId: escrow.escrowId, status: 'overcharged', amount: formatRlusd(escrow.amountWei), finalBill: formatRlusd(q.price), resourceUrl,
        });
      }
      billWei = q.price;
      escrow.finalBillWei = billWei;
    }
    escrow.status = 'paying';
    escrow.cumulativeWei = channel.redeemed + billWei;
    escrow.x402 = Boolean(resourceUrl);
    escrow.updatedAt = now();
    recompute();
    changed(escrow);
    let result;
    try {
      result = resourceUrl
        ? await executor.buy({ resourceUrl, maximumAmount: billWei, operation: operationOf(escrow) })
        : await executor.redeem({ cumulativeAmount: escrow.cumulativeWei, expectedPrevious: channel.redeemed });
    } catch (error) {
      // Auto-resume: did the payment land despite the error? Only the chain can say.
      const outcome = await recoverPayment(escrow, escrow.cumulativeWei, resourceUrl, error);
      if (outcome.paid === false) {
        escrow.status = 'locked';
        escrow.reason = 'redeem_failed';
        escrow.cumulativeWei = null;
        escrow.x402 = false;
        escrow.updatedAt = now();
        recompute();
        changed(escrow);
        throw new PaymentError('redeem_failed', `The payment did not go through: ${String(error.message).slice(0, 200)}. The lock is unchanged.`, {
          escrowId: escrow.escrowId, status: 'locked', cause: error.code ?? null,
        });
      }
      if (!outcome.result) throw unconfirmed(escrow, resourceUrl);
      result = outcome.result;
    }
    return markDelivered(escrow, result, channel, billWei, resourceUrl);
  }

  function afterRedeem(txHash) {
    executor.recordRedemption(txHash).catch((error) => log.warn?.(`record-redemption failed: ${String(error.message).slice(0, 120)}`));
    scheduleSettlement(settleDelayMs);
  }

  function scheduleSettlement(delayMs) {
    if (!live) return;
    if (settlementTimer) clearTimeout(settlementTimer);
    settlementTimer = setTimeout(() => { settlementTimer = null; runSettlement(0); }, delayMs);
    settlementTimer.unref?.();
  }

  async function runSettlement(attempt) {
    if (settlementRunning) return scheduleSettlement(10000);
    const pending = [...escrows.values()].filter((e) => e.status === 'delivered' && e.claimId && !e.settlement?.receiptUrl);
    if (pending.length === 0) return;
    settlementRunning = true;
    try {
      const settled = await executor.settle();
      const byClaim = new Map(settled.receipts.map((r) => [r.claimId.toLowerCase(), r]));
      let touched = false;
      for (const escrow of pending) {
        const receipt = byClaim.get(escrow.claimId.toLowerCase());
        if (!receipt) continue;
        escrow.settlement = {
          receiptUrl: receipt.receiptUrl,
          amountRlusd: receipt.amountRlusd,
          payoutTx: settled.payoutTx,
          payoutTxUrl: executor.links.tx(settled.payoutTx),
          settlementTx: settled.settlementTx,
          settlementTxUrl: executor.links.tx(settled.settlementTx),
          settledAt: new Date(now()).toISOString(),
        };
        escrow.updatedAt = now();
        touched = true;
        changed(escrow);
      }
      if (!touched || pending.some((e) => !e.settlement?.receiptUrl)) {
        if (attempt < 5) scheduleSettlement(20000);
      }
      trip.fundAt = 0;
    } catch (error) {
      log.warn?.(`settle failed (attempt ${attempt + 1}): ${String(error.message).slice(0, 160)}`);
      if (attempt < 5) {
        settlementRunning = false;
        settlementTimer = setTimeout(() => { settlementTimer = null; runSettlement(attempt + 1); }, 20000);
        settlementTimer.unref?.();
        return;
      }
    } finally {
      settlementRunning = false;
    }
  }

  async function refund(escrowId) {
    const escrow = mustGet(escrowId);
    expire(escrow);
    if (escrow.status === 'refunded') return view(escrow);
    if (escrow.status === 'quoted') {
      escrow.status = 'refunded';
      escrow.reason = 'refund';
      escrow.updatedAt = now();
      recompute();
      changed(escrow);
      return view(escrow);
    }
    if (escrow.status !== 'locked') {
      throw new PaymentError('invalid_state', `Cannot refund an escrow that is ${escrow.status}.`, { escrowId, status: escrow.status });
    }
    escrow.returnedWei += escrow.amountWei;
    escrow.status = 'refunded';
    escrow.reason = 'refund';
    escrow.updatedAt = now();
    recompute();
    changed(escrow);
    return view(escrow);
  }

  async function getStatus(escrowId) {
    const escrow = mustGet(escrowId);
    expire(escrow);
    if (escrow.repairing) await escrow.repairing;
    return view(escrow);
  }

  // ---- the rest -------------------------------------------------------------------------

  async function getBudget() {
    sweep();
    if (!live) return budgetView();
    const channel = await readChannel();
    const fund = await readFund();
    return budgetView(channel, fund);
  }

  async function listEscrows() {
    sweep();
    return [...escrows.values()].map(view);
  }

  async function fund(amount) {
    if (live) {
      throw new PaymentError('live_mode', 'Funding is on the AP4M participant portal in live mode. This server cannot credit the budget.');
    }
    const credit = parseRlusd(amount);
    budgetWei += credit;
    const budget = budgetView();
    onChange?.({ type: 'budget', at: new Date(now()).toISOString(), booking: null, budget });
    save();
    return { credited: formatRlusd(credit), budget };
  }

  async function setKilled(enabled) {
    killed = enabled === true;
    onChange?.({ type: 'kill', at: new Date(now()).toISOString(), killed, budget: budgetView() });
    save();
    return { killed, mode };
  }

  /** Close the trip: locked bookings are released, and in live mode the unused cap returns on chain. */
  async function closeTrip() {
    sweep();
    const paying = [...escrows.values()].find((e) => e.status === 'paying');
    if (paying) throw new PaymentError('in_progress', 'A payment is still being mined. Try again in a few seconds.', { escrowId: paying.escrowId });
    let result = { live: false, closeTx: null, closeTxUrl: null, payoutClosedTx: null, payoutClosedTxUrl: null, returned: null };
    if (live) {
      if (trip.closed) throw new PaymentError('channel_closed', 'The trip channel is already closed.', { channelId: trip.channelId });
      const run = chainQueue.then(() => executor.closeTrip());
      chainQueue = run.catch(() => {});
      let closed;
      try {
        closed = await run;
      } catch (error) {
        throw new PaymentError('close_failed', `Closing the trip channel failed: ${String(error.message).slice(0, 200)}`, { channelId: trip.channelId, cause: error.code ?? null });
      }
      trip.closed = { closeTx: closed.closeTx, payoutClosedTx: closed.payoutClosedTx, returned: closed.returned, at: new Date(now()).toISOString() };
      trip.channelAt = 0;
      trip.fundAt = 0;
      result = {
        live: Boolean(closed.payoutClosedTx),
        closeTx: closed.closeTx,
        closeTxUrl: executor.links.tx(closed.closeTx),
        payoutClosedTx: closed.payoutClosedTx,
        payoutClosedTxUrl: executor.links.tx(closed.payoutClosedTx),
        returned: closed.returned == null ? null : formatRlusd(closed.returned),
      };
    }
    let freed = 0n;
    for (const escrow of escrows.values()) {
      if (escrow.status !== 'locked') continue;
      escrow.returnedWei += escrow.amountWei;
      freed += escrow.amountWei;
      escrow.status = 'refunded';
      escrow.reason = 'trip_closed';
      escrow.updatedAt = now();
      recompute();
      changed(escrow);
    }
    if (live) {
      try { await readChannel(true); } catch { /* keep the last view */ }
    }
    const budget = await getBudget();
    onChange?.({ type: 'trip', at: new Date(now()).toISOString(), booking: null, budget, trip: budget.trip });
    save();
    return { ...result, freedLocks: formatRlusd(freed), channelId: trip.channelId, mode, budget };
  }

  /** On startup in live mode: make the stored bookings agree with the chain. */
  async function reconcile() {
    if (!live) return { mode, checked: 0, changes: [] };
    const changes = [];
    const channel = await readChannel(true);
    // Retained x402 purchases whose outcome never reached us (agent-state/<operation>/purchase.json, complete: false).
    const pending = new Map((executor.pendingPurchases?.() ?? []).map((p) => [p.operation, p]));
    for (const escrow of escrows.values()) {
      // Rows the old code left wrong although the chain has the payment: 'locked'/redeem_failed, or
      // 'refunded'/deadline (the deadline fired on a paid booking). Evidence: a retained x402 purchase
      // whose redemption is on chain. Repaired to delivered without signing; the row records the repair.
      const wrongLocked = escrow.status === 'locked' && escrow.reason === 'redeem_failed';
      const wrongRefund = escrow.status === 'refunded' && escrow.reason === 'deadline';
      if ((wrongLocked || wrongRefund) && pending.has(operationOf(escrow))) {
        const change = await repairFromChain(escrow, 'restart');
        if (change) changes.push(change);
        continue;
      }
      if (escrow.status === 'paying') {
        const hit = escrow.cumulativeWei === null ? null : await executor.findRedemption(escrow.cumulativeWei);
        if (hit) {
          let resumed = null;
          if (escrow.x402 && pending.has(operationOf(escrow))) {
            try { resumed = await executor.resume({ operation: operationOf(escrow) }); } catch (error) { log.warn?.(`${escrow.escrowId}: resume after restart failed: ${String(error.message).slice(0, 120)}`); }
          }
          escrow.status = 'delivered';
          escrow.reason = null;
          escrow.txHash = hit.txHash;
          escrow.claimId = hit.claimId;
          escrow.blockNumber = hit.blockNumber;
          escrow.chainStatus = 'confirmed';
          escrow.resource = resumed?.resource ?? escrow.resource ?? null;
          if (hit.amount != null) escrow.finalBillWei = hit.amount;
          escrow.returnedWei += escrow.amountWei - (escrow.finalBillWei ?? escrow.amountWei);
          changes.push({ escrowId: escrow.escrowId, from: 'paying', to: 'delivered', txHash: hit.txHash });
        } else {
          escrow.status = 'locked';
          escrow.reason = 'redeem_unconfirmed';
          escrow.cumulativeWei = null;
          changes.push({ escrowId: escrow.escrowId, from: 'paying', to: 'locked' });
        }
        escrow.updatedAt = now();
      } else if (escrow.status === 'delivered' && escrow.txHash) {
        const status = await executor.verifyTx(escrow.txHash);
        if (status !== escrow.chainStatus) {
          changes.push({ escrowId: escrow.escrowId, chainStatus: status });
          escrow.chainStatus = status;
        }
        if (status === 'failed') {
          escrow.status = 'locked';
          escrow.reason = 'redeem_failed';
          escrow.txHash = null;
          escrow.claimId = null;
          escrow.chainStatus = null;
          changes.push({ escrowId: escrow.escrowId, from: 'delivered', to: 'locked' });
        }
      }
    }
    if ((channel.status === 'closed') && !trip.closed) {
      trip.closed = { closeTx: null, payoutClosedTx: null, returned: null, at: new Date(now()).toISOString() };
      changes.push({ trip: 'closed on chain' });
      for (const escrow of escrows.values()) {
        if (escrow.status !== 'locked') continue;
        escrow.returnedWei += escrow.amountWei;
        escrow.status = 'refunded';
        escrow.reason = 'trip_closed';
        escrow.updatedAt = now();
        changes.push({ escrowId: escrow.escrowId, from: 'locked', to: 'refunded' });
      }
    }
    recompute();
    save();
    const drift = driftView(channel);
    if (drift) log.warn?.(`drift: chain redeemed ${drift.chainRedeemed}, local delivered ${drift.localDelivered}`);
    scheduleSettlement(settleDelayMs);
    await readFund(true).catch(() => null);
    return { mode, checked: escrows.size, changes, drift, channel: tripView(channel) };
  }

  async function exportState() {
    sweep();
    return {
      version: API_VERSION,
      mode,
      killed,
      budgetTotal: formatRlusd(budgetWei),
      bookings: [...escrows.values()].map((escrow) => view(escrow)),
    };
  }

  load();
  return {
    mode,
    live,
    createEscrow,
    release,
    refund,
    getStatus,
    getBudget,
    listEscrows,
    fund,
    setKilled,
    closeTrip,
    reconcile,
    exportState,
    sweep,
    loadedSellers,
    setSellerStatus(fn) { sellerOf = fn; },
    setSellerResource(fn) { resourceOf = fn; },
    setOnEvent(fn) { onChange = fn; },
    setStoreExtra(fn) { storeExtra = fn; },
    flush() { save(); },
    stop() { if (settlementTimer) clearTimeout(settlementTimer); },
  };
}
