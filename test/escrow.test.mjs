import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMerchants, finishEscrow } from '../merchants.mjs';
import { API_VERSION, createPayments, formatRlusd, parseRlusd } from '../payments.mjs';
import { startServer, warnIfOpen } from '../server.mjs';

// Scripts read keys from the environment only: no home-directory path and no .env file name may appear.
const namesKeyFile = (source) => /~\/[\w.-]+|(?<![\w.])(?!process\b)[\w-]+\.env\b/.test(source);

const TOKEN = 'test-token';
const CHANNEL = '0x14dc20af000000000000000000000000000000000000000000000000000000aa';
const quiet = { log() {}, warn() {}, error() {} };

/**
 * A pretend chain. Holds one channel (cap, redeemed) and answers the executor interface
 * without any network. Every call is recorded so tests can prove what was and was not sent.
 */
function fakeExecutor({ cap = '2', redeemed = '0', status = 'open', failRedeem = null, prices = {}, loseOutcome = false, failResume = null, failReadAfterBuy = false } = {}) {
  const wei = (value) => (value === '0' ? 0n : parseRlusd(value));
  const state = {
    cap: wei(cap),
    redeemed: wei(redeemed),
    status,
    prices: Object.fromEntries(Object.entries(prices).map(([url, p]) => [url, wei(p)])),
    disbursed: 0n,
    returned: null,
    calls: [],
    redemptions: [],
    receipts: [],
    failRedeem,
    // x402 "503" simulation: the seller redeems on chain, then the outcome never reaches the agent.
    loseOutcome,
    failResume,
    failReadAfterBuy,
    pending: new Map(), // operation -> retained purchase (purchase.json with complete: false)
    block: 9_230_000,
  };
  const channel = () => ({
    channelId: CHANNEL,
    status: state.status,
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
    channelId: CHANNEL,
    agent: '0xagent',
    links: {
      tx: (hash) => (hash ? `https://explorer.test/tx/${hash}` : null),
      address: (address) => (address ? `https://explorer.test/address/${address}` : null),
    },
    addresses: { ledger: '0xledger', vault: '0xvault', token: '0xtoken' },
    async readChannel() {
      state.calls.push('readChannel');
      if (state.failReadAfterBuy && state.calls.some((c) => c.startsWith('buy:'))) throw new Error('rpc down');
      return channel();
    },
    async readFund() {
      state.calls.push('readFund');
      return {
        block: state.block,
        asOf: new Date(0).toISOString(),
        allocation: { cap: parseRlusd('20'), reserved: state.cap, spent: state.disbursed, available: parseRlusd('20') - state.cap - state.disbursed },
        reservation: { locked: state.cap, settled: state.disbursed },
        thisChannel: { settled: state.disbursed },
        refunded: state.returned ?? 0n,
        links: {},
      };
    },
    async merchantBalance() { return 0n; },
    async redeem({ cumulativeAmount, expectedPrevious }) {
      state.calls.push(`redeem:${formatRlusd(cumulativeAmount)}`);
      if (state.failRedeem) throw new Error(state.failRedeem);
      if (expectedPrevious !== state.redeemed) throw new Error('drift');
      if (cumulativeAmount > state.cap) throw new Error('over cap reached the executor; this must never happen');
      const amount = cumulativeAmount - state.redeemed;
      state.redeemed = cumulativeAmount;
      state.block += 1;
      const txHash = `0xtx${state.redemptions.length + 1}`;
      const claimId = `0xclaim${state.redemptions.length + 1}`;
      const hit = { txHash, blockNumber: state.block, claimId, amount, previous: expectedPrevious, cumulativeAmount };
      state.redemptions.push(hit);
      return hit;
    },
    // x402: the "seller" price table is state.prices[resourceUrl]; a missing entry means no 402.
    async quote(resourceUrl) {
      state.calls.push(`quote:${resourceUrl}`);
      const price = state.prices?.[resourceUrl];
      if (price === undefined) { const e = new Error('HTTP 404'); e.code = 'no_402'; throw e; }
      return { resourceUrl, price, payTo: '0xpayout', channelId: CHANNEL, previousCumulativeAmount: state.redeemed };
    },
    async buy({ resourceUrl, maximumAmount, operation }) {
      state.calls.push(`buy:${resourceUrl}:${formatRlusd(maximumAmount)}:${operation}`);
      const price = state.prices[resourceUrl];
      if (price > maximumAmount) throw new Error('must have been refused before buy');
      const previous = state.redeemed;
      const hit = await this.redeem({ cumulativeAmount: state.redeemed + price, expectedPrevious: state.redeemed });
      if (state.loseOutcome) {
        // The seller submitted (chain moved) but its confirmation never reached us: the SDK keeps purchase.json.
        state.pending.set(operation, { operation, resourceUrl, maximumAmount, previousCumulativeAmount: previous, hit });
        throw new Error('purchase outcome unavailable (HTTP 503); resume the same operation');
      }
      return { ...hit, submitter: '0xseller', resource: { sellerId: resourceUrl } };
    },
    pendingPurchases() {
      state.calls.push('pending');
      return [...state.pending.values()].map(({ operation, resourceUrl, maximumAmount, previousCumulativeAmount }) => ({ operation, resourceUrl, maximumAmount, previousCumulativeAmount }));
    },
    // Non-signing: re-sends the retained header; the seller replays its stored outcome.
    async resume({ operation }) {
      state.calls.push(`resume:${operation}`);
      if (state.failResume) throw new Error(state.failResume);
      const p = state.pending.get(operation);
      if (!p) throw new Error('already_complete');
      state.pending.delete(operation);
      return { ...p.hit, submitter: '0xseller', resource: { sellerId: p.resourceUrl, resumed: true } };
    },
    async recordRedemption(txHash) { state.calls.push(`record:${txHash}`); return { ok: true }; },
    async settle() {
      state.calls.push('settle');
      const unpaid = state.redemptions.filter((r) => !state.receipts.includes(r.claimId));
      for (const r of unpaid) state.receipts.push(r.claimId);
      state.disbursed = state.redeemed;
      return {
        payoutTx: '0xpayout1',
        settlementTx: '0xsettle1',
        claimsSettled: unpaid.length,
        receipts: unpaid.map((r) => ({ claimId: r.claimId, amountRlusd: formatRlusd(r.amount), receiptUrl: `https://receipts.test/${r.claimId}` })),
        latestReceiptUrl: unpaid.at(-1) ? `https://receipts.test/${unpaid.at(-1).claimId}` : null,
      };
    },
    async findRedemption(cumulativeAmount) {
      state.calls.push(`find:${formatRlusd(cumulativeAmount)}`);
      return state.redemptions.find((r) => r.cumulativeAmount === cumulativeAmount) ?? null;
    },
    async verifyTx(txHash) {
      state.calls.push(`verify:${txHash}`);
      if (txHash === '0xfailed') return 'failed';
      return state.redemptions.some((r) => r.txHash === txHash) ? 'confirmed' : 'missing';
    },
    async closeTrip() {
      state.calls.push('closeTrip');
      state.status = 'closed';
      state.disbursed = state.redeemed;
      state.returned = state.cap - state.redeemed;
      return { closeTx: '0xclose1', finalCumulativeAmount: state.redeemed, payoutClosedTx: '0xpayoutclosed1', returned: state.returned, settlement: null };
    },
  };
}

function make(mode, options = {}) {
  const executor = mode === 'ap4m' ? fakeExecutor(options.chain ?? {}) : null;
  const payments = createPayments({ mode, now: () => 1_700_000_000_000, executor, log: quiet, settleDelayMs: 1, ...options });
  return { payments, executor };
}

const budgetFor = (mode) => (mode === 'mock'
  ? { total: '19', remaining: '18.6', reserved: '0.4', spent: '0' }
  : { total: '2', remaining: '1.6', reserved: '0.4', spent: '0' });

for (const mode of ['mock', 'ap4m']) {
  test(`normal pay (${mode})`, async () => {
    const { payments, executor } = make(mode);
    const id = await payments.createEscrow('hotel', '0.40', 3600);
    assert.equal((await payments.getStatus(id)).status, 'locked');
    assert.equal((await payments.getStatus(id)).amount, '0.4');
    assert.deepEqual(await pickBudget(payments), budgetFor(mode));

    const delivered = await payments.release(id);
    assert.equal(delivered.status, 'delivered');
    assert.equal(delivered.finalBill, '0.4');
    assert.equal(delivered.mode, mode);
    if (mode === 'mock') {
      assert.equal(delivered.txHash, null);
      assert.equal(delivered.live, false);
      assert.equal(delivered.badge, 'MOCK');
      assert.equal(delivered.channelId, null);
      assert.deepEqual(await pickBudget(payments), { total: '19', remaining: '18.6', reserved: '0', spent: '0.4' });
    } else {
      assert.equal(delivered.txHash, '0xtx1');
      assert.equal(delivered.explorerUrl, 'https://explorer.test/tx/0xtx1');
      assert.equal(delivered.cumulativeAmount, '0.4');
      assert.equal(delivered.claimId, '0xclaim1');
      assert.equal(delivered.live, true);
      assert.equal(delivered.badge, 'LIVE');
      assert.equal(delivered.channelId, CHANNEL);
      assert.equal(executor.state.redeemed, parseRlusd('0.4'));
      assert.deepEqual(await pickBudget(payments), { total: '2', remaining: '1.6', reserved: '0', spent: '0.4' });
      await waitUntil(async () => (await payments.getStatus(id)).receiptUrl !== null);
      const settled = await payments.getStatus(id);
      assert.equal(settled.receiptUrl, 'https://receipts.test/0xclaim1');
      assert.equal(settled.settlement.payoutTx, '0xpayout1');
      assert.ok(executor.state.calls.includes('record:0xtx1'));
    }
    await assert.rejects(() => payments.refund(id), (error) => error.code === 'invalid_state');
    payments.stop();
  });

  test(`seller cancels and money returns (${mode})`, async () => {
    const { payments, executor } = make(mode);
    const merchants = createMerchants();
    merchants.setSwitch('hotel', { outcome: 'cancel' });
    const id = await payments.createEscrow('hotel', '0.5', 3600);
    assert.equal((await payments.getBudget()).remaining, mode === 'mock' ? '18.5' : '1.5');

    const refunded = await finishEscrow(payments, merchants, id);
    assert.equal(refunded.status, 'refunded');
    assert.equal(refunded.reason, 'refund');
    assert.equal(refunded.txHash, null);
    assert.equal(refunded.live, false);
    assert.equal(refunded.badge, mode === 'mock' ? 'MOCK' : 'LOCAL');
    assert.equal((await payments.getBudget()).refundedTotal, '0.5');
    assert.equal((await payments.getBudget()).remaining, mode === 'mock' ? '19' : '2');
    assert.equal((await payments.getBudget()).reserved, '0');
    assert.equal((await payments.refund(id)).status, 'refunded');
    if (executor) assert.equal(executor.state.calls.some((c) => c.startsWith('redeem')), false);
    assert.throws(
      () => merchants.setSwitch('hotel', { outcome: 'cancel', finalBill: '1' }),
      (error) => error.code === 'bad_request',
    );
  });

  test(`seller fail returns the locked amount (${mode})`, async () => {
    const { payments, executor } = make(mode);
    const merchants = createMerchants();
    merchants.setSwitch('cab', { outcome: 'fail' });
    const id = await payments.createEscrow('cab', '0.3', 3600);
    assert.equal((await finishEscrow(payments, merchants, id)).status, 'refunded');
    assert.equal((await payments.getBudget()).remaining, mode === 'mock' ? '19' : '2');
    assert.equal((await payments.getBudget()).spent, '0');
    if (executor) assert.equal(executor.state.calls.some((c) => c.startsWith('redeem')), false);
  });

  test(`deadline expiry auto-refunds and the budget can be locked again (${mode})`, async () => {
    let now = 1_000_000;
    const executor = mode === 'ap4m' ? fakeExecutor() : null;
    const payments = createPayments({ mode, now: () => now, executor, log: quiet });
    const all = mode === 'mock' ? '19' : '2';
    const id = await payments.createEscrow('cab', all, 10);
    assert.equal((await payments.getStatus(id)).status, 'locked');
    assert.equal((await payments.getBudget()).remaining, '0');

    now += 10_000;
    const expired = await payments.getStatus(id);
    assert.equal(expired.status, 'refunded');
    assert.equal(expired.reason, 'deadline');
    assert.equal((await payments.getBudget()).remaining, all);
    await assert.rejects(() => payments.release(id), (error) => error.code === 'invalid_state' && error.details.status === 'refunded');

    const again = await payments.createEscrow('hotel', '0.40', 10);
    assert.equal((await payments.getStatus(again)).status, 'locked');
    assert.equal((await payments.getBudget()).remaining, mode === 'mock' ? '18.6' : '1.6');
  });

  test(`overcharge refuses release before any signature (${mode})`, async () => {
    let now = 5_000;
    const executor = mode === 'ap4m' ? fakeExecutor() : null;
    const payments = createPayments({ mode, now: () => now, executor, log: quiet });
    const id = await payments.createEscrow('tour', '0.25', 30);
    await assert.rejects(() => payments.release(id, '0.50'), (error) => {
      assert.equal(error.code, 'overcharged');
      assert.equal(error.details.amount, '0.25');
      assert.equal(error.details.finalBill, '0.5');
      return true;
    });
    assert.equal((await payments.getStatus(id)).status, 'overcharged');
    assert.equal((await payments.getStatus(id)).reason, 'final_bill_exceeds_lock');
    assert.equal((await payments.getStatus(id)).txHash, null);
    const all = mode === 'mock' ? '19' : '2';
    assert.deepEqual(await pickBudget(payments), { total: all, remaining: all, reserved: '0', spent: '0' });
    if (executor) {
      assert.equal(executor.state.calls.some((c) => c.startsWith('redeem')), false);
      assert.equal(executor.state.redeemed, 0n);
    }

    now += 60_000;
    assert.equal((await payments.getStatus(id)).status, 'overcharged');
    await assert.rejects(() => payments.refund(id), (error) => error.code === 'invalid_state');
    assert.equal((await payments.getBudget()).remaining, all);
  });

  test(`over-budget lock is rejected and stays quoted (${mode})`, async () => {
    const { payments } = make(mode);
    const all = mode === 'mock' ? '19' : '2';
    let quotedId = '';
    await assert.rejects(() => payments.createEscrow('tour', '20', 60), (error) => {
      assert.equal(error.code, 'over_budget');
      assert.equal(error.details.status, 'quoted');
      quotedId = error.details.escrowId;
      return true;
    });
    assert.equal((await payments.getStatus(quotedId)).status, 'quoted');
    assert.equal((await payments.getStatus(quotedId)).reason, 'over_budget');
    assert.equal((await payments.getBudget()).remaining, all);

    const locked = await payments.createEscrow('hotel', all, 60);
    assert.equal((await payments.getStatus(locked)).status, 'locked');
    assert.equal((await payments.getBudget()).remaining, '0');
    await assert.rejects(() => payments.createEscrow('cab', '0.01', 60), (error) => error.code === 'over_budget');
    assert.equal((await payments.getStatus(locked)).status, 'locked');
    assert.equal((await payments.getBudget()).remaining, '0');
    assert.equal((await payments.getBudget()).reserved, all);
  });

  test(`release refuses a cancelled or failed seller (${mode})`, async () => {
    const merchants = createMerchants();
    merchants.setSwitch('hotel', { outcome: 'cancel' });
    merchants.setSwitch('cab', { outcome: 'fail' });
    const { payments, executor } = make(mode, { sellerStatus: (sellerId) => merchants.get(sellerId).outcome });
    const hotel = await payments.createEscrow('hotel', '0.4', 60);
    await assert.rejects(() => payments.release(hotel), (error) => error.code === 'seller_cancelled');
    assert.equal((await payments.getStatus(hotel)).status, 'locked');
    assert.equal((await payments.getBudget()).reserved, '0.4');
    assert.equal((await payments.getBudget()).refundedTotal, '0');
    const cab = await payments.createEscrow('cab', '0.2', 60);
    await assert.rejects(() => payments.release(cab), (error) => error.code === 'seller_failed');
    assert.equal((await payments.getStatus(cab)).status, 'locked');
    assert.equal((await payments.getBudget()).spent, '0');
    if (executor) assert.equal(executor.state.calls.some((c) => c.startsWith('redeem')), false);
  });
}

test('ap4m mode needs an executor; there is no stub', () => {
  assert.throws(() => createPayments({ mode: 'ap4m' }), (error) => error.code === 'bad_request');
});

test('ap4m: vouchers are cumulative on one trip channel and a smaller bill frees the difference', async () => {
  const { payments, executor } = make('ap4m');
  const a = await payments.createEscrow('hotel', '0.01', 60);
  const b = await payments.createEscrow('tour', '0.02', 60);
  const first = await payments.release(a);
  assert.equal(first.cumulativeAmount, '0.01');
  const second = await payments.release(b, '0.015');
  assert.equal(second.cumulativeAmount, '0.025');
  assert.equal(second.finalBill, '0.015');
  assert.equal(second.txHash, '0xtx2');
  assert.deepEqual(executor.state.calls.filter((c) => c.startsWith('redeem')), ['redeem:0.01', 'redeem:0.025']);
  const budget = await payments.getBudget();
  assert.equal(budget.spent, '0.025');
  assert.equal(budget.refundedTotal, '0.005');
  assert.equal(budget.remaining, '1.975');
  assert.equal(budget.source, 'chain');
  assert.equal(budget.badge, 'LIVE');
  assert.equal(budget.trip.channelId, CHANNEL);
  assert.equal(budget.trip.cap, '2');
  assert.equal(budget.fund.deposit, '20');
  assert.equal(budget.drift, null);
  payments.stop();
});

test('ap4m: nothing is signed above the channel cap or after the channel closed', async () => {
  const { payments, executor } = make('ap4m', { chain: { cap: '2', redeemed: '1.99' } });
  assert.equal((await payments.getBudget()).remaining, '0.01');
  await assert.rejects(() => payments.createEscrow('hotel', '0.02', 60), (error) => error.code === 'over_budget');
  const id = await payments.createEscrow('hotel', '0.01', 60);
  executor.state.redeemed = parseRlusd('1.995'); // somebody else redeemed meanwhile
  await assert.rejects(() => payments.release(id), (error) => error.code === 'over_cap' && error.details.status === 'locked');
  assert.equal(executor.state.calls.some((c) => c.startsWith('redeem')), false);
  assert.equal((await payments.getStatus(id)).status, 'locked');
  const drift = (await payments.getBudget()).drift;
  assert.deepEqual(drift, { chainRedeemed: '1.995', localDelivered: '0' });

  executor.state.status = 'closed';
  await assert.rejects(() => payments.release(id), (error) => error.code === 'channel_closed');
  await assert.rejects(() => payments.createEscrow('cab', '0.001', 60), (error) => error.code === 'channel_closed');
  assert.equal(executor.state.calls.some((c) => c.startsWith('redeem')), false);
});

test('ap4m x402: the 402 is read first, a price above the lock is refused before signing, a lower price pays less', async () => {
  const hotel = 'http://127.0.0.1:4311/resource';
  const tour = 'http://127.0.0.1:4312/resource';
  const cab = 'http://127.0.0.1:4313/resource';
  const urls = { hotel, tour, cab };
  const { payments, executor } = make('ap4m', { chain: { prices: { [hotel]: '0.01', [tour]: '0.05', [cab]: '0.005' } } });
  payments.setSellerResource((sellerId) => urls[sellerId] ?? null);

  // hotel: 402 says 0.01, lock is 0.01 -> pay over x402
  const h = await payments.createEscrow('hotel', '0.01', 60);
  const paid = await payments.release(h);
  assert.equal(paid.status, 'delivered');
  assert.equal(paid.paidVia, 'x402');
  assert.equal(paid.live, true);
  assert.equal(paid.cumulativeAmount, '0.01');
  assert.deepEqual(paid.resource, { sellerId: hotel });
  assert.equal(executor.state.calls.filter((c) => c.startsWith('buy:')).length, 1);
  assert.match(executor.state.calls.find((c) => c.startsWith('buy:')), new RegExp(`^buy:${hotel}:0.01:escrow-`));

  // tour: 402 says 0.05, lock is 0.01 -> overcharged, nothing signed, lock returned
  const t = await payments.createEscrow('tour', '0.01', 60);
  await assert.rejects(() => payments.release(t), (error) => {
    assert.equal(error.code, 'overcharged');
    assert.equal(error.details.finalBill, '0.05');
    assert.equal(error.details.amount, '0.01');
    return true;
  });
  const refused = await payments.getStatus(t);
  assert.equal(refused.status, 'overcharged');
  assert.equal(refused.reason, 'x402_price_exceeds_lock');
  assert.equal(refused.txHash, null);
  assert.equal(executor.state.calls.filter((c) => c.startsWith('buy:')).length, 1, 'buy must not be called for tour');
  assert.equal(executor.state.redeemed, parseRlusd('0.01'));
  assert.equal((await payments.getBudget()).reserved, '0');

  // cab: 402 says 0.005, lock is 0.01 -> pays 0.005, frees 0.005
  const c = await payments.createEscrow('cab', '0.01', 60);
  const cheaper = await payments.release(c);
  assert.equal(cheaper.finalBill, '0.005');
  assert.equal(cheaper.cumulativeAmount, '0.015');
  const budget = await payments.getBudget();
  assert.equal(budget.spent, '0.015');
  assert.equal(budget.refundedTotal, '0.005'); // cab's freed 0.005; an overcharge returns to remaining but is not counted here (documented)
  assert.equal(budget.remaining, '1.985');

  // food: no resource URL -> direct voucher path still works
  const f = await payments.createEscrow('food', '0.01', 60);
  const direct = await payments.release(f);
  assert.equal(direct.paidVia, 'voucher');
  assert.equal(direct.cumulativeAmount, '0.025');

  // seller down: no 402 -> seller_unavailable, lock unchanged, nothing signed
  payments.setSellerResource(() => 'http://127.0.0.1:4999/resource');
  const d = await payments.createEscrow('hotel', '0.01', 60);
  await assert.rejects(() => payments.release(d), (error) => error.code === 'seller_unavailable' && error.details.status === 'locked');
  assert.equal((await payments.getStatus(d)).status, 'locked');
  assert.equal(executor.state.calls.filter((c) => c.startsWith('buy:')).length, 2);
  payments.stop();
});

// The live failure seen twice (x402 run 1, rehearsal food): the seller redeemed on chain, the agent got a 503.
const food = 'http://127.0.0.1:4314/resource';
const x402Fixture = (chain) => {
  const { payments, executor } = make('ap4m', { chain: { prices: { [food]: '0.01' }, ...chain }, resumeWaitMs: 0 });
  payments.setSellerResource((sellerId) => (sellerId === 'food' ? food : null));
  return { payments, executor };
};
// In the fake every signature becomes a buy: call (x402) and a redemption; resume/find never add either.
const signatures = (executor) => Math.max(executor.state.calls.filter((c) => c.startsWith('buy:')).length, executor.state.redemptions.length);

test('ap4m x402 auto-resume: lost outcome, chain shows the payment -> resume, delivered, nothing signed twice', async () => {
  const { payments, executor } = x402Fixture({ loseOutcome: true });
  const id = await payments.createEscrow('food', '0.01', 60);
  const paid = await payments.release(id);
  assert.equal(paid.status, 'delivered');
  assert.equal(paid.paidVia, 'x402');
  assert.equal(paid.txHash, '0xtx1');
  assert.equal(paid.cumulativeAmount, '0.01');
  assert.deepEqual(paid.resource, { sellerId: food, resumed: true });
  assert.equal(executor.state.redemptions.length, 1, 'exactly one redemption on chain');
  assert.equal(executor.state.calls.filter((c) => c.startsWith('buy:')).length, 1, 'buy called once');
  assert.equal(executor.state.calls.filter((c) => c.startsWith('resume:')).length, 1, 'resume called once');
  assert.ok(executor.state.calls.indexOf('readChannel', executor.state.calls.indexOf('buy:' + food + ':0.01:' + id.replaceAll('_', '-'))) > 0, 'the chain was re-read after the failed buy');
  assert.equal(executor.state.pending.size, 0, 'the retained purchase is complete');
  const budget = await payments.getBudget();
  assert.equal(budget.spent, '0.01');
  assert.equal(budget.reserved, '0');
  payments.stop();
});

test('ap4m x402 auto-resume: lost outcome and resume also fails -> stays paying (503 redeem_unconfirmed); a later release confirms without signing', async () => {
  const { payments, executor } = x402Fixture({ loseOutcome: true, failResume: 'seller 503 again' });
  const id = await payments.createEscrow('food', '0.01', 60);
  await assert.rejects(() => payments.release(id), (error) => {
    assert.equal(error.code, 'redeem_unconfirmed');
    assert.equal(error.details.status, 'paying');
    assert.equal(error.details.cumulativeAmount, '0.01');
    return true;
  });
  const stuck = await payments.getStatus(id);
  assert.equal(stuck.status, 'paying');
  assert.equal(stuck.reason, 'redeem_unconfirmed');
  assert.equal((await payments.getBudget()).reserved, '0.01', 'still reserved: it is not counted as spent until confirmed');
  await assert.rejects(() => payments.refund(id), (error) => error.code === 'invalid_state');
  // A second release must not pay again: it only retries the confirmation.
  await assert.rejects(() => payments.release(id), (error) => error.code === 'redeem_unconfirmed');
  assert.equal(signatures(executor), 1, 'still exactly one signature');
  executor.state.failResume = null;
  const paid = await payments.release(id);
  assert.equal(paid.status, 'delivered');
  assert.equal(paid.txHash, '0xtx1');
  assert.equal(signatures(executor), 1);
  assert.equal(executor.state.redemptions.length, 1);
  assert.equal(executor.state.calls.filter((c) => c.startsWith('resume:')).length, 3);
  assert.equal((await payments.getBudget()).spent, '0.01');
  payments.stop();
});

test('ap4m x402 auto-resume: buy fails and the chain did NOT move -> locked / redeem_failed as before, no resume', async () => {
  const { payments, executor } = x402Fixture({});
  executor.buy = async (args) => { executor.state.calls.push(`buy:${args.resourceUrl}:${formatRlusd(args.maximumAmount)}:${args.operation}`); throw new Error('seller connection reset'); };
  const id = await payments.createEscrow('food', '0.01', 60);
  await assert.rejects(() => payments.release(id), (error) => error.code === 'redeem_failed' && error.details.status === 'locked');
  const after = await payments.getStatus(id);
  assert.equal(after.status, 'locked');
  assert.equal(after.reason, 'redeem_failed');
  assert.equal(executor.state.calls.filter((c) => c.startsWith('resume:')).length, 0);
  assert.equal(executor.state.redemptions.length, 0);
  payments.stop();
});

test('ap4m x402 auto-resume: chain unreadable after the failed buy -> stays paying, never back to locked', async () => {
  const { payments, executor } = x402Fixture({ loseOutcome: true, failReadAfterBuy: true });
  const id = await payments.createEscrow('food', '0.01', 60);
  await assert.rejects(() => payments.release(id), (error) => error.code === 'redeem_unconfirmed' && error.details.status === 'paying');
  assert.equal((await payments.getStatus(id)).status, 'paying');
  assert.equal(executor.state.calls.filter((c) => c.startsWith('resume:')).length, 0, 'no resume without a chain reading');
  executor.state.failReadAfterBuy = false;
  const paid = await payments.release(id);
  assert.equal(paid.status, 'delivered');
  assert.equal(signatures(executor), 1);
  payments.stop();
});

test('ap4m deadline after a lost-outcome payment: never refunded; paying row stays, legacy locked row is repaired, unpaid row is refunded', async () => {
  let clock = 1_700_000_000_000;
  // (a) new code path: lost outcome + resume failing -> 'paying'. The deadline must not touch it.
  const executor = fakeExecutor({ prices: { [food]: '0.01' }, loseOutcome: true, failResume: 'seller 503' });
  const payments = createPayments({ mode: 'ap4m', now: () => clock, executor, log: quiet, settleDelayMs: 1, resumeWaitMs: 0 });
  payments.setSellerResource((sellerId) => (sellerId === 'food' ? food : null));
  const a = await payments.createEscrow('food', '0.01', 60);
  await assert.rejects(() => payments.release(a), (error) => error.code === 'redeem_unconfirmed');
  clock += 120_000; // deadline passed
  const stillPaying = await payments.getStatus(a);
  assert.equal(stillPaying.status, 'paying', 'a paying row is never expired');
  assert.equal((await payments.getBudget()).refundedTotal, '0');
  executor.state.failResume = null;
  const paidA = await payments.release(a);
  assert.equal(paidA.status, 'delivered');
  assert.equal(paidA.txHash, '0xtx1');

  // (b) legacy row: locked / redeem_failed with the retained purchase on chain (what the old code left). Deadline -> repaired, not refunded.
  const b = await payments.createEscrow('food', '0.01', 60);
  const bOp = b.replaceAll('_', '-');
  const hitB = await executor.redeem({ cumulativeAmount: parseRlusd('0.02'), expectedPrevious: parseRlusd('0.01') }); // the seller's redemption
  executor.state.pending.set(bOp, { operation: bOp, resourceUrl: food, maximumAmount: parseRlusd('0.01'), previousCumulativeAmount: parseRlusd('0.01'), hit: hitB });
  const rowB = (await payments.exportState()).bookings.find((r) => r.escrowId === b);
  assert.equal(rowB.status, 'locked');
  clock += 120_000;
  const repaired = await payments.getStatus(b);
  assert.equal(repaired.status, 'delivered');
  assert.equal(repaired.txHash, '0xtx2');
  assert.equal(repaired.paidVia, 'x402');
  assert.equal(repaired.repaired.from, 'locked');
  assert.equal(repaired.repaired.trigger, 'deadline');
  assert.equal(repaired.repaired.via, 'resume');
  assert.equal((await payments.getBudget()).refundedTotal, '0');

  // (c) retained purchase but nothing on chain: the deadline refund is right.
  const c = await payments.createEscrow('food', '0.01', 60);
  const cOp = c.replaceAll('_', '-');
  executor.state.pending.set(cOp, { operation: cOp, resourceUrl: food, maximumAmount: parseRlusd('0.01'), previousCumulativeAmount: parseRlusd('0.02'), hit: null });
  clock += 120_000;
  const expired = await payments.getStatus(c);
  assert.equal(expired.status, 'refunded');
  assert.equal(expired.reason, 'deadline');
  assert.equal(executor.state.redemptions.length, 2, 'nothing signed by any repair');
  assert.equal(executor.state.calls.filter((x) => x.startsWith('buy:')).length, 1);
  const budget = await payments.getBudget();
  assert.equal(budget.spent, '0.02');
  assert.equal(budget.reserved, '0');
  payments.stop();
});

test('ap4m restart repairs a refunded/deadline row that the chain shows was paid (the rehearsal food case)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swanavi-'));
  const storePath = join(dir, 'bookings.json');
  try {
    const executor = fakeExecutor({ prices: { [food]: '0.01' } });
    const first = createPayments({ mode: 'ap4m', now: () => 1_700_000_000_000, executor, storePath, log: quiet, settleDelayMs: 60_000 });
    const id = await first.createEscrow('food', '0.01', 60);
    first.stop();
    // What the old code left on disk: the deadline refunded a booking whose redemption is on chain.
    const op = id.replaceAll('_', '-');
    const hit = await executor.redeem({ cumulativeAmount: parseRlusd('0.01'), expectedPrevious: 0n });
    executor.state.pending.set(op, { operation: op, resourceUrl: food, maximumAmount: parseRlusd('0.01'), previousCumulativeAmount: 0n, hit });
    const saved = JSON.parse(readFileSync(storePath, 'utf8'));
    const row = saved.bookings.find((r) => r.escrowId === id);
    row.status = 'refunded';
    row.reason = 'deadline';
    row.returned = '0.01';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(storePath, JSON.stringify(saved));

    const second = createPayments({ mode: 'ap4m', now: () => 1_700_000_000_000, executor, storePath, log: quiet, settleDelayMs: 60_000 });
    second.setSellerResource((sellerId) => (sellerId === 'food' ? food : null));
    assert.equal((await second.getStatus(id)).status, 'refunded', 'loaded as the file says');
    const report = await second.reconcile();
    assert.deepEqual(report.changes.filter((c) => c.escrowId === id).map((c) => [c.from, c.to, c.txHash, c.via, c.trigger]), [['refunded', 'delivered', '0xtx1', 'resume', 'restart']]);
    const now = await second.getStatus(id);
    assert.equal(now.status, 'delivered');
    assert.equal(now.reason, null);
    assert.equal(now.txHash, '0xtx1');
    assert.equal(now.paidVia, 'x402');
    assert.deepEqual({ from: now.repaired.from, reason: now.repaired.reason, via: now.repaired.via }, { from: 'refunded', reason: 'deadline', via: 'resume' });
    const budget = await second.getBudget();
    assert.equal(budget.spent, '0.01');
    assert.equal(budget.refundedTotal, '0', 'the wrong refund is undone');
    assert.equal(budget.reserved, '0');
    assert.equal(executor.state.redemptions.length, 1, 'nothing signed');
    assert.equal((await second.reconcile()).changes.filter((c) => c.escrowId === id).length, 0, 'idempotent');
    // The repair survives a reload.
    const third = createPayments({ mode: 'ap4m', now: () => 1_700_000_000_000, executor, storePath, log: quiet, settleDelayMs: 60_000 });
    assert.equal((await third.getStatus(id)).repaired.from, 'refunded');
    second.stop(); third.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ap4m direct voucher auto-resume: redeem throws after the block was mined -> VoucherRedeemed lookup, delivered', async () => {
  const { payments, executor } = make('ap4m', { resumeWaitMs: 0 });
  const realRedeem = executor.redeem.bind(executor);
  executor.redeem = async (args) => { await realRedeem(args); throw new Error('tx.wait timed out'); };
  const id = await payments.createEscrow('hotel', '0.01', 60);
  const paid = await payments.release(id);
  assert.equal(paid.status, 'delivered');
  assert.equal(paid.paidVia, 'voucher');
  assert.equal(paid.txHash, '0xtx1');
  assert.equal(executor.state.redemptions.length, 1);
  assert.ok(executor.state.calls.includes('find:0.01'));
  payments.stop();
});

