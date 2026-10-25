"use server";

import {
  approveDemoQuote,
  cancelDemoHold,
  listDemoOffers,
  listDemoSlots,
  quoteDemoTicket,
  readDemoOrder,
  type TicketOffer,
  type TicketOrder,
  type TicketQuote,
  type TicketSlot,
} from "@/lib/server/tickets";

export type TicketAction<T> = { ok: true; data: T } | { ok: false; message: string };

async function run<T>(work: () => Promise<T>): Promise<TicketAction<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "The ticket service is unavailable." };
  }
}

export async function loadDemoOffers(): Promise<TicketAction<{ offers: TicketOffer[] }>> {
  return run(() => listDemoOffers());
}

export async function loadDemoSlots(attractionId: string, date: string): Promise<TicketAction<{ slots: TicketSlot[] }>> {
  return run(() => listDemoSlots(attractionId, date));
}

export async function quoteDemo(input: { attractionId: string; sku: string; slotId: string }): Promise<TicketAction<{ orderId: string; quote: TicketQuote }>> {
  return run(() => quoteDemoTicket(input));
}

export async function confirmDemoQuote(quoteId: string): Promise<TicketAction<{ quoteId: string; orderId: string; expiresAt: string }>> {
  return run(() => approveDemoQuote(quoteId));
}

export async function refreshDemoOrder(orderId: string): Promise<TicketAction<{ order: TicketOrder }>> {
  return run(() => readDemoOrder(orderId));
}

export async function cancelDemo(orderId: string): Promise<TicketAction<{ order: TicketOrder }>> {
  return run(() => cancelDemoHold(orderId));
}
