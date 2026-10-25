export type TicketOffer = {
  attractionId: string;
  sellerId: string;
  sku: string;
  title: string;
  city: "New York";
  timezone: "America/New_York";
  indoor: boolean;
  verified: boolean;
  demo: true;
  unitAmount: string;
  currency: "RLUSD";
};

export type TicketSlot = {
  slotId: string;
  date: string;
  localTime: string;
  timezone: "America/New_York";
  available: number;
};

export type TicketQuote = {
  quoteId: string;
  attractionId: string;
  sellerId: string;
  sku: string;
  slotId: string;
  date: string;
  localTime: string;
  timezone: "America/New_York";
  quantity: 1;
  amount: string;
  currency: "RLUSD";
  expiresAt: string;
  policyVersion: number;
  demo: true;
};

export type TicketRecord = {
  ticketId: string;
  label: "Demo ticket — not valid for admission";
  attractionId: string;
  sku: string;
  slotId: string;
  quantity: 1;
  confirmationCode: string;
  issuedAt: string;
};

export type TicketOrder = {
  orderId: string;
  quoteId: string;
  escrowId: string | null;
  status: "quoted" | "payment_pending" | "ticket_pending" | "issued" | "cancelled" | "expired" | "failed";
  paymentStatus: "unpaid" | "pending" | "confirmed";
  ticket: null | TicketRecord;
  payment: null | {
    mode: "mock" | "ap4m";
    live: boolean;
    paidVia: "x402" | null;
    txHash: string | null;
    explorerUrl: string | null;
    receiptUrl: string | null;
  };
  error: null | { code: string; message: string };
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,159}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function origin() {
  const value = process.env.SWANAVI_API_URL;
  if (!value) throw new Error("Set SWANAVI_API_URL.");
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("SWANAVI_API_URL must be http or https.");
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url;
}

function swanaviToken() {
  const value = process.env.SWANAVI_TOKEN;
  if (!value) throw new Error("Set SWANAVI_TOKEN.");
  return value;
}

function approvalToken() {
  const value = process.env.TICKET_APPROVAL_TOKEN;
  if (!value) throw new Error("Set TICKET_APPROVAL_TOKEN.");
  return value;
}

function requireId(value: string, label: string) {
  if (!ID.test(value)) throw new Error(`${label} is not a ticket id.`);
}

async function call(path: string, init: { method: "GET" | "POST"; body?: unknown; approval?: boolean }) {
  if (!path.startsWith("/tickets/")) throw new Error("Ticket path is not allowlisted.");
  const url = origin();
  const [pathname, search = ""] = path.split("?");
  url.pathname = pathname;
  url.search = search ? `?${search}` : "";
  const headers = new Headers();
  headers.set("X-Swanavi-Token", swanaviToken());
  if (init.approval) headers.set("X-Ticket-Approval-Token", approvalToken());
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const body = await response.json() as { error?: { code?: string; message?: string }; message?: string };
  if (!response.ok) {
    throw new Error(body.error?.message || body.message || "The ticket service refused the request.");
  }
  return body;
}

export async function listDemoOffers(indoor?: boolean) {
  const query = new URLSearchParams({ city: "New York" });
  if (indoor !== undefined) query.set("indoor", indoor ? "true" : "false");
  return call(`/tickets/offers?${query}`, { method: "GET" }) as Promise<{ offers: TicketOffer[] }>;
}

export async function listDemoSlots(attractionId: string, date: string) {
  requireId(attractionId, "attractionId");
  if (!DATE.test(date)) throw new Error("date must be YYYY-MM-DD.");
  return call(`/tickets/offers/${attractionId}/slots?date=${date}`, { method: "GET" }) as Promise<{ slots: TicketSlot[] }>;
}

export async function quoteDemoTicket(input: { attractionId: string; sku: string; slotId: string }) {
  requireId(input.attractionId, "attractionId");
  requireId(input.sku, "sku");
  requireId(input.slotId, "slotId");
  return call("/tickets/quotes", {
    method: "POST",
    body: { attractionId: input.attractionId, sku: input.sku, slotId: input.slotId, quantity: 1 },
  }) as Promise<{ orderId: string; quote: TicketQuote }>;
}

export async function approveDemoQuote(quoteId: string) {
  requireId(quoteId, "quoteId");
  return call("/tickets/approvals", { method: "POST", body: { quoteId }, approval: true }) as Promise<{ quoteId: string; orderId: string; expiresAt: string }>;
}

export async function readDemoOrder(orderId: string) {
  requireId(orderId, "orderId");
  return call(`/tickets/orders/${orderId}`, { method: "GET" }) as Promise<{ order: TicketOrder }>;
}

export async function cancelDemoHold(orderId: string) {
  requireId(orderId, "orderId");
  return call(`/tickets/orders/${orderId}/cancel`, { method: "POST" }) as Promise<{ order: TicketOrder }>;
}
