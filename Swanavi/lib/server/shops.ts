export type DemoStore = {
  storeId: string;
  name: string;
  category: "activity" | "shopping";
  verified: boolean;
};

export type DemoShopItem = {
  storeId: string;
  sku: string;
  title: string;
  amount: string;
  currency: "RLUSD";
  indoor: boolean;
  description: string;
};

export type StorePurchase = {
  purchaseId: string;
  storeId: string;
  sku: string;
  title: string;
  quantity: 1;
  quotedAmount: string;
  maximumAmount: string;
  currency: "RLUSD";
  expiresAt: string;
  status: "prepared" | "approved" | "paying" | "paid" | "cancelled" | "expired" | "failed";
  escrowId: string | null;
  chargedAmount: string | null;
  mode: "mock" | "ap4m";
  demo: true;
  live: boolean;
  paidVia: "x402" | null;
  txHash: string | null;
  explorerUrl: string | null;
  settlementStatus: "not_started" | "pending" | "settled";
  receiptUrl: string | null;
  resource: Record<string, unknown> | null;
  error: null | { code: string; message: string };
};

export class ShopServiceError extends Error {
  readonly code: string;
  readonly purchase: StorePurchase | null;

  constructor(message: string, code: string, purchase: StorePurchase | null) {
    super(message);
    this.code = code;
    this.purchase = purchase;
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const AMOUNT = /^(0|[1-9]\d*)(\.\d{1,18})?$/;

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

function secret(name: "SWANAVI_TOKEN" | "STORE_APPROVAL_TOKEN") {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name}.`);
  return value;
}

function requireId(value: string, label: string) {
  if (!ID.test(value)) throw new Error(`${label} is not a valid id.`);
}

async function call(path: string, init: { method: "GET" | "POST"; body?: unknown; approval?: boolean }) {
  if (!path.startsWith("/stores")) throw new Error("Shop path is not allowlisted.");
  const url = origin();
  const [pathname, search = ""] = path.split("?");
  url.pathname = pathname;
  url.search = search ? `?${search}` : "";
  const headers = new Headers();
  headers.set("X-Swanavi-Token", secret("SWANAVI_TOKEN"));
  if (init.approval) headers.set("X-Store-Approval-Token", secret("STORE_APPROVAL_TOKEN"));
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    method: init.method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const body = await response.json() as { error?: { code?: string; message?: string } | string; message?: string; purchase?: StorePurchase | null };
  if (!response.ok) {
    const error = typeof body.error === "object" ? body.error : { code: body.error, message: body.message };
    throw new ShopServiceError(error?.message || "The shop service refused the request.", error?.code || "unavailable", body.purchase ?? null);
  }
  return body;
}

export async function listDemoStores() {
  return call("/stores?city=NYC", { method: "GET" }) as Promise<{ stores: DemoStore[] }>;
}

export async function listStoreItems(storeId: string) {
  requireId(storeId, "storeId");
  return call(`/stores/${storeId}/catalog`, { method: "GET" }) as Promise<{ items: DemoShopItem[] }>;
}

export async function prepareStorePurchase(input: { storeId: string; sku: string; maximumAmount: string; idempotencyKey: string }) {
  requireId(input.storeId, "storeId");
  requireId(input.sku, "sku");
  requireId(input.idempotencyKey, "idempotencyKey");
  if (!AMOUNT.test(input.maximumAmount)) throw new Error("Maximum must be an RLUSD amount such as 0.15.");
  return call("/stores/purchases", { method: "POST", body: input }) as Promise<{ purchase: StorePurchase }>;
}

export async function approveStorePurchase(purchaseId: string) {
  requireId(purchaseId, "purchaseId");
  return call(`/stores/purchases/${purchaseId}/approve`, { method: "POST", approval: true }) as Promise<{ purchase: StorePurchase }>;
}

export async function payStorePurchase(purchaseId: string) {
  requireId(purchaseId, "purchaseId");
  return call(`/stores/purchases/${purchaseId}/pay`, { method: "POST" }) as Promise<{ purchase: StorePurchase }>;
}

export async function readStorePurchase(purchaseId: string) {
  requireId(purchaseId, "purchaseId");
  return call(`/stores/purchases/${purchaseId}`, { method: "GET" }) as Promise<{ purchase: StorePurchase }>;
}

export async function cancelStorePurchase(purchaseId: string) {
  requireId(purchaseId, "purchaseId");
  return call(`/stores/purchases/${purchaseId}/cancel`, { method: "POST" }) as Promise<{ purchase: StorePurchase }>;
}
