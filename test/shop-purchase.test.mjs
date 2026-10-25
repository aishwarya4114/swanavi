import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { STORE_RESOURCES, createMerchants } from '../merchants.mjs';
import { createPayments, formatRlusd, parseRlusd } from '../payments.mjs';
import { startServer } from '../server.mjs';
import { STORES, getQuote } from '../stores/catalog.mjs';
import { TOOLS, handlePurchaseMcp } from '../stores/purchase-mcp.mjs';
import { PREPARE_TTL_MS, createShopPurchases } from '../stores/purchases.mjs';
import { checkPaymentRequired } from '../x402_challenge.mjs';

const START = Date.parse('2026-10-25T16:00:00.000Z');
const quiet = { log() {}, warn() {}, error() {} };
const BIKE = { storeId: 'central-park-bikes', sku: 'BIKE-2H', maximumAmount: '0.15', idempotencyKey: 'demo-bike-001' };
const BASE = 'http://127.0.0.1';
const urls = createMerchants({ x402BaseUrl: BASE });
const BIKE_URL = urls.resourceFor('central-park-bikes', 'BIKE-2H');

function catalogPrices() {
  return Object.fromEntries(STORE_RESOURCES.map((entry) => [urls.resourceFor(entry.sellerId, entry.sku), parseRlusd(entry.price)]));
}

function fakeExecutor({ prices = catalogPrices(), loseOutcome = false, failResume = false, receipts = true, quoteError = null } = {}) {
  const state = { cap: parseRlusd('2'), redeemed: 0n, prices, calls: [], redemptions: [], pending: new Map(), loseOutcome, failResume, receipts, quoteError };
  return {
    state,
    kind: 'live',
    channelId: '0xchannel',
    links: { tx: (hash) => (hash ? `https://explorer.test/tx/${hash}` : null), address: (value) => value },
    async readChannel() {
      return { channelId: '0xchannel', status: 'open', cap: state.cap, redeemed: state.redeemed, agent: '0xagent', payout: '0xpayout', allocationId: '0xallocation', validBefore: 1_900_000_000, openedTx: '0xopened' };
    },
    async readFund() {
      return { block: 1, asOf: new Date(0).toISOString(), allocation: { cap: state.cap, reserved: 0n, spent: 0n, available: state.cap }, reservation: { locked: 0n, settled: 0n }, thisChannel: { settled: 0n }, refunded: 0n, links: {} };
    },
    async quote(resourceUrl) {
      state.calls.push(`quote:${resourceUrl}`);
      if (state.quoteError) {
        const error = new Error(state.quoteError.message);
        error.code = state.quoteError.code;
        throw error;
      }
      const price = state.prices[resourceUrl];
      if (price == null) throw Object.assign(new Error('connection refused'), { code: 'no_402' });
      return { resourceUrl, price, payTo: '0xpayout' };
    },
    async buy({ resourceUrl, maximumAmount, operation }) {
      state.calls.push(`buy:${operation}`);
      const price = state.prices[resourceUrl];
      if (price > maximumAmount) throw Object.assign(new Error('price above max'), { code: 'price_above_max' });
      const previous = state.redeemed;
      state.redeemed += price;
      const hit = { txHash: `0xtx${state.redemptions.length + 1}`, blockNumber: 10, claimId: `0xclaim${state.redemptions.length + 1}`, amount: price, previous, cumulativeAmount: state.redeemed };
      state.redemptions.push(hit);
      const resource = { sellerId: resourceUrl, paid: true };
      if (state.loseOutcome) {
        state.pending.set(operation, { operation, resourceUrl, maximumAmount, previousCumulativeAmount: previous, hit, resource });
        throw new Error('purchase outcome unavailable');
      }
      return { ...hit, resource };
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
      return { ...kept.hit, resource: kept.resource };
    },
    async findRedemption(cumulativeAmount) {
      return state.redemptions.find((row) => row.cumulativeAmount === cumulativeAmount) ?? null;
    },
    async recordRedemption() { return { ok: true }; },
    async settle() {
      state.calls.push('settle');
      const receipts = state.receipts ? state.redemptions.map((row) => ({ claimId: row.claimId, amountRlusd: formatRlusd(row.amount), receiptUrl: `https://ap4m.test/receipt/${row.claimId}` })) : [];
      return { payoutTx: '0xpayoutTx', settlementTx: '0xsettle', receipts };
    },
    async verifyTx() { return 'confirmed'; },
    async closeTrip() { return { closeTx: null, payoutClosedTx: null, returned: 0n }; },
  };
}