test('ap4m restart: a locked/redeem_failed row with a retained x402 purchase that is on chain becomes delivered (the rehearsal food case)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swanavi-'));
  const storePath = join(dir, 'bookings.json');
  try {
    const executor = fakeExecutor({ prices: { [food]: '0.01' }, loseOutcome: true, failResume: 'seller 503', failReadAfterBuy: true });
    const first = createPayments({ mode: 'ap4m', now: () => 1_700_000_000_000, executor, storePath, log: quiet, settleDelayMs: 60_000, resumeWaitMs: 0 });
    first.setSellerResource((sellerId) => (sellerId === 'food' ? food : null));
    const id = await first.createEscrow('food', '0.01', 60);
    await assert.rejects(() => first.release(id));
    first.stop();
    // What the OLD code left on disk after the 503: locked, redeem_failed, no cumulative, no tx; purchase.json retained.
    const saved = JSON.parse(readFileSync(storePath, 'utf8'));
    const row = saved.bookings.find((r) => r.escrowId === id);
    row.status = 'locked';
    row.reason = 'redeem_failed';
    row.cumulativeAmount = null;
    row.txHash = null;
    row.x402 = false;
    const { writeFileSync } = await import('node:fs');
    writeFileSync(storePath, JSON.stringify(saved));
    assert.equal(executor.state.pending.size, 1);
    assert.equal(executor.state.redeemed, parseRlusd('0.01'));

    executor.state.failResume = null;
    executor.state.failReadAfterBuy = false;
    const second = createPayments({ mode: 'ap4m', now: () => 1_700_000_000_000, executor, storePath, log: quiet, settleDelayMs: 60_000, resumeWaitMs: 0 });
    second.setSellerResource((sellerId) => (sellerId === 'food' ? food : null));
    const report = await second.reconcile();
    assert.deepEqual(report.changes.filter((c) => c.escrowId === id).map((c) => [c.from, c.to, c.txHash, c.via]), [['locked', 'delivered', '0xtx1', 'resume']]);
    const now = await second.getStatus(id);
    assert.equal(now.status, 'delivered');
    assert.equal(now.paidVia, 'x402');
    assert.equal(now.txHash, '0xtx1');
    assert.equal(now.cumulativeAmount, '0.01');
    assert.equal(signatures(executor), 1, 'the restart signed nothing');
    assert.equal(executor.state.redemptions.length, 1);
    const budget = await second.getBudget();
    assert.equal(budget.spent, '0.01');
    assert.equal(budget.reserved, '0');
    assert.equal(budget.drift, null);
    // Idempotent: a second reconcile changes nothing.
    assert.equal((await second.reconcile()).changes.filter((c) => c.escrowId === id).length, 0);
    second.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ap4m: a failed transaction leaves the lock in place', async () => {
  const { payments, executor } = make('ap4m', { chain: { failRedeem: 'rpc down' } });
  const id = await payments.createEscrow('hotel', '0.01', 60);
  await assert.rejects(() => payments.release(id), (error) => error.code === 'redeem_failed' && error.details.status === 'locked');
  const after = await payments.getStatus(id);
  assert.equal(after.status, 'locked');
  assert.equal(after.reason, 'redeem_failed');
  assert.equal(after.txHash, null);
  assert.equal((await payments.getBudget()).reserved, '0.01');
  executor.state.failRedeem = null;
  assert.equal((await payments.release(id)).status, 'delivered');
  payments.stop();
});

