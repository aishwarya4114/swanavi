import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FIXTURES,
  SLOT_CAPACITY,
  SLOT_TIMES,
  UNVERIFIED_FIXTURE,
  attractionById,
  bookableDates,
  checkQuantity,
  listOffers,
  localDate,
  slotIdFor,
  slotsFor,
} from '../tickets/catalog.mjs';
import { TicketError } from '../tickets/errors.mjs';

const DAY = 24 * 60 * 60 * 1000;

test('public fixtures are the three demo operators with allowlisted prices and ports', () => {
  assert.deepEqual(FIXTURES.map((row) => ({
    attractionId: row.attractionId,
    sellerId: row.sellerId,
    sku: row.sku,
    title: row.title,
    indoor: row.indoor,
    unitAmount: row.unitAmount,
    x402Port: row.x402Port,
    verified: row.verified,
    demo: row.demo,
    city: row.city,
    timezone: row.timezone,
    currency: row.currency,
  })), [
    {
      attractionId: 'nyc-demo-art-gallery', sellerId: 'nyc-demo-art-gallery', sku: 'ART-ADULT',
      title: 'NYC Demo Art Gallery', indoor: true, unitAmount: '0.20', x402Port: 4341,
      verified: true, demo: true, city: 'New York', timezone: 'America/New_York', currency: 'RLUSD',
    },
    {
      attractionId: 'nyc-demo-sky-deck', sellerId: 'nyc-demo-sky-deck', sku: 'SKY-ADULT',
      title: 'NYC Demo Sky Deck', indoor: false, unitAmount: '0.25', x402Port: 4342,
      verified: true, demo: true, city: 'New York', timezone: 'America/New_York', currency: 'RLUSD',
    },
    {
      attractionId: 'nyc-demo-history-hall', sellerId: 'nyc-demo-history-hall', sku: 'HISTORY-ADULT',
      title: 'NYC Demo History Hall', indoor: true, unitAmount: '0.15', x402Port: 4343,
      verified: true, demo: true, city: 'New York', timezone: 'America/New_York', currency: 'RLUSD',
    },
  ]);
  assert.equal(UNVERIFIED_FIXTURE.verified, false);
  assert.equal(UNVERIFIED_FIXTURE.x402Port, null);
  assert.equal(listOffers({ city: 'New York' }).some((row) => row.attractionId === UNVERIFIED_FIXTURE.attractionId), false);
});

test('offer listing is New York only and can filter indoor', () => {
  const offers = listOffers({ city: 'New York' });
  assert.equal(offers.length, 3);
  assert.deepEqual(offers.map((row) => row.attractionId), FIXTURES.map((row) => row.attractionId));
  for (const offer of offers) {
    assert.equal(offer.sellerId, offer.attractionId);
    assert.equal(offer.demo, true);
    assert.equal(offer.currency, 'RLUSD');
    assert.equal(offer.timezone, 'America/New_York');
  }
  assert.deepEqual(listOffers({ city: 'New York', indoor: true }).map((row) => row.sku), ['ART-ADULT', 'HISTORY-ADULT']);
  assert.deepEqual(listOffers({ city: 'New York', indoor: false }).map((row) => row.sku), ['SKY-ADULT']);
  assert.throws(() => listOffers({ city: 'NYC' }), (error) => error instanceof TicketError && error.code === 'invalid_request');
  assert.throws(() => listOffers({ city: 'New York', amount: '0.01' }), (error) => error.code === 'invalid_request');
  assert.throws(() => listOffers({ city: 'New York', indoor: 'true' }), (error) => error.code === 'invalid_request');
});

test('slots are 10:00 and 14:00 for the next seven local dates and keep supplied usage', () => {
  const now = Date.parse('2026-10-25T16:00:00.000Z');
  assert.equal(localDate(now), '2026-10-25');
  const dates = bookableDates(now);
  assert.deepEqual(dates, [
    '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01',
  ]);
  const slotId = slotIdFor('nyc-demo-art-gallery', '2026-10-26', '10:00');
  const usage = { [slotId]: 2 };
  const first = slotsFor('nyc-demo-art-gallery', '2026-10-26', now, usage);
  const second = slotsFor('nyc-demo-art-gallery', '2026-10-26', now, usage);
  assert.deepEqual(first, second);
  assert.equal(usage[slotId], 2);
  assert.deepEqual(first.map((slot) => slot.localTime), SLOT_TIMES);
  assert.equal(first[0].available, SLOT_CAPACITY - 2);
  assert.equal(first[1].available, SLOT_CAPACITY);
  assert.equal(first[0].slotId, 'nyc-demo-art-gallery:2026-10-26:10:00');
  assert.equal(first[0].timezone, 'America/New_York');
});

test('fall-back and spring-forward dates stay on the local calendar', () => {
  const midnightBeforeFallback = Date.parse('2026-11-01T04:00:00.000Z');
  assert.equal(localDate(midnightBeforeFallback), '2026-11-01');
  assert.equal(localDate(midnightBeforeFallback + DAY), '2026-11-01');
  assert.deepEqual(bookableDates(midnightBeforeFallback), [
    '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08',
  ]);

  const eveningBeforeSpring = Date.parse('2027-03-14T00:30:00.000Z');
  assert.equal(localDate(eveningBeforeSpring), '2027-03-13');
  const slots = slotsFor('nyc-demo-history-hall', '2027-03-14', eveningBeforeSpring, {});
  assert.deepEqual(slots.map((slot) => [slot.date, slot.localTime, slot.available]), [
    ['2027-03-14', '10:00', 5],
    ['2027-03-14', '14:00', 5],
  ]);
  assert.equal(slots[0].slotId, 'nyc-demo-history-hall:2027-03-14:10:00');
});

test('invalid attraction, date, and quantity are rejected', () => {
  const now = Date.parse('2026-10-25T16:00:00.000Z');
  assert.throws(() => attractionById('central-park'), (error) => error.code === 'not_found');
  assert.throws(() => attractionById(''), (error) => error.code === 'invalid_request');
  assert.throws(() => slotsFor('nyc-demo-art-gallery', '2026-02-31', now), (error) => error.code === 'invalid_request');
  assert.throws(() => slotsFor('nyc-demo-art-gallery', '10/26/2026', now), (error) => error.code === 'invalid_request');
  assert.throws(() => slotsFor('nyc-demo-art-gallery', '2026-10-25', now), (error) => error.code === 'not_available');
  assert.throws(() => slotsFor('nyc-demo-missing', '2026-10-26', now), (error) => error.code === 'not_found');
  for (const quantity of [0, 2, 1.5, '1', null]) {
    assert.throws(() => checkQuantity(quantity), (error) => error.code === 'invalid_request');
  }
  assert.doesNotThrow(() => checkQuantity(1));
});