const signatures = (executor) => executor?.state.calls.filter((call) => call.startsWith('buy:')).length ?? 0;

function open(options = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'swanavi-shop-'));
  const clock = options.clock ?? { value: START };
  const executor = options.executor ?? null;
  const mode = executor ? 'ap4m' : 'mock';
  const payments = createPayments({
    mode,
    now: () => clock.value,
    storePath: join(dir, 'bookings.json'),
    executor,
    maxBooking: options.maxBooking ?? '0.30',
    spendCeiling: options.spendCeiling ?? '6',
    guardrailMode: options.guardrailMode ?? 'compatibility',
    log: quiet,
    settleDelayMs: 1,
    resumeWaitMs: 0,
  });
  if (executor) payments.setSellerResource((sellerId, sku) => urls.resourceFor(sellerId, sku));
  const shop = createShopPurchases({
    payments,
    statePath: join(dir, 'shop-state.json'),
    now: () => clock.value,
    mode,
    channelId: executor?.channelId ?? null,
    readChallengePrice: executor ? async (storeId, sku) => (await executor.quote(urls.resourceFor(storeId, sku))).price : null,
    fault: options.fault ?? null,
  });
  return { dir, clock, executor, payments, shop, options };
}

function reopen(ctx, options = {}) {
  ctx.payments.stop();
  return open({ ...ctx.options, dir: ctx.dir, clock: ctx.clock, executor: ctx.executor, fault: options.fault ?? null });
}

async function approved(ctx, input = BIKE) {
  const { purchase } = await ctx.shop.prepare(input);
  await ctx.shop.approve({ purchaseId: purchase.purchaseId });
  return purchase.purchaseId;
}

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

test('all ten shop SKUs map to distinct x402 resources at catalog prices', () => {
  assert.equal(STORE_RESOURCES.length, 10);
  assert.equal(new Set(STORE_RESOURCES.map((entry) => entry.x402Port)).size, 10);
  for (const entry of STORE_RESOURCES) {
    assert.equal(entry.price, getQuote(entry.sellerId, entry.sku).amount);
    assert.equal(new URL(urls.resourceFor(entry.sellerId, entry.sku)).port, String(entry.x402Port));
  }
  assert.equal(urls.resourceFor('central-park-bikes', 'BIKE-2H'), 'http://127.0.0.1:4321/resource');
  assert.equal(urls.resourceFor('central-park-bikes', 'BIKE-4H'), 'http://127.0.0.1:4322/resource');
});

test('mock bike purchase: prepare, host approval, pay; no fake chain evidence', async () => {
  const ctx = open();
  const { purchase: prepared } = await ctx.shop.prepare(BIKE);
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.quotedAmount, '0.15');
  assert.equal(prepared.title, 'Two-hour bike rental');
  assert.equal(prepared.expiresAt, new Date(START + PREPARE_TTL_MS).toISOString());
  assert.equal((await ctx.payments.listEscrows()).length, 0, 'preparation reserves nothing');
  await rejects(ctx.shop.pay({ purchaseId: prepared.purchaseId }), 'approval_required');
  await ctx.shop.approve({ purchaseId: prepared.purchaseId });
  const { purchase } = await ctx.shop.pay({ purchaseId: prepared.purchaseId });
  assert.equal(purchase.status, 'paid');
  assert.equal(purchase.chargedAmount, '0.15');
  assert.equal(purchase.mode, 'mock');
  assert.equal(purchase.demo, true);
  assert.equal(purchase.live, false);
  assert.equal(purchase.paidVia, null);
  assert.equal(purchase.txHash, null);
  assert.equal(purchase.explorerUrl, null);
  assert.equal(purchase.receiptUrl, null);
  assert.equal(purchase.settlementStatus, 'not_started');
  assert.equal(purchase.resource.sku, 'BIKE-2H');
  const again = await ctx.shop.pay({ purchaseId: prepared.purchaseId });
  assert.deepEqual(again.purchase, purchase, 'repeated pay returns the same result');
  assert.equal((await ctx.payments.listEscrows()).length, 1);
});