test('ap4m: fund is refused and closeTrip returns the unused cap with explorer links', async () => {
  const { payments, executor } = make('ap4m');
  await assert.rejects(() => payments.fund('1'), (error) => error.code === 'live_mode');
  const paid = await payments.createEscrow('hotel', '0.01', 60);
  const held = await payments.createEscrow('cab', '0.5', 60);
  await payments.release(paid);
  const closed = await payments.closeTrip();
  assert.equal(closed.live, true);
  assert.equal(closed.closeTx, '0xclose1');
  assert.equal(closed.payoutClosedTxUrl, 'https://explorer.test/tx/0xpayoutclosed1');
  assert.equal(closed.returned, '1.99');
  assert.equal(closed.freedLocks, '0.5');
  const cab = await payments.getStatus(held);
  assert.equal(cab.status, 'refunded');
  assert.equal(cab.reason, 'trip_closed');
  const budget = await payments.getBudget();
  assert.equal(budget.trip.status, 'closed');
  assert.equal(budget.trip.returned, '1.99');
  assert.equal(budget.refundedTotal, '2.49');
  assert.equal(budget.remaining, '0');
  await assert.rejects(() => payments.closeTrip(), (error) => error.code === 'channel_closed');
  assert.ok(executor.state.calls.includes('closeTrip'));
  payments.stop();
});

