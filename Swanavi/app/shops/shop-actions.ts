"use server";

import {
  ShopServiceError,
  approveStorePurchase,
  cancelStorePurchase,
  listDemoStores,
  listStoreItems,
  payStorePurchase,
  prepareStorePurchase,
  readStorePurchase,
  type DemoShopItem,
  type DemoStore,
  type StorePurchase,
} from "@/lib/server/shops";

export type ShopAction<T> =
  | { ok: true; data: T }
  | { ok: false; message: string; code: string; purchase: StorePurchase | null };

async function run<T>(work: () => Promise<T>): Promise<ShopAction<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    if (error instanceof ShopServiceError) return { ok: false, message: error.message, code: error.code, purchase: error.purchase };
    return { ok: false, message: error instanceof Error ? error.message : "The shop service is unavailable.", code: "unavailable", purchase: null };
  }
}

export async function loadStores(): Promise<ShopAction<{ stores: DemoStore[] }>> {
  return run(() => listDemoStores());
}

export async function loadItems(storeId: string): Promise<ShopAction<{ items: DemoShopItem[] }>> {
  return run(() => listStoreItems(storeId));
}

export async function preparePurchase(input: { storeId: string; sku: string; maximumAmount: string; idempotencyKey: string }): Promise<ShopAction<{ purchase: StorePurchase }>> {
  return run(() => prepareStorePurchase(input));
}

export async function approvePurchase(purchaseId: string): Promise<ShopAction<{ purchase: StorePurchase }>> {
  return run(() => approveStorePurchase(purchaseId));
}

export async function payPurchase(purchaseId: string): Promise<ShopAction<{ purchase: StorePurchase }>> {
  return run(() => payStorePurchase(purchaseId));
}

export async function refreshPurchase(purchaseId: string): Promise<ShopAction<{ purchase: StorePurchase }>> {
  return run(() => readStorePurchase(purchaseId));
}

export async function cancelPurchase(purchaseId: string): Promise<ShopAction<{ purchase: StorePurchase }>> {
  return run(() => cancelStorePurchase(purchaseId));
}