test('every verified shop SKU purchases in mock; the unverified souvenir fixture is refused', async () => {
  const ctx = open({ spendCeiling: '19' });
  let n = 0;
  for (const store of STORES) {
    for (const offer of store.offers) {
      const input = { storeId: store.storeId, sku: offer.sku, maximumAmount: offer.amount, idempotencyKey: `all-${n += 1}` };
      if (!store.verified) {
        await rejects(ctx.shop.prepare({ ...input, maximumAmount: '10' }), 'unverified_store');
        continue;
      }
      const purchaseId = await approved(ctx, input);
      const { purchase } = await ctx.shop.pay({ purchaseId });
      assert.equal(purchase.status, 'paid', `${store.storeId}/${offer.sku}`);
      assert.equal(parseRlusd(purchase.chargedAmount), parseRlusd(offer.amount));
    }
  }
  assert.deepEqual((await ctx.payments.listEscrows()).map((row) => row.sku).sort(), STORE_RESOURCES.filter((entry) => entry.sku !== 'SOUVENIR-GOLD').map((entry) => entry.sku).sort());
});

test('invalid preparations sign nothing and read no challenge', async () => {
  const executor = fakeExecutor();
  const ctx = open({ executor });
  const cases = [
    [{ ...BIKE, sku: 'BIKE-9H' }, 'unknown_sku'],
    [{ ...BIKE, storeId: 'nowhere' }, 'unknown_store'],
    [{ storeId: 'times-square-souvenir', sku: 'SOUVENIR-GOLD', maximumAmount: '5', idempotencyKey: 'inject' }, 'unverified_store'],
    [{ ...BIKE, maximumAmount: '0.10' }, 'price_above_maximum'],
    [{ ...BIKE, maximumAmount: '0' }, 'invalid_request'],
    [{ ...BIKE, maximumAmount: '-1' }, 'invalid_request'],
    [{ ...BIKE, maximumAmount: 0.15 }, 'invalid_request'],
    [{ ...BIKE, idempotencyKey: '' }, 'invalid_request'],
    [{ ...BIKE, idempotencyKey: 'k'.repeat(129) }, 'invalid_request'],
    [{ ...BIKE, quantity: 2 }, 'invalid_request'],
    [{ ...BIKE, resourceUrl: 'http://evil.test/resource' }, 'invalid_request'],
    [{ ...BIKE, approved: true }, 'invalid_request'],
    [{ ...BIKE, verified: true }, 'invalid_request'],
    [{ ...BIKE, payTo: '0xattacker' }, 'invalid_request'],
  ];
  for (const [input, code] of cases) await rejects(ctx.shop.prepare(input), code);
  const tight = open({ executor, maxBooking: '0.10' });
  await rejects(tight.shop.prepare(BIKE), 'amount_limit');
  assert.equal(signatures(executor), 0);
  assert.equal(executor.state.calls.filter((call) => call.startsWith('quote:')).length, 0);
});

test('live preparation reads the 402 only; it reserves and signs nothing', async () => {
  const executor = fakeExecutor();
  const ctx = open({ executor });
  const { purchase } = await ctx.shop.prepare(BIKE);
  assert.deepEqual(executor.state.calls, [`quote:${BIKE_URL}`]);
  assert.equal((await ctx.payments.listEscrows()).length, 0);
  assert.equal(purchase.mode, 'ap4m');
  assert.equal(purchase.live, false);
});

test('challenge price drift, a bad challenge or an outage at preparation refuses before signing', async () => {
  const raised = fakeExecutor({ prices: { ...catalogPrices(), [BIKE_URL]: parseRlusd('0.20') } });
  await rejects(open({ executor: raised }).shop.prepare(BIKE), 'price_changed');
  const bad = fakeExecutor({ quoteError: { code: 'challenge_mismatch', message: 'Challenge payTo is not the channel payout.' } });
  await rejects(open({ executor: bad }).shop.prepare(BIKE), 'challenge_mismatch');
  const down = fakeExecutor({ prices: {} });
  await rejects(open({ executor: down }).shop.prepare(BIKE), 'seller_unavailable');
  assert.equal(signatures(raised) + signatures(bad) + signatures(down), 0);
});

