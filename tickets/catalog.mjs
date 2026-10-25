/**
 * Demo admission fixtures for New York. These are invented operators.
 * verified means the demo allowlist, not a real-world credential check.
 * Slot dates are America/New_York calendar dates. Adding 24 hours repeats
 * or skips a local date when daylight saving time begins or ends.
 */

import { TicketError, rejectUnknown } from './errors.mjs';

export const CITY = 'New York';
export const TIMEZONE = 'America/New_York';
export const SLOT_TIMES = ['10:00', '14:00'];
export const SLOT_CAPACITY = 5;
export const HORIZON_DAYS = 7;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const OFFER = {
  city: CITY,
  timezone: TIMEZONE,
  currency: 'RLUSD',
  demo: true,
};

export const FIXTURES = [
  {
    attractionId: 'nyc-demo-art-gallery',
    sellerId: 'nyc-demo-art-gallery',
    sku: 'ART-ADULT',
    title: 'NYC Demo Art Gallery',
    indoor: true,
    verified: true,
    unitAmount: '0.20',
    x402Port: 4341,
    ...OFFER,
  },
  {
    attractionId: 'nyc-demo-sky-deck',
    sellerId: 'nyc-demo-sky-deck',
    sku: 'SKY-ADULT',
    title: 'NYC Demo Sky Deck',
    indoor: false,
    verified: true,
    unitAmount: '0.25',
    x402Port: 4342,
    ...OFFER,
  },
  {
    attractionId: 'nyc-demo-history-hall',
    sellerId: 'nyc-demo-history-hall',
    sku: 'HISTORY-ADULT',
    title: 'NYC Demo History Hall',
    indoor: true,
    verified: true,
    unitAmount: '0.15',
    x402Port: 4343,
    ...OFFER,
  },
];

// Present so policy tests can reject it. It is not a public offer and has no seller port.
export const UNVERIFIED_FIXTURE = {
  attractionId: 'nyc-demo-closed-wing',
  sellerId: 'nyc-demo-closed-wing',
  sku: 'CLOSED-ADULT',
  title: 'NYC Demo Closed Wing',
  indoor: true,
  verified: false,
  unitAmount: '0.10',
  x402Port: null,
  ...OFFER,
};

const ROWS = [...FIXTURES, UNVERIFIED_FIXTURE];
const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function localDate(now) {
  return dateFormat.format(new Date(now));
}

export function addCalendarDays(ymd, days) {
  const match = DATE.exec(ymd);
  if (!match) throw new TicketError('invalid_request', 'date must be YYYY-MM-DD.');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new TicketError('invalid_request', 'date must be a real calendar date.');
  }
  const next = new Date(Date.UTC(year, month - 1, day + days));
  return next.toISOString().slice(0, 10);
}

export function bookableDates(now) {
  const today = localDate(now);
  return Array.from({ length: HORIZON_DAYS }, (_item, index) => addCalendarDays(today, index + 1));
}

export function publicOffer(row) {
  return {
    attractionId: row.attractionId,
    sellerId: row.sellerId,
    sku: row.sku,
    title: row.title,
    city: row.city,
    timezone: row.timezone,
    indoor: row.indoor,
    verified: row.verified,
    demo: true,
    unitAmount: row.unitAmount,
    currency: row.currency,
  };
}

export function listOffers(input = {}) {
  rejectUnknown(input, ['city', 'indoor']);
  if (input.city !== CITY) throw new TicketError('invalid_request', 'city must be New York.');
  if (input.indoor !== undefined && typeof input.indoor !== 'boolean') {
    throw new TicketError('invalid_request', 'indoor must be a boolean.');
  }
  return FIXTURES
    .filter((row) => row.verified && (input.indoor === undefined || row.indoor === input.indoor))
    .map(publicOffer);
}

export function attractionById(attractionId) {
  if (typeof attractionId !== 'string' || attractionId.length === 0) {
    throw new TicketError('invalid_request', 'attractionId is required.');
  }
  const row = ROWS.find((item) => item.attractionId === attractionId);
  if (!row) throw new TicketError('not_found', `Unknown attraction ${attractionId}.`);
  return row;
}

export function checkQuantity(quantity) {
  if (quantity !== 1) throw new TicketError('invalid_request', 'quantity must be 1.');
}

export function slotIdFor(attractionId, date, localTime) {
  return `${attractionId}:${date}:${localTime}`;
}

export function slotsFor(attractionId, date, now, usage = {}) {
  const row = attractionById(attractionId);
  let parsed;
  try {
    parsed = addCalendarDays(date, 0);
  } catch (error) {
    if (error instanceof TicketError) throw new TicketError('invalid_request', 'date must be YYYY-MM-DD.');
    throw error;
  }
  if (parsed !== date) throw new TicketError('invalid_request', 'date must be YYYY-MM-DD.');
  if (!bookableDates(now).includes(date)) {
    throw new TicketError('not_available', 'That date is outside the demo booking window.');
  }
  return SLOT_TIMES.map((localTime) => {
    const slotId = slotIdFor(row.attractionId, date, localTime);
    const used = usage[slotId] ?? 0;
    return {
      slotId,
      date,
      localTime,
      timezone: TIMEZONE,
      available: SLOT_CAPACITY - used,
    };
  });
}
