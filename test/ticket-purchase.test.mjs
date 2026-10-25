import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMerchants } from '../merchants.mjs';
import { createPayments, formatRlusd, parseRlusd } from '../payments.mjs';
import { createTicketService } from '../tickets/service.mjs';

const START = Date.parse('2026-10-25T16:00:00.000Z');
const LABEL = 'Demo ticket — not valid for admission';
const INPUT = {
  attractionId: 'nyc-demo-art-gallery',
  sku: 'ART-ADULT',
  slotId: 'nyc-demo-art-gallery:2026-10-26:10:00',
  quantity: 1,
};
const quiet = { log() {}, warn() {}, error() {} };

function fakeExecutor({ cap = '2', prices = {}, loseOutcome = false, failResume = false, failRedeem = null } = {}) {
  const state = {
    cap: parseRlusd(cap),
    redeemed: 0n,
    prices,
    calls: [],
    redemptions: [],
    pending: new Map(),
    loseOutcome,
    failResume,
    failRedeem,
  };
  const channel = () => ({
    channelId: '0xchannel',
    status: 'open',
    cap: state.cap,
    redeemed: state.redeemed,
    agent: '0xagent',
    payout: '0xpayout',
    allocationId: '0xallocation',
    validBefore: 1_900_000_000,
    openedTx: '0xopened',
  });
  return {
    state,
    kind: 'live',
    channelId: '0xchannel',
    links: { tx: (hash) => (hash ? `https://explorer.test/tx/${hash}` : null), address: (value) => value },
    async readChannel() {
      state.calls.push('readChannel');
      return channel();
    },
    async readFund() {
      return { block: 1, asOf: new Date(0).toISOString(), allocation: { cap: state.cap, reserved: 0n, spent: 0n, available: state.cap }, reservation: { locked: 0n, settled: 0n }, thisChannel: { settled: 0n }, refunded: 0n, links: {} };
    },
    async quote(resourceUrl) {
      state.calls.push(`quote:${resourceUrl}`);
      const price = state.prices[resourceUrl];
      if (price == null) {
        const error = new Error('no 402');
        error.code = 'no_402';
        throw error;
      }
      return { resourceUrl, price, payTo: '0xpayout', previousCumulativeAmount: state.redeemed };
    },
    async redeem({ cumulativeAmount, expectedPrevious }) {
      state.calls.push(`redeem:${formatRlusd(cumulativeAmount)}`);
      if (state.failRedeem) throw new Error(state.failRedeem);
      const amount = cumulativeAmount - state.redeemed;
      state.redeemed = cumulativeAmount;
      const hit = { txHash: `0xtx${state.redemptions.length + 1}`, blockNumber: 10, claimId: '0xclaim', amount, previous: expectedPrevious, cumulativeAmount };
      state.redemptions.push(hit);
      return hit;
    },
    async buy({ resourceUrl, maximumAmount, operation }) {
      state.calls.push(`buy:${operation}`);
      const price = state.prices[resourceUrl];
      const previous = state.redeemed;
      const hit = await this.redeem({ cumulativeAmount: state.redeemed + price, expectedPrevious: state.redeemed });
      if (state.loseOutcome) {
        state.pending.set(operation, { operation, resourceUrl, maximumAmount, previousCumulativeAmount: previous, hit });
        throw new Error('purchase outcome unavailable');
      }
      return { ...hit, resource: { sellerId: resourceUrl, sku: 'ART-ADULT' } };
    },
    pendingPurchases() {
      return [...state.pending.values()].map(({ operation, resourceUrl, maximumAmount, previousCumulativeAmount }) => ({ operation, resourceUrl, maximumAmount, previousCumulativeAmount }));
    },
    async resume({ operation }) {
      state.calls.push(`resume:${operation}`);
      if (state.failResume) throw new Error('resume unavailable');
      const kept = state.pending.get(operation);
      if (!kept) throw new Error('already_complete');
      state.pending.delete(operation);
      return { ...kept.hit, resource: { sellerId: kept.resourceUrl, resumed: true } };
    },
    async findRedemption(cumulativeAmount) {
      return state.redemptions.find((row) => row.cumulativeAmount === cumulativeAmount) ?? null;
    },
    async recordRedemption() { return { ok: true }; },
    async settle() { return { payoutTx: null, settlementTx: null, receipts: [] }; },
    async verifyTx() { return 'confirmed'; },
    async closeTrip() { return { closeTx: '0xclose', payoutClosedTx: null, returned: 0n }; },
  };
}