test('a price increase after approval fails with no signature; a decrease is charged as paid', async () => {
  const up = fakeExecutor();
  const ctx = open({ executor: up });
  const id = await approved(ctx);
  up.state.prices[BIKE_URL] = parseRlusd('0.16');
  await rejects(ctx.shop.pay({ purchaseId: id }), 'price_changed');
  assert.equal(signatures(up), 0);
  assert.equal((await ctx.shop.get({ purchaseId: id })).purchase.status, 'failed');
  assert.equal((await ctx.payments.getBudget()).reserved, '0');

  const down = fakeExecutor();
  const cheap = open({ executor: down });
  const cheapId = await approved(cheap);
  down.state.prices[BIKE_URL] = parseRlusd('0.12');
  const { purchase } = await cheap.shop.pay({ purchaseId: cheapId });
  assert.equal(purchase.status, 'paid');
  assert.equal(purchase.quotedAmount, '0.15');
  assert.equal(purchase.chargedAmount, '0.12');
  assert.equal((await cheap.payments.getBudget()).spent, '0.12');
});

test('a challenge that fails binding at pay time and a seller outage keep funds and sign nothing', async () => {
  const executor = fakeExecutor();
  const ctx = open({ executor });
  const id = await approved(ctx);
  executor.state.quoteError = { code: 'challenge_mismatch', message: 'Challenge is for another channel.' };
  await rejects(ctx.shop.pay({ purchaseId: id }), 'challenge_mismatch');
  const failed = (await ctx.shop.get({ purchaseId: id })).purchase;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'challenge_mismatch');
  assert.equal((await ctx.payments.getBudget()).reserved, '0', 'definitely unpaid lock is released');
  executor.state.quoteError = null;
  const second = await approved(ctx, { ...BIKE, idempotencyKey: 'outage' });
  delete executor.state.prices[BIKE_URL];
  await rejects(ctx.shop.pay({ purchaseId: second }), 'seller_unavailable');
  assert.equal(signatures(executor), 0);
});

test('same idempotency key returns one purchase; changed arguments conflict; replay does not extend expiry', async () => {
  const ctx = open();
  const first = await ctx.shop.prepare(BIKE);
  ctx.clock.value += 60_000;
  const second = await ctx.shop.prepare({ ...BIKE, maximumAmount: '0.150' });
  assert.equal(second.purchase.purchaseId, first.purchase.purchaseId);
  assert.equal(second.purchase.expiresAt, first.purchase.expiresAt);
  await rejects(ctx.shop.prepare({ ...BIKE, sku: 'BIKE-4H', maximumAmount: '0.25' }), 'idempotency_conflict');
  await rejects(ctx.shop.prepare({ ...BIKE, maximumAmount: '0.20' }), 'idempotency_conflict');
});

test('an expired preparation cannot be approved or paid; an expired approval cannot start payment', async () => {
  const ctx = open();
  const { purchase } = await ctx.shop.prepare(BIKE);
  ctx.clock.value += PREPARE_TTL_MS;
  await rejects(ctx.shop.approve({ purchaseId: purchase.purchaseId }), 'purchase_expired');
  const id = await approved(ctx, { ...BIKE, idempotencyKey: 'late' });
  ctx.clock.value += PREPARE_TTL_MS;
  await rejects(ctx.shop.pay({ purchaseId: id }), 'purchase_expired');
  assert.equal((await ctx.payments.listEscrows()).length, 0);
});

test('concurrent and repeated pay calls produce one escrow, one signature and the same resource', async () => {
  const executor = fakeExecutor();
  const ctx = open({ executor });
  const id = await approved(ctx);
  const results = await Promise.all([1, 2, 3].map(() => ctx.shop.pay({ purchaseId: id })));
  const again = await ctx.shop.pay({ purchaseId: id });
  assert.equal(signatures(executor), 1);
  assert.equal((await ctx.payments.listEscrows()).length, 1);
  for (const { purchase } of [...results, again]) {
    assert.equal(purchase.status, 'paid');
    assert.equal(purchase.txHash, '0xtx1');
    assert.deepEqual(purchase.resource, results[0].purchase.resource);
  }
  const live = results[0].purchase;
  assert.equal(live.live, true);
  assert.equal(live.paidVia, 'x402');
  assert.equal(live.explorerUrl, 'https://explorer.test/tx/0xtx1');
  assert.equal(live.escrowId, (await ctx.payments.listEscrows())[0].escrowId);
});

