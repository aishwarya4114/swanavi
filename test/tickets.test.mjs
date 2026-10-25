import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { QUOTE_TTL_MS, createTicketService } from '../tickets/service.mjs';
import { TicketError } from '../tickets/errors.mjs';

const START = Date.parse('2026-10-25T16:00:00.000Z');
const SLOT = 'nyc-demo-art-gallery:2026-10-26:10:00';
const INPUT = {
  attractionId: 'nyc-demo-art-gallery',
  sku: 'ART-ADULT',
  slotId: SLOT,
  quantity: 1,
};

function ledger(budget = {}) {
  return {
    async getBudget() {
      return { reserved: '0', spent: '0', maxBooking: '4', spendCeiling: '6', ...budget };
    },
    async createEscrow() {
      throw new Error('a quote must not reserve money');
    },
    async release() {
      throw new Error('a quote must not pay');
    },
  };
}

function directory() {
  return mkdtempSync(join(tmpdir(), 'swanavi-tickets-'));
}

function open(dir, options = {}) {
  const clock = options.clock ?? { value: START };
  const tickets = createTicketService({
    payments: options.payments ?? ledger(options.budget),
    statePath: join(dir, 'state.json'),
    now: () => clock.value,
    mode: options.mode ?? 'mock',
    channelId: options.channelId ?? null,
    readSellerPrice: options.readSellerPrice,
  });
  return { tickets, clock };
}

async function available(tickets, slotId = SLOT) {
  const date = slotId.split(':')[1];
  const attractionId = slotId.slice(0, slotId.indexOf(':'));
  const body = await tickets.getSlots({ attractionId, date });
  return body.slots.find((slot) => slot.slotId === slotId).available;
}