test('ap4m: restart reconciles paying, delivered and failed bookings against the chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swanavi-'));
  const storePath = join(dir, 'bookings.json');
  try {
    const executor = fakeExecutor();
    const first = createPayments({ mode: 'ap4m', now: () => 1_700_000_000_000, executor, storePath, log: quiet, settleDelayMs: 60_000 });
    const done = await first.createEscrow('hotel', '0.01', 60);
    const stuck = await first.createEscrow('tour', '0.02', 60);
    const lost = await first.createEscrow('cab', '0.03', 60);
    await first.release(done);
    first.stop();

    // Pretend the process died: 'stuck' was mid-flight (the chain has it), 'lost' points at a failed tx.
    const saved = JSON.parse(readFileSync(storePath, 'utf8'));
    const rows = Object.fromEntries(saved.bookings.map((row) => [row.escrowId, row]));
    rows[stuck].status = 'paying';
    rows[stuck].cumulativeAmount = '0.03';
    await executor.redeem({ cumulativeAmount: parseRlusd('0.03'), expectedPrevious: parseRlusd('0.01') });
    rows[lost].status = 'delivered';
    rows[lost].txHash = '0xfailed';
    rows[lost].claimId = '0xclaimx';
    rows[lost].chainStatus = 'confirmed';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(storePath, JSON.stringify(saved));

    const second = createPayments({ mode: 'ap4m', now: () => 1_700_000_000_000, executor, storePath, log: quiet, settleDelayMs: 60_000 });
    const report = await second.reconcile();
    assert.equal(report.checked, 3);
    const stuckNow = await second.getStatus(stuck);
    assert.equal(stuckNow.status, 'delivered');
    assert.equal(stuckNow.txHash, '0xtx2');
    assert.equal(stuckNow.live, true);
    const lostNow = await second.getStatus(lost);
    assert.equal(lostNow.status, 'locked');
    assert.equal(lostNow.reason, 'redeem_failed');
    assert.equal(lostNow.txHash, null);
    const budget = await second.getBudget();
    assert.equal(budget.spent, '0.03');
    assert.equal(budget.reserved, '0.03');
    assert.equal(budget.drift, null);
    second.stop();

    // Wrong channel file is refused.
    const other = fakeExecutor();
    other.channelId = '0xother';
    assert.throws(() => createPayments({ mode: 'ap4m', executor: other, storePath, log: quiet }), (error) => /belongs to trip channel/.test(error.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('payment files do not reference keys or the live agent', () => {
  for (const name of ['../payments.mjs', '../merchants.mjs', '../server.mjs', '../dashboard.html']) {
    const source = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.equal(namesKeyFile(source), false);
    assert.equal(source.includes('AGENT_PRIVATE_KEY'), false);
    assert.equal(source.includes('MERCHANT_SUBMITTER_KEY'), false);
    assert.equal(source.includes('sendTransaction'), false);
    assert.equal(source.includes("from './ap4m-agent.js'"), false);
    assert.equal(source.includes("from './ap4m-hackathon-sdk.js'"), false);
    assert.equal(source.includes("from './ap4m-x402.mjs'"), false);
  }
  const executor = readFileSync(new URL('../ap4m_executor.mjs', import.meta.url), 'utf8');
  assert.equal(namesKeyFile(executor), false);
  assert.equal(/console\.log\([^)]*key/i.test(executor), false);
});

test('x402 sellers and the x402 rehearsal script are built on the official helper and name no key file', () => {
  const sellers = readFileSync(new URL('../x402_sellers.mjs', import.meta.url), 'utf8');
  assert.match(sellers, /createX402Merchant\(/);
  assert.match(sellers, /from '\.\/ap4m-x402\.mjs'/);
  assert.match(sellers, /NonceManager/);
  for (const port of ['4311', '4312', '4313', '4314']) assert.match(readFileSync(new URL('../merchants.mjs', import.meta.url), 'utf8'), new RegExp(port));
  const rehearsal = readFileSync(new URL('../scripts/live_x402_test.mjs', import.meta.url), 'utf8');
  assert.match(rehearsal, /0x14dc20af40d782b2a80ccb4bfa5cdecd6faf6c441c26d63d1fbe0af7980762c0/);
  assert.match(rehearsal, /EXPERIMENT_CAP above 0\.05 is not allowed/);
  assert.equal(/requestChannel\(|closeChannel\(/.test(rehearsal), false);
  for (const source of [sellers, rehearsal]) {
    assert.equal(namesKeyFile(source), false);
    assert.equal(/console\.log\([^)]*(KEY|key\b)/.test(source), false);
  }
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /merchant-state/);
  assert.match(ignore, /agent-state/);
});

test('merchants carry an x402 resource URL only when a base URL is given', () => {
  const plain = createMerchants();
  assert.equal(plain.get('hotel').resourceUrl, null);
  const withX402 = createMerchants({ x402BaseUrl: 'http://127.0.0.1' });
  assert.equal(withX402.get('hotel').resourceUrl, 'http://127.0.0.1:4311/resource');
  assert.equal(withX402.get('food').resourceUrl, 'http://127.0.0.1:4314/resource');
});

test('http routes cover pay, cancel, deadline, overcharge, and over-budget', async () => {
  let now = Date.parse('2026-10-24T23:00:00.000Z');
  const payments = createPayments({ mode: 'mock', now: () => now });
  const merchants = createMerchants();
  const started = await startServer({ port: 0, payments, merchants, token: TOKEN, log: quiet });
  try {
    const health = await call(started.url, 'GET', '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.badge, 'MOCK');
    assert.equal(health.body.live, false);
    assert.equal(health.body.version, 3);
    assert.equal(API_VERSION, 3);
    assert.equal(health.body.network, 'disabled');

    const shops = await call(started.url, 'GET', '/merchants');
    assert.deepEqual(shops.body.merchants.map((merchant) => merchant.sellerId), ['hotel', 'tour', 'cab', 'food']);
    assert.equal(shops.body.merchants[0].name, 'The Plaza Hotel');
    assert.equal(shops.body.merchants[0].price, '4');
    assert.equal(shops.body.merchants[3].sellerId, 'food');
    assert.equal(shops.body.merchants[3].price, '2.5');
    assert.equal(shops.body.merchants[3].name, "Katz's Delicatessen");
    assert.equal(shops.body.merchants[0].outcome, 'deliver');

    const opened = await call(started.url, 'POST', '/escrows', { sellerId: 'hotel', amount: '0.40', deadlineSeconds: 3600 });
    assert.equal(opened.status, 201);
    assert.equal(opened.body.status, 'locked');
    assert.equal(opened.body.badge, 'MOCK');
    assert.equal(opened.body.live, false);
    const paid = await call(started.url, 'POST', `/escrows/${opened.body.escrowId}/release`, {});
    assert.equal(paid.status, 200);
    assert.equal(paid.body.status, 'delivered');

    const switched = await call(started.url, 'POST', '/merchants/cab/switch', { outcome: 'cancel' });
    assert.equal(switched.body.outcome, 'cancel');
    const cab = await call(started.url, 'POST', '/escrows', { sellerId: 'cab', amount: '0.15', deadlineSeconds: 3600 });
    const cabDone = await call(started.url, 'POST', `/escrows/${cab.body.escrowId}/finish`, {});
    assert.equal(cabDone.status, 200);
    assert.equal(cabDone.body.status, 'refunded');
    assert.equal(cabDone.body.reason, 'refund');

    const tooMuch = await call(started.url, 'POST', '/escrows', { sellerId: 'tour', amount: '20', deadlineSeconds: 60 });
    assert.equal(tooMuch.status, 409);
    assert.equal(tooMuch.body.error, 'over_budget');
    const quoted = await call(started.url, 'GET', `/escrows/${tooMuch.body.escrowId}`);
    assert.equal(quoted.body.status, 'quoted');

    await call(started.url, 'POST', '/merchants/tour/switch', { outcome: 'deliver', finalBill: '0.50' });
    const tour = await call(started.url, 'POST', '/escrows', { sellerId: 'tour', amount: '0.25', deadlineSeconds: 60 });
    const billed = await call(started.url, 'POST', `/escrows/${tour.body.escrowId}/finish`, {});
    assert.equal(billed.status, 409);
    assert.equal(billed.body.error, 'overcharged');
    const over = await call(started.url, 'GET', `/escrows/${tour.body.escrowId}`);
    assert.equal(over.body.status, 'overcharged');

    const expiring = await call(started.url, 'POST', '/escrows', { sellerId: 'hotel', amount: '0.40', deadlineSeconds: 5 });
    assert.equal(expiring.body.status, 'locked');
    now += 5_000;
    const afterDeadline = await call(started.url, 'GET', `/escrows/${expiring.body.escrowId}`);
    assert.equal(afterDeadline.body.status, 'refunded');
    assert.equal(afterDeadline.body.reason, 'deadline');

    await call(started.url, 'POST', '/merchants/hotel/switch', { outcome: 'cancel' });
    const held = await call(started.url, 'POST', '/escrows', { sellerId: 'hotel', amount: '0.40', deadlineSeconds: 3600 });
    const refused = await call(started.url, 'POST', `/escrows/${held.body.escrowId}/release`, {});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, 'seller_cancelled');
    const stillLocked = await call(started.url, 'GET', `/escrows/${held.body.escrowId}`);
    assert.equal(stillLocked.body.status, 'locked');
    await call(started.url, 'POST', `/escrows/${held.body.escrowId}/refund`, {});

    const budget = await call(started.url, 'GET', '/budget');
    assert.deepEqual(pick(budget.body), { total: '19', remaining: '18.6', reserved: '0', spent: '0.4' });
    assert.equal(budget.body.version, 3);
    assert.equal(budget.body.source, 'memory');
    assert.equal(budget.body.trip, null);

    const trip = await call(started.url, 'GET', '/trip');
    assert.equal(trip.status, 200);
    assert.equal(trip.body.live, false);
    assert.equal(trip.body.trip, null);
    const closed = await call(started.url, 'POST', '/trip/close', {});
    assert.equal(closed.status, 200);
    assert.equal(closed.body.live, false);
    assert.equal(closed.body.closeTx, null);

    const missing = await call(started.url, 'GET', '/escrows/escrow_missing');
    assert.equal(missing.status, 404);
    const fractional = await call(started.url, 'POST', '/escrows', { sellerId: 'hotel', amount: 0.4, deadlineSeconds: 10 });
    assert.equal(fractional.status, 400);
    assert.equal(fractional.body.error, 'bad_amount');
  } finally {
    await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
  }
});

test('http in live mode: LIVE only with a tx, fund refused, trip routes, reconcile on start', async () => {
  const executor = fakeExecutor();
  const dir = mkdtempSync(join(tmpdir(), 'swanavi-'));
  try {
    const started = await startServer({ port: 0, mode: 'ap4m', executor, token: TOKEN, storePath: join(dir, 'bookings.json'), maxBooking: '1', spendCeiling: '1.5', log: quiet });
    try {
      assert.equal(started.reconciled.checked, 0);
      const health = await call(started.url, 'GET', '/health');
      assert.equal(health.body.badge, 'LIVE');
      assert.equal(health.body.network, 'xrpl-evm-testnet');
      const funded = await call(started.url, 'POST', '/fund', { method: 'card', amount: '1' });
      assert.equal(funded.status, 409);
      assert.equal(funded.body.error, 'live_mode');
      const opened = await call(started.url, 'POST', '/escrows', { sellerId: 'hotel', amount: '0.01', deadlineSeconds: 60 });
      assert.equal(opened.status, 201);
      assert.equal(opened.body.badge, 'LOCAL');
      assert.equal(opened.body.live, false);
      assert.equal(opened.body.channelId, CHANNEL);
      const paid = await call(started.url, 'POST', `/escrows/${opened.body.escrowId}/release`, {});
      assert.equal(paid.body.badge, 'LIVE');
      assert.equal(paid.body.live, true);
      assert.equal(paid.body.explorerUrl, 'https://explorer.test/tx/0xtx1');
      const trip = await call(started.url, 'GET', '/trip');
      assert.equal(trip.body.trip.redeemed, '0.01');
      assert.equal(trip.body.trip.openedTxUrl, 'https://explorer.test/tx/0xopened');
      const budget = await call(started.url, 'GET', '/budget');
      assert.equal(budget.body.source, 'chain');
      assert.equal(budget.body.spent, '0.01');
      const limited = await call(started.url, 'POST', '/escrows', { sellerId: 'tour', amount: '1.01', deadlineSeconds: 60 });
      assert.equal(limited.body.error, 'amount_limit');
      const closed = await call(started.url, 'POST', '/trip/close', {});
      assert.equal(closed.body.live, true);
      assert.equal(closed.body.returned, '1.99');
      const again = await call(started.url, 'POST', '/escrows', { sellerId: 'tour', amount: '0.01', deadlineSeconds: 60 });
      assert.equal(again.body.error, 'channel_closed');
    } finally {
      await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('bookings.json reloads sellers and refunds in mock mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'swanavi-'));
  const storePath = join(dir, 'bookings.json');
  try {
    const merchants = createMerchants();
    merchants.setSwitch('cab', { outcome: 'cancel' });
    const first = createPayments({ mode: 'mock', now: () => 1_700_000_000_000, storePath, maxBooking: '4', spendCeiling: '6' });
    first.setStoreExtra(() => ({ sellers: merchants.exportState() }));
    const id = await first.createEscrow('hotel', '2', 60);
    assert.equal((await first.getStatus(id)).txHash, null);
    await first.refund(id);
    first.flush();
    const second = createPayments({ mode: 'mock', now: () => 1_700_000_000_000, storePath, maxBooking: '4', spendCeiling: '6' });
    const status = await second.getStatus(id);
    assert.equal(status.status, 'refunded');
    assert.equal(status.mode, 'mock');
    assert.equal(status.txHash, null);
    assert.equal(status.receiptUrl, null);
    assert.equal(status.channelId, null);
    assert.equal((await second.getBudget()).refundedTotal, '2');
    assert.equal((await second.getBudget()).badge, 'MOCK');
    assert.equal((await second.getBudget()).live, false);
    assert.equal(second.loadedSellers.find((seller) => seller.sellerId === 'cab').outcome, 'cancel');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ceiling, max, kill switch, and fund stay on the local ledger', async () => {
  const payments = createPayments({ mode: 'mock', now: () => 1_700_000_000_000, maxBooking: '4', spendCeiling: '6' });
  await assert.rejects(() => payments.createEscrow('hotel', '4.1', 60), (error) => error.code === 'amount_limit');
  const hotel = await payments.createEscrow('hotel', '4', 60);
  await payments.createEscrow('cab', '2', 60);
  await assert.rejects(() => payments.createEscrow('food', '2', 60), (error) => error.code === 'spend_ceiling');
  await payments.fund('10');
  assert.equal((await payments.getBudget()).total, '29');
  assert.equal((await payments.getBudget()).spendCeiling, '6');
  await assert.rejects(() => payments.createEscrow('food', '2', 60), (error) => error.code === 'spend_ceiling');
  await payments.refund(hotel);
  assert.equal((await payments.getBudget()).refundedTotal, '4');
  await payments.createEscrow('food', '2', 60);
  await payments.setKilled(true);
  await assert.rejects(() => payments.createEscrow('tour', '2', 60), (error) => error.code === 'killed');
  const open = (await payments.listEscrows()).find((escrow) => escrow.status === 'locked');
  assert.equal((await payments.refund(open.escrowId)).status, 'refunded');
});

test('server requires a token, warns on an open host, and serves the dashboard', async () => {
  const previous = process.env.SWANAVI_TOKEN;
  delete process.env.SWANAVI_TOKEN;
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (line) => warnings.push(String(line));
  const dir = mkdtempSync(join(tmpdir(), 'swanavi-'));
  try {
    await assert.rejects(async () => startServer({ port: 0 }), (error) => error.code === 'bad_request');
    assert.equal(warnIfOpen('127.0.0.1'), false);
    assert.equal(warnIfOpen('0.0.0.0'), true);
    assert.match(warnings.join('\n'), /WARNING/);
    const started = await startServer({ port: 0, token: TOKEN, storePath: join(dir, 'bookings.json'), maxBooking: '4', spendCeiling: '6' });
    const stream = await openStream(started.url, '/events');
    try {
      const page = await call(started.url, 'GET', '/', undefined, { token: null, json: false });
      assert.equal(page.status, 200);
      assert.match(page.headers['content-type'], /text\/html/);
      assert.match(page.body, /Swanavi/);
      assert.equal(page.body.includes(TOKEN), false);
      const denied = await call(started.url, 'GET', '/budget', undefined, { token: null });
      assert.equal(denied.status, 401);
      assert.equal(denied.body.error, 'unauthorized');
      const funded = await call(started.url, 'POST', '/fund', { method: 'card', amount: '1' });
      assert.equal(funded.body.simulated, true);
      assert.equal(funded.body.label, 'SIMULATED');
      assert.equal(funded.body.onChain, false);
      assert.equal(funded.body.amount, '1');
      const cash = await call(started.url, 'POST', '/fund', { method: 'rlusd', amount: '1' });
      assert.equal(cash.body.simulated, false);
      assert.equal(cash.body.label, 'local ledger credit');
      assert.equal(cash.body.budget.total, '21');
      const opened = await call(started.url, 'POST', '/escrows', { sellerId: 'hotel', amount: '4', deadlineSeconds: 60 });
      assert.equal(opened.status, 201);
      assert.equal(opened.body.txHash, null);
      assert.equal(opened.body.channelId, null);
      assert.equal(opened.body.mode, 'mock');
      await waitFor(stream.text, opened.body.escrowId);
      const limited = await call(started.url, 'POST', '/escrows', { sellerId: 'food', amount: '4.1', deadlineSeconds: 60 });
      assert.equal(limited.body.error, 'amount_limit');
      const stopped = await call(started.url, 'POST', '/kill-switch', { enabled: true });
      assert.equal(stopped.body.killed, true);
      const blocked = await call(started.url, 'POST', '/escrows', { sellerId: 'cab', amount: '2', deadlineSeconds: 60 });
      assert.equal(blocked.body.error, 'killed');
      const refunded = await call(started.url, 'POST', `/escrows/${opened.body.escrowId}/refund`, {});
      assert.equal(refunded.body.status, 'refunded');
      const shops = await call(started.url, 'GET', '/merchants/cab');
      assert.equal(shops.body.price, '2');
    } finally {
      stream.req.destroy();
      await new Promise((resolve, reject) => started.server.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    console.warn = originalWarn;
    if (previous === undefined) delete process.env.SWANAVI_TOKEN;
    else process.env.SWANAVI_TOKEN = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tools.json names the agent calls and does not contain a token', () => {
  const tools = JSON.parse(readFileSync(new URL('../tools.json', import.meta.url), 'utf8'));
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['createEscrow', 'release', 'refund', 'getStatus', 'getBudget', 'closeTrip', 'fund']);
  for (const tool of tools.tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
  }
  assert.equal(JSON.stringify(tools).includes(TOKEN), false);
  assert.equal(namesKeyFile(JSON.stringify(tools)), false);
});

async function pickBudget(payments) {
  return pick(await payments.getBudget());
}

function pick(budget) {
  return { total: budget.total, remaining: budget.remaining, reserved: budget.reserved, spent: budget.spent };
}

async function waitUntil(check, timeoutMs = 2000) {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function openStream(base, path) {
  const target = new URL(path, base);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sse timeout')), 2000);
    let text = '';
    const req = request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: 'GET',
      headers: { 'X-Swanavi-Token': TOKEN },
    }, (res) => {
      res.on('data', (chunk) => {
        text += chunk.toString();
        if (text.includes('event: hello')) {
          clearTimeout(timer);
          resolve({ req, text: () => text });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function waitFor(read, needle) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (read().includes(needle)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - start > 2000) {
        clearInterval(timer);
        reject(new Error(read()));
      }
    }, 20);
  });
}

function call(base, method, path, body, { token = TOKEN, json = true } = {}) {
  const target = new URL(path, base);
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = {};
  if (token) headers['X-Swanavi-Token'] = token;
  if (payload !== null) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: json && text ? JSON.parse(text) : text,
        });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}