for (const point of ['after_intent', 'after_escrow_created', 'after_escrow']) {
  test(`crash ${point} then restart resumes the same escrow with one signature`, async () => {
    const executor = fakeExecutor();
    const crashed = open({ executor, fault: point });
    const id = await approved(crashed);
    await rejects(crashed.shop.pay({ purchaseId: id }), 'injected_crash');
    const ctx = reopen(crashed);
    await ctx.payments.reconcile();
    await ctx.shop.reconcile();
    assert.equal(signatures(executor), 0, 'restart reconciliation signs nothing');
    const { purchase } = await ctx.shop.pay({ purchaseId: id });
    assert.equal(purchase.status, 'paid');
    assert.equal(signatures(executor), 1);
    assert.equal((await ctx.payments.listEscrows()).length, 1);
  });
}

test('crash before any reservation, restart after approval expiry: cancelled, nothing reserved', async () => {
  const crashed = open({ fault: 'after_intent' });
  const id = await approved(crashed);
  await rejects(crashed.shop.pay({ purchaseId: id }), 'injected_crash');
  crashed.clock.value += PREPARE_TTL_MS;
  const ctx = reopen(crashed);
  await rejects(ctx.shop.pay({ purchaseId: id }), 'purchase_expired');
  assert.equal((await ctx.shop.get({ purchaseId: id })).purchase.status, 'cancelled');
  assert.equal((await ctx.payments.listEscrows()).length, 0);
});

test('crash after escrow, restart after approval expiry: unpaid lock released, not paid', async () => {
  const crashed = open({ fault: 'after_escrow' });
  const id = await approved(crashed);
  await rejects(crashed.shop.pay({ purchaseId: id }), 'injected_crash');
  crashed.clock.value += PREPARE_TTL_MS;
  const ctx = reopen(crashed);
  await rejects(ctx.shop.pay({ purchaseId: id }), 'purchase_expired');
  assert.equal((await ctx.payments.listEscrows())[0].status, 'refunded');
});

test('lost confirmation with a mined payment resumes without another signature', async () => {
  const executor = fakeExecutor({ loseOutcome: true });
  const ctx = open({ executor });
  const id = await approved(ctx);
  const { purchase } = await ctx.shop.pay({ purchaseId: id });
  assert.equal(purchase.status, 'paid');
  assert.deepEqual(purchase.resource, { sellerId: BIKE_URL, paid: true });
  assert.equal(signatures(executor), 1);
  assert.equal(executor.state.calls.filter((call) => call.startsWith('resume:')).length, 1);
});

test('unknown outcome stays paying; cancel and expiry cannot free it; status polling confirms without signing', async () => {
  const executor = fakeExecutor({ loseOutcome: true, failResume: true });
  const ctx = open({ executor });
  const id = await approved(ctx);
  const { purchase } = await ctx.shop.pay({ purchaseId: id });
  assert.equal(purchase.status, 'paying');
  assert.equal(purchase.error.code, 'redeem_unconfirmed');
  await rejects(ctx.shop.cancel({ purchaseId: id }), 'cannot_cancel');
  ctx.clock.value += PREPARE_TTL_MS * 10;
  assert.equal((await ctx.shop.get({ purchaseId: id })).purchase.status, 'paying');
  assert.equal((await ctx.payments.getBudget()).reserved, '0.15', 'reservation is preserved');
  assert.equal((await ctx.shop.pay({ purchaseId: id })).purchase.status, 'paying');
  executor.state.failResume = false;
  const polled = await ctx.shop.get({ purchaseId: id });
  assert.equal(polled.purchase.status, 'paid');
  assert.equal(polled.purchase.txHash, '0xtx1');
  assert.equal(signatures(executor), 1);
});

test('receipt delay leaves the purchase paid; polling picks up settlement without another purchase', async () => {
  const executor = fakeExecutor({ receipts: false });
  const ctx = open({ executor });
  const id = await approved(ctx);
  const { purchase } = await ctx.shop.pay({ purchaseId: id });
  assert.equal(purchase.status, 'paid');
  assert.equal(purchase.settlementStatus, 'pending');
  assert.equal(purchase.receiptUrl, null);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await ctx.shop.get({ purchaseId: id })).purchase.settlementStatus, 'pending');
  executor.state.receipts = true;
  ctx.payments.stop();
  await ctx.payments.reconcile();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const settled = (await ctx.shop.get({ purchaseId: id })).purchase;
  assert.equal(settled.status, 'paid');
  assert.equal(settled.settlementStatus, 'settled');
  assert.equal(settled.receiptUrl, 'https://ap4m.test/receipt/0xclaim1');
  assert.equal(signatures(executor), 1);
  ctx.payments.stop();
});