function buys(executor) {
  return executor?.state.calls.filter((call) => call.startsWith('buy:')).length ?? 0;
}

function open(options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'swanavi-purchase-'));
  const clock = options.clock ?? { value: START };
  const mode = options.mode ?? 'mock';
  const executor = options.executor ?? null;
  const merchants = options.merchants ?? null;
  const payments = createPayments({
    mode,
    now: () => clock.value,
    storePath: join(dir, 'bookings.json'),
    executor,
    maxBooking: options.maxBooking ?? '4',
    spendCeiling: options.spendCeiling ?? '6',
    log: quiet,
    settleDelayMs: 1,
    resumeWaitMs: 0,
  });
  if (merchants) payments.setSellerResource(merchants.resourceFor);
  const tickets = createTicketService({
    payments,
    statePath: join(dir, 'tickets.json'),
    now: () => clock.value,
    mode,
    channelId: executor?.channelId ?? null,
    readSellerPrice: options.readSellerPrice,
    fault: options.fault ?? null,
  });
  return { dir, clock, payments, tickets, executor, merchants, mode };
}

function reopen(ctx, options = {}) {
  ctx.payments.stop();
  return open({
    dir: ctx.dir,
    clock: ctx.clock,
    mode: ctx.mode,
    executor: ctx.executor,
    merchants: ctx.merchants,
    readSellerPrice: options.readSellerPrice ?? ctx.readSellerPrice,
    maxBooking: options.maxBooking,
    fault: options.fault ?? null,
  });
}

async function held(tickets, slotId = INPUT.slotId) {
  const date = '2026-10-26';
  const body = await tickets.getSlots({ attractionId: slotId.slice(0, slotId.indexOf(':')), date });
  return body.slots.find((slot) => slot.slotId === slotId).available;
}

async function ready(ctx) {
  const quoted = await ctx.tickets.quote(INPUT);
  await ctx.tickets.approve({ quoteId: quoted.quote.quoteId });
  return quoted;
}