test('a quote holds one seat for 120 seconds and keeps that snapshot', async () => {
  const dir = directory();
  try {
    const { tickets, clock } = open(dir);
    const quoted = await tickets.quote(INPUT);
    assert.equal(quoted.quote.amount, '0.20');
    assert.equal(quoted.quote.quantity, 1);
    assert.equal(quoted.quote.currency, 'RLUSD');
    assert.equal(quoted.quote.demo, true);
    assert.equal(quoted.quote.policyVersion, 1);
    assert.equal(quoted.quote.slotId, SLOT);
    assert.equal(Date.parse(quoted.quote.expiresAt) - clock.value, QUOTE_TTL_MS);
    assert.equal(await available(tickets), 4);
    const again = await tickets.getSlots({ attractionId: INPUT.attractionId, date: '2026-10-26' });
    assert.equal(again.slots.find((slot) => slot.slotId === SLOT).available, 4);
    assert.equal(again.slots.find((slot) => slot.localTime === '14:00').available, 5);
    const saved = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(saved.orders[quoted.orderId].quote.amount, '0.20');
    assert.equal(saved.orders[quoted.orderId].quote.quoteId, quoted.quote.quoteId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capacity is five, cancellation and expiry put the seat back, and restart keeps the hold', async () => {
  const dir = directory();
  try {
    const { tickets, clock } = open(dir);
    const orders = [];
    for (let index = 0; index < 5; index += 1) orders.push(await tickets.quote(INPUT));
    await assert.rejects(tickets.quote(INPUT), (error) => error instanceof TicketError && error.code === 'not_available');
    assert.equal(await available(tickets), 0);
    const cancelled = await tickets.cancel({ orderId: orders[0].orderId });
    assert.equal(cancelled.order.status, 'cancelled');
    assert.equal(cancelled.order.paymentStatus, 'unpaid');
    assert.equal(await available(tickets), 1);
    await assert.rejects(tickets.cancel({ orderId: orders[0].orderId }), (error) => error.code === 'cannot_cancel');
    clock.value += 1;
    const replacement = await tickets.quote(INPUT);
    assert.equal(await available(tickets), 0);

    clock.value = Date.parse(orders[1].quote.expiresAt) - 1;
    assert.equal(await available(tickets), 0);
    clock.value = Date.parse(orders[1].quote.expiresAt);
    await tickets.sweep();
    const expired = await tickets.getOrder({ orderId: orders[1].orderId });
    assert.equal(expired.order.status, 'expired');
    await assert.rejects(tickets.cancel({ orderId: orders[1].orderId }), (error) => error.code === 'cannot_cancel');

    const reloaded = open(dir, { clock });
    const still = await reloaded.tickets.getOrder({ orderId: replacement.orderId });
    assert.equal(still.order.status, 'quoted');
    assert.equal(await available(reloaded.tickets), 4);
    const disk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(disk.orders[replacement.orderId].quote.slotId, SLOT);
    assert.equal(disk.mode, 'mock');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('six concurrent quotes for one slot produce five holds', async () => {
  const dir = directory();
  try {
    const { tickets } = open(dir);
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => tickets.quote(INPUT)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 5);
    assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.code === 'not_available').length, 1);
    assert.equal(await available(tickets), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejected quotes leave inventory empty of holds and a foreign state file is kept', async () => {
  const dir = directory();
  try {
    const { tickets } = open(dir);
    const offers = await tickets.listOffers({ city: 'New York', indoor: true });
    assert.deepEqual(offers.offers.map((offer) => offer.sku), ['ART-ADULT', 'HISTORY-ADULT']);
    await assert.rejects(tickets.quote({ ...INPUT, quantity: 0 }), (error) => error.code === 'invalid_request');
    await assert.rejects(tickets.quote({ ...INPUT, quantity: 2 }), (error) => error.code === 'invalid_request');
    await assert.rejects(tickets.quote({ ...INPUT, amount: '0.01' }), (error) => error.code === 'invalid_request');
    await assert.rejects(tickets.quote({
      attractionId: 'nyc-demo-closed-wing', sku: 'CLOSED-ADULT',
      slotId: 'nyc-demo-closed-wing:2026-10-26:10:00', quantity: 1,
    }), (error) => error.code === 'policy_denied');
    const priced = open(dir, { readSellerPrice: async () => '0.99' });
    await assert.rejects(priced.tickets.quote(INPUT), (error) => error.code === 'price_changed');
    const down = open(dir, { readSellerPrice: async () => { throw new Error('no 402'); } });
    await assert.rejects(down.tickets.quote(INPUT), (error) => error.code === 'supplier_unavailable');
    const same = open(dir, { readSellerPrice: async () => '0.2' });
    const quoted = await same.tickets.quote(INPUT);
    assert.equal(quoted.quote.amount, '0.20');
    assert.equal(await available(same.tickets), 4);

    assert.throws(() => open(dir, { mode: 'ap4m', channelId: '0xabc' }), (error) => error.code === 'invalid_request');
    const disk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    assert.equal(disk.orders[quoted.orderId].status, 'quoted');
    assert.equal(disk.mode, 'mock');
    const reloaded = open(dir);
    assert.equal((await reloaded.tickets.getOrder({ orderId: quoted.orderId })).order.status, 'quoted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('trip budget counts existing reservations and the stricter cap wins', async () => {
  const dir = directory();
  const other = directory();
  try {
    const reserved = open(dir, { budget: { reserved: '0.40', spent: '0.05' } });
    await assert.rejects(reserved.tickets.quote({
      attractionId: 'nyc-demo-history-hall',
      sku: 'HISTORY-ADULT',
      slotId: 'nyc-demo-history-hall:2026-10-26:14:00',
      quantity: 1,
    }), (error) => error.code === 'policy_denied');
    assert.equal(await available(reserved.tickets, 'nyc-demo-history-hall:2026-10-26:14:00'), 5);

    const tight = open(other, { budget: { maxBooking: '0.10' } });
    await assert.rejects(tight.tickets.quote(INPUT), (error) => error.code === 'policy_denied');
    assert.equal(await available(tight.tickets), 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