test('cancel works before payment and is refused once paid', async () => {
  const ctx = open();
  const { purchase } = await ctx.shop.prepare(BIKE);
  assert.equal((await ctx.shop.cancel({ purchaseId: purchase.purchaseId })).purchase.status, 'cancelled');
  await rejects(ctx.shop.pay({ purchaseId: purchase.purchaseId }), 'invalid_state');
  const id = await approved(ctx, { ...BIKE, idempotencyKey: 'paid' });
  await ctx.shop.pay({ purchaseId: id });
  await rejects(ctx.shop.cancel({ purchaseId: id }), 'cannot_cancel');
});

test('required guardrail mode fails closed for shop wrappers and raw payment routes', async () => {
  const ctx = open({ guardrailMode: 'required' });
  await rejects(ctx.shop.prepare(BIKE), 'booking_facts_missing');
  await rejects(ctx.payments.createEscrow('central-park-bikes', '0.15', 600, 'BIKE-2H'), 'policy_required');
  const before = open();
  const escrowId = await before.payments.createEscrow('central-park-bikes', '0.15', 600, 'BIKE-2H');
  before.payments.flush();
  const strict = createPayments({ mode: 'mock', now: () => START, storePath: join(before.dir, 'bookings.json'), guardrailMode: 'required', log: quiet });
  await rejects(strict.release(escrowId), 'policy_required');
});

test('incompatible shop state is refused, not deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'swanavi-shop-'));
  const file = join(dir, 'shop-state.json');
  writeFileSync(file, JSON.stringify({ version: 1, kind: 'shop-purchases', mode: 'ap4m', channelId: '0xother', purchases: {}, idempotency: {} }));
  const payments = createPayments({ mode: 'mock', log: quiet });
  assert.throws(() => createShopPurchases({ payments, statePath: file, mode: 'mock' }), /belongs to mode ap4m/);
  assert.match(readFileSync(file, 'utf8'), /0xother/);
});

test('x402 challenge binding rejects wrong asset, network, channel, payee, ledger, scheme or resource', () => {
  const expected = { resourceUrl: BIKE_URL, chainId: 1449000, asset: '0xToken', ledger: '0xLedger', channelId: '0xchannel', payTo: '0xPayout' };
  const good = () => ({
    x402Version: 2,
    error: 'payment required',
    resource: { url: 'http://localhost:4321/resource' },
    accepts: [{ scheme: 'batch-settlement', network: 'eip155:1449000', amount: '150000000000000000', asset: '0xtoken', payTo: '0xpayout', maxTimeoutSeconds: 60, extra: { bindingVersion: '1', ledger: '0xledger', pricingMode: 'fixed', channelId: '0xCHANNEL', acceptedCumulativeAmount: '0' } }],
  });
  assert.equal(checkPaymentRequired(good(), expected).amount, '150000000000000000');
  const mutations = {
    version: (c) => { c.x402Version = 1; },
    scheme: (c) => { c.accepts[0].scheme = 'exact'; },
    network: (c) => { c.accepts[0].network = 'eip155:1'; },
    asset: (c) => { c.accepts[0].asset = '0xother'; },
    payee: (c) => { c.accepts[0].payTo = '0xattacker'; },
    ledger: (c) => { c.accepts[0].extra.ledger = '0xother'; },
    channel: (c) => { c.accepts[0].extra.channelId = '0xother'; },
    resource: (c) => { c.resource.url = 'http://127.0.0.1:4321/other'; },
    amount: (c) => { c.accepts[0].amount = '0'; },
    twoOffers: (c) => { c.accepts.push(c.accepts[0]); },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const challenge = good();
    mutate(challenge);
    assert.throws(() => checkPaymentRequired(challenge, expected), (error) => error.code === 'challenge_mismatch', name);
  }
});