test('approved mock purchase issues one demo ticket and retries the same one', async () => {
  const ctx = open();
  try {
    const quoted = await ready(ctx);
    const bought = await ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' });
    assert.equal(bought.order.status, 'issued');
    assert.equal(bought.order.ticket.label, LABEL);
    assert.equal(bought.order.ticket.sku, 'ART-ADULT');
    assert.equal(bought.order.ticket.slotId, INPUT.slotId);
    assert.equal(bought.order.ticket.quantity, 1);
    assert.equal(quoted.quote.amount, '0.20');
    assert.equal(bought.order.payment.mode, 'mock');
    assert.equal(bought.order.payment.live, false);
    assert.equal(bought.order.payment.paidVia, null);
    assert.equal(bought.order.payment.txHash, null);
    assert.equal(await held(ctx.tickets), 4);
    const again = await ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' });
    const otherKey = await ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-2' });
    assert.equal(again.order.ticket.ticketId, bought.order.ticket.ticketId);
    assert.equal(again.order.ticket.confirmationCode, bought.order.ticket.confirmationCode);
    assert.equal(otherKey.order.ticket.ticketId, bought.order.ticket.ticketId);
    assert.equal((await ctx.payments.listEscrows()).length, 1);
    await assert.rejects(ctx.tickets.cancel({ orderId: bought.order.orderId }), (error) => error.code === 'cannot_cancel');
    const next = reopen(ctx);
    const reread = await next.tickets.getOrder({ orderId: bought.order.orderId });
    assert.equal(reread.order.ticket.confirmationCode, bought.order.ticket.confirmationCode);
    assert.equal((await next.payments.listEscrows()).length, 1);
    next.payments.stop();
  } finally {
    ctx.payments.stop();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('unapproved, expired, over budget, and client prices do not pay', async () => {
  const ctx = open();
  try {
    const quoted = await ctx.tickets.quote(INPUT);
    await assert.rejects(ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' }), (error) => error.code === 'approval_required');
    await assert.rejects(ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: '', }), (error) => error.code === 'invalid_request');
    await assert.rejects(ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'x'.repeat(129) }), (error) => error.code === 'invalid_request');
    await assert.rejects(ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1', amount: '0.01' }), (error) => error.code === 'invalid_request');
    assert.equal((await ctx.payments.listEscrows()).length, 0);
    await ctx.tickets.approve({ quoteId: quoted.quote.quoteId });
    ctx.clock.value = Date.parse(quoted.quote.expiresAt);
    await assert.rejects(ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' }), (error) => error.code === 'quote_expired');
    assert.equal(await held(ctx.tickets), 5);
    assert.equal((await ctx.payments.listEscrows()).length, 0);

    await ctx.payments.createEscrow('hotel', '0.40', 3600);
    await assert.rejects(ctx.tickets.quote({
      attractionId: 'nyc-demo-history-hall',
      sku: 'HISTORY-ADULT',
      slotId: 'nyc-demo-history-hall:2026-10-26:14:00',
      quantity: 1,
    }), (error) => error.code === 'policy_denied');
    assert.equal((await ctx.payments.listEscrows()).length, 1);
  } finally {
    ctx.payments.stop();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('a stricter per-ticket cap and a changed seller price never sign', async () => {
  const tight = open({ maxBooking: '0.10' });
  const price = { value: '0.20' };
  const changed = open({ readSellerPrice: async () => price.value });
  try {
    await assert.rejects(tight.tickets.quote(INPUT), (error) => error.code === 'policy_denied');
    assert.equal((await tight.payments.listEscrows()).length, 0);
    const quoted = await ready(changed);
    price.value = '0.30';
    await assert.rejects(changed.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' }), (error) => error.code === 'price_changed');
    assert.equal((await changed.tickets.getOrder({ orderId: quoted.orderId })).order.status, 'quoted');
    assert.equal((await changed.payments.listEscrows()).length, 0);
    assert.equal(await held(changed.tickets), 4);
  } finally {
    tight.payments.stop();
    changed.payments.stop();
    rmSync(tight.dir, { recursive: true, force: true });
    rmSync(changed.dir, { recursive: true, force: true });
  }
});

test('concurrent purchase retries and two keys produce one escrow and one ticket', async () => {
  const ctx = open();
  try {
    const quoted = await ready(ctx);
    const [first, second] = await Promise.all([
      ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-a' }),
      ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-b' }),
    ]);
    assert.equal(first.order.ticket.ticketId, second.order.ticket.ticketId);
    assert.equal((await ctx.payments.listEscrows()).length, 1);
    const other = await ctx.tickets.quote({ ...INPUT, slotId: 'nyc-demo-art-gallery:2026-10-26:14:00' });
    await ctx.tickets.approve({ quoteId: other.quote.quoteId });
    await assert.rejects(
      ctx.tickets.purchase({ quoteId: other.quote.quoteId, idempotencyKey: 'req-a' }),
      (error) => error.code === 'idempotency_conflict',
    );
    assert.equal((await ctx.tickets.getOrder({ orderId: other.orderId })).order.status, 'quoted');
    assert.equal((await ctx.payments.listEscrows()).length, 1);
  } finally {
    ctx.payments.stop();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('crashes before payment, after the escrow, after confirmation, and before the ticket recover once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swanavi-crash-'));
  try {
    const intent = open({ dir, fault: 'after_intent' });
    const quoted = await ready(intent);
    await assert.rejects(intent.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' }), (error) => error.code === 'injected_crash');
    let next = reopen(intent);
    assert.equal((await next.tickets.getOrder({ orderId: quoted.orderId })).order.status, 'payment_pending');
    assert.equal((await next.payments.listEscrows()).length, 0);
    assert.equal(await held(next.tickets), 4);
    let bought = await next.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' });
    assert.equal(bought.order.status, 'issued');
    assert.equal((await next.payments.listEscrows()).length, 1);
    next.payments.stop();
    rmSync(dir, { recursive: true, force: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  for (const fault of ['after_escrow_created', 'after_escrow']) {
    const ctx = open({ fault });
    try {
      const quoted = await ready(ctx);
      await assert.rejects(ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' }), (error) => error.code === 'injected_crash');
      const disk = JSON.parse(readFileSync(join(ctx.dir, 'tickets.json'), 'utf8'));
      if (fault === 'after_escrow_created') assert.equal(disk.orders[quoted.orderId].escrowId, null);
      const paused = reopen(ctx);
      assert.equal((await paused.tickets.getOrder({ orderId: quoted.orderId })).order.status, 'payment_pending');
      assert.equal((await paused.payments.getStatus((await paused.payments.listEscrows())[0].escrowId)).status, 'locked');
      const bought = await paused.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' });
      assert.equal(bought.order.status, 'issued');
      assert.equal((await paused.payments.listEscrows()).length, 1);
      assert.equal((await paused.payments.listEscrows())[0].status, 'delivered');
      paused.payments.stop();
    } finally {
      ctx.payments.stop();
      rmSync(ctx.dir, { recursive: true, force: true });
    }
  }

  const confirmed = open({ fault: 'after_confirmation' });
  try {
    const quoted = await ready(confirmed);
    await assert.rejects(confirmed.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' }), (error) => error.code === 'injected_crash');
    const paused = reopen(confirmed);
    const issued = await paused.tickets.getOrder({ orderId: quoted.orderId });
    assert.equal(issued.order.status, 'issued');
    assert.equal(issued.order.ticket.label, LABEL);
    const again = await paused.tickets.getOrder({ orderId: quoted.orderId });
    assert.equal(again.order.ticket.ticketId, issued.order.ticket.ticketId);
    assert.equal((await paused.payments.listEscrows()).length, 1);
    paused.payments.stop();
  } finally {
    confirmed.payments.stop();
    rmSync(confirmed.dir, { recursive: true, force: true });
  }

  const pendingTicket = open({ fault: 'before_ticket' });
  try {
    const quoted = await ready(pendingTicket);
    await assert.rejects(pendingTicket.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' }), (error) => error.code === 'injected_crash');
    const disk = JSON.parse(readFileSync(join(pendingTicket.dir, 'tickets.json'), 'utf8'));
    assert.equal(disk.orders[quoted.orderId].status, 'ticket_pending');
    assert.equal(disk.orders[quoted.orderId].ticket, null);
    const paused = reopen(pendingTicket);
    await paused.tickets.reconcile();
    const issued = await paused.tickets.getOrder({ orderId: quoted.orderId });
    assert.equal(issued.order.status, 'issued');
    const retried = await paused.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' });
    assert.equal(retried.order.ticket.ticketId, issued.order.ticket.ticketId);
    assert.equal((await paused.payments.listEscrows()).filter((row) => row.status === 'delivered').length, 1);
    paused.payments.stop();
  } finally {
    pendingTicket.payments.stop();
    rmSync(pendingTicket.dir, { recursive: true, force: true });
  }
});

test('live x402 purchase pays once, keeps the demo label, and recovers a lost confirmation', async () => {
  const merchants = createMerchants({ x402BaseUrl: 'http://127.0.0.1' });
  const url = merchants.resourceFor('nyc-demo-art-gallery', 'ART-ADULT');
  const executor = fakeExecutor({ prices: { [url]: parseRlusd('0.20') }, loseOutcome: true, failResume: true });
  const readSellerPrice = async (sellerId, sku) => formatRlusd((await executor.quote(merchants.resourceFor(sellerId, sku))).price);
  const ctx = open({ mode: 'ap4m', executor, merchants, readSellerPrice });
  try {
    const quoted = await ready(ctx);
    const pending = await ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-live' });
    assert.equal(pending.order.status, 'payment_pending');
    assert.equal(pending.order.ticket, null);
    assert.equal(buys(executor), 1);
    const resumesAfterLoss = executor.state.calls.filter((call) => call.startsWith('resume:')).length;
    ctx.clock.value = Date.parse(quoted.quote.expiresAt) + 1000;
    assert.equal(await held(ctx.tickets), 4);
    const watched = await ctx.tickets.getOrder({ orderId: pending.order.orderId });
    assert.equal(watched.order.status, 'payment_pending');
    assert.equal(buys(executor), 1);
    assert.equal(executor.state.calls.filter((call) => call.startsWith('resume:')).length, resumesAfterLoss);
    await assert.rejects(ctx.tickets.cancel({ orderId: pending.order.orderId }), (error) => error.code === 'cannot_cancel');
    executor.state.failResume = false;
    const issued = await ctx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-live' });
    assert.equal(issued.order.status, 'issued');
    assert.equal(issued.order.ticket.label, LABEL);
    assert.equal(issued.order.ticket.sku, 'ART-ADULT');
    assert.equal(issued.order.ticket.slotId, INPUT.slotId);
    assert.equal(issued.order.payment.mode, 'ap4m');
    assert.equal(issued.order.payment.live, true);
    assert.equal(issued.order.payment.paidVia, 'x402');
    assert.equal(typeof issued.order.payment.txHash, 'string');
    assert.equal(buys(executor), 1);
    assert.equal(executor.state.calls.filter((call) => call.startsWith('resume:')).length, resumesAfterLoss + 1);
    assert.equal((await ctx.payments.listEscrows()).length, 1);
  } finally {
    ctx.payments.stop();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('a higher 402 after approval and a failed redemption do not issue a ticket', async () => {
  const merchants = createMerchants({ x402BaseUrl: 'http://127.0.0.1' });
  const url = merchants.resourceFor('nyc-demo-art-gallery', 'ART-ADULT');
  const raised = fakeExecutor({ prices: { [url]: parseRlusd('0.30') } });
  const raisedCtx = open({
    mode: 'ap4m',
    executor: raised,
    merchants,
    readSellerPrice: async () => '0.20',
  });
  const failed = fakeExecutor({ prices: { [url]: parseRlusd('0.20') }, failRedeem: 'rpc refused' });
  const failedCtx = open({
    mode: 'ap4m',
    executor: failed,
    merchants,
    readSellerPrice: async () => '0.20',
  });
  try {
    const quoted = await ready(raisedCtx);
    await assert.rejects(raisedCtx.tickets.purchase({ quoteId: quoted.quote.quoteId, idempotencyKey: 'req-1' }), (error) => error.code === 'price_changed');
    assert.equal(buys(raised), 0);
    assert.equal((await raisedCtx.tickets.getOrder({ orderId: quoted.orderId })).order.status, 'failed');
    assert.equal(await held(raisedCtx.tickets), 5);

    const order = await ready(failedCtx);
    await assert.rejects(failedCtx.tickets.purchase({ quoteId: order.quote.quoteId, idempotencyKey: 'req-1' }), (error) => error.code === 'redeem_failed');
    assert.equal(failed.state.redeemed, 0n);
    assert.equal((await failedCtx.tickets.getOrder({ orderId: order.orderId })).order.ticket, null);
    assert.equal((await failedCtx.tickets.getOrder({ orderId: order.orderId })).order.status, 'failed');
    assert.equal(await held(failedCtx.tickets), 5);
    assert.equal((await failedCtx.payments.getBudget()).reserved, '0');
  } finally {
    raisedCtx.payments.stop();
    failedCtx.payments.stop();
    rmSync(raisedCtx.dir, { recursive: true, force: true });
    rmSync(failedCtx.dir, { recursive: true, force: true });
  }
});