test('MCP: four strict tools, no approval tool, structured errors and pending as success', async () => {
  assert.deepEqual(TOOLS.map((tool) => tool.name), ['prepare_store_purchase', 'purchase_store_item', 'get_store_purchase', 'cancel_store_purchase']);
  for (const tool of TOOLS) assert.equal(tool.inputSchema.additionalProperties, false);
  assert.ok(!JSON.stringify(TOOLS).includes('approve_'));
  const executor = fakeExecutor({ loseOutcome: true, failResume: true });
  const ctx = open({ executor });
  const rpc = (name, args) => handlePurchaseMcp({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, ctx.shop);
  const init = await handlePurchaseMcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ctx.shop);
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.equal((await handlePurchaseMcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx.shop)).status, 202);
  const prepared = await rpc('prepare_store_purchase', BIKE);
  assert.equal(prepared.body.result.isError, false);
  assert.deepEqual(JSON.parse(prepared.body.result.content[0].text), prepared.body.result.structuredContent);
  const purchaseId = prepared.body.result.structuredContent.purchase.purchaseId;
  const early = await rpc('purchase_store_item', { purchaseId, approved: true });
  assert.equal(early.body.result.isError, true);
  assert.equal(early.body.result.structuredContent.error.code, 'invalid_request');
  const unapproved = await rpc('purchase_store_item', { purchaseId });
  assert.equal(unapproved.body.result.structuredContent.error.code, 'approval_required');
  assert.equal(unapproved.body.result.structuredContent.purchase.status, 'prepared');
  await ctx.shop.approve({ purchaseId });
  const pending = await rpc('purchase_store_item', { purchaseId });
  assert.equal(pending.body.result.isError, false);
  assert.equal(pending.body.result.structuredContent.purchase.status, 'paying');
  assert.equal(signatures(executor), 1);
});

function call(base, method, path, body, headers = {}) {
  const target = new URL(path, base);
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: target.hostname, port: target.port, path: target.pathname, method,
      headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('HTTP: service token for agent routes, separate approval token for the host, spec status codes', async () => {
  const ctx = open();
  const started = await startServer({
    port: 0, payments: ctx.payments, merchants: createMerchants(), token: 'svc', shopPurchases: ctx.shop,
    storeApprovalToken: 'host-only', approvalToken: 'ticket-only', log: quiet,
  });
  try {
    const auth = { 'X-Swanavi-Token': 'svc' };
    assert.equal((await call(started.url, 'POST', '/stores/purchases', BIKE)).status, 401);
    const prepared = await call(started.url, 'POST', '/stores/purchases', BIKE, auth);
    assert.equal(prepared.status, 201);
    const id = prepared.body.purchase.purchaseId;
    assert.equal((await call(started.url, 'POST', '/stores/purchases', { ...BIKE, sku: 'NOPE', idempotencyKey: 'x' }, auth)).status, 400);
    assert.equal((await call(started.url, 'POST', `/stores/purchases/${id}/pay`, null, auth)).status, 403);
    assert.equal((await call(started.url, 'POST', `/stores/purchases/${id}/approve`, null, auth)).status, 401);
    assert.equal((await call(started.url, 'POST', `/stores/purchases/${id}/approve`, null, { ...auth, 'X-Store-Approval-Token': 'ticket-only' })).status, 401);
    assert.equal((await call(started.url, 'POST', `/stores/purchases/${id}/approve`, null, { 'X-Store-Approval-Token': 'host-only' })).status, 401);
    assert.equal((await call(started.url, 'POST', `/stores/purchases/${id}/pay`, { approved: true }, auth)).status, 400);
    const approval = await call(started.url, 'POST', `/stores/purchases/${id}/approve`, null, { ...auth, 'X-Store-Approval-Token': 'host-only' });
    assert.equal(approval.status, 200);
    assert.equal(approval.body.purchase.status, 'approved');
    const paid = await call(started.url, 'POST', `/stores/purchases/${id}/pay`, null, auth);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.purchase.status, 'paid');
    assert.equal((await call(started.url, 'GET', `/stores/purchases/${id}`, null, auth)).body.purchase.status, 'paid');
    assert.equal((await call(started.url, 'GET', '/stores/purchases/shp_missing', null, auth)).status, 404);
    assert.equal((await call(started.url, 'POST', `/stores/purchases/${id}/cancel`, null, auth)).status, 409);
    const list = await call(started.url, 'POST', '/stores/purchases/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth);
    assert.equal(list.body.result.tools.length, 4);
    const discovery = await call(started.url, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth);
    assert.deepEqual(discovery.body.result.tools.map((tool) => tool.name), ['list_stores', 'search_catalog', 'get_quote']);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
});
