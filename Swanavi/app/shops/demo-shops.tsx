"use client";

import { useEffect, useRef, useState } from "react";
import { approvePurchase, cancelPurchase, loadItems, loadStores, payPurchase, preparePurchase, refreshPurchase, type ShopAction } from "./shop-actions";
import type { DemoShopItem, DemoStore, StorePurchase } from "@/lib/server/shops";

const POLL_SECONDS = [1, 2, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];

type LogLine = { at: string; text: string; tone: "ok" | "refused" | "pending" };

function outcome(purchase: StorePurchase) {
  if (purchase.status === "paying") return "Payment pending. Polling status; nothing will be paid twice.";
  if (purchase.status !== "paid") return null;
  if (purchase.mode === "mock") return "Demo shop · mock payment. Nothing on chain.";
  if (!purchase.live) return "Paid · no confirmed chain evidence yet.";
  return purchase.settlementStatus === "settled" ? "Demo shop · testnet payment confirmed · settled." : "Demo shop · testnet payment confirmed · settlement pending.";
}

function remaining(expiresAt: string, now: number) {
  const seconds = Math.max(0, Math.round((Date.parse(expiresAt) - now) / 1000));
  return seconds === 0 ? "expired" : `${seconds}s left`;
}

export default function DemoShops() {
  const [stores, setStores] = useState<DemoStore[]>([]);
  const [storeId, setStoreId] = useState("");
  const [items, setItems] = useState<DemoShopItem[]>([]);
  const [sku, setSku] = useState("");
  const [maximum, setMaximum] = useState("");
  const [purchase, setPurchase] = useState<StorePurchase | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);
  const polling = useRef(0);
  const store = stores.find((row) => row.storeId === storeId) ?? null;
  const item = items.find((row) => row.sku === sku) ?? null;

  function note(text: string, tone: LogLine["tone"]) {
    setLog((lines) => [{ at: new Date().toLocaleTimeString(), text, tone }, ...lines].slice(0, 12));
  }

  useEffect(() => {
    void loadStores().then((result) => {
      if (!result.ok) return note(result.message, "refused");
      setStores(result.data.stores);
      setStoreId(result.data.stores[0]?.storeId ?? "");
    });
  }, []);

  useEffect(() => {
    if (!storeId) return;
    let cancelled = false;
    void loadItems(storeId).then((result) => {
      if (cancelled) return;
      if (!result.ok) return note(result.message, "refused");
      setItems(result.data.items);
      setSku(result.data.items[0]?.sku ?? "");
      setMaximum(result.data.items[0]?.amount ?? "");
    });
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  useEffect(() => {
    if (purchase?.status !== "prepared" && purchase?.status !== "approved") return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [purchase?.status]);

  function choose(nextStore: string) {
    setStoreId(nextStore);
    setPurchase(null);
  }

  function pick(nextSku: string) {
    setSku(nextSku);
    setMaximum(items.find((row) => row.sku === nextSku)?.amount ?? "");
    setPurchase(null);
  }

  async function step(label: string, work: () => Promise<ShopAction<{ purchase: StorePurchase }>>) {
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (!result.ok) {
      if (result.purchase) setPurchase(result.purchase);
      note(`${label} refused · ${result.code}: ${result.message}`, "refused");
      return null;
    }
    setPurchase(result.data.purchase);
    const next = result.data.purchase;
    note(`${label} · ${next.status}${next.escrowId ? ` · escrow ${next.escrowId}` : ""}`, next.status === "paying" ? "pending" : "ok");
    return next;
  }

  async function prepare() {
    if (!store || !item) return;
    await step("Agent prepared purchase", () => preparePurchase({
      storeId: store.storeId,
      sku: item.sku,
      maximumAmount: maximum.trim(),
      idempotencyKey: `web-${crypto.randomUUID()}`,
    }));
  }

  async function pay() {
    if (!purchase) return;
    const next = await step("Agent paid", () => payPurchase(purchase.purchaseId));
    if (next?.status === "paying" || (next?.status === "paid" && next.settlementStatus === "pending")) void poll(next.purchaseId);
  }

  async function poll(purchaseId: string) {
    const run = ++polling.current;
    const started = Date.now();
    for (const seconds of POLL_SECONDS) {
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      if (run !== polling.current || Date.now() - started > 60_000) return;
      const result = await refreshPurchase(purchaseId);
      if (!result.ok) return note(`Status refused · ${result.message}`, "refused");
      setPurchase(result.data.purchase);
      const { status, settlementStatus } = result.data.purchase;
      if (status !== "paying" && settlementStatus !== "pending") {
        note(`Status · ${status}${settlementStatus === "settled" ? " · settled" : ""}`, "ok");
        return;
      }
    }
    note(`Still pending after 60 s. Keep this purchase ID; do not buy again.`, "pending");
  }

  const open = purchase?.status === "prepared" || purchase?.status === "approved";

  return (
    <div className="shop-demo">
      <section aria-label="Demo shops">
        <p className="mark">1 · Discover</p>
        <div className="shop-list">
          {stores.map((row) => (
            <button type="button" key={row.storeId} className="shop-card" aria-pressed={row.storeId === storeId} onClick={() => choose(row.storeId)}>
              <span className="shop-name">{row.name}</span>
              <span className="shop-tags">
                <span>{row.category}</span>
                <span className={row.verified ? "tag" : "tag warn"}>{row.verified ? "Verified" : "Unverified"}</span>
              </span>
            </button>
          ))}
        </div>
        {items.length ? (
          <div className="shop-items" role="radiogroup" aria-label="Items">
            {items.map((row) => (
              <label key={row.sku} className="shop-item" data-on={row.sku === sku}>
                <input type="radio" name="sku" checked={row.sku === sku} onChange={() => pick(row.sku)} />
                <span>
                  <strong>{row.title}</strong> · {row.amount} {row.currency}
                  <span className="shop-desc">{row.description}</span>
                </span>
              </label>
            ))}
          </div>
        ) : null}
      </section>

      <section aria-label="Purchase steps" className="shop-steps">
        <div className="shop-step">
          <p className="mark">2 · Agent prepares</p>
          <label className="shop-max">
            Maximum the traveler allows (RLUSD)
            <input value={maximum} inputMode="decimal" onChange={(event) => setMaximum(event.target.value)} />
          </label>
          <button type="button" className="pill" disabled={busy || !item} onClick={() => void prepare()}>Prepare purchase</button>
          <p className="demo-note">Reads the catalog price. Signs and reserves nothing.</p>
        </div>

        <div className="shop-step">
          <p className="mark">3 · Traveler approves</p>
          {purchase ? (
            <div className="demo-review">
              <p><strong>{purchase.title}</strong> at {store?.name ?? purchase.storeId}</p>
              <p>Quantity {purchase.quantity} · {purchase.quotedAmount} {purchase.currency} (max {purchase.maximumAmount})</p>
              <p>{open ? remaining(purchase.expiresAt, now) : `Status ${purchase.status}`}</p>
              <p>Fictional demo shop. Nothing real is delivered.</p>
            </div>
          ) : <p className="demo-note">Prepare a purchase to review it here.</p>}
          <div className="demo-actions">
            <button type="button" className="pill" disabled={busy || purchase?.status !== "prepared"} onClick={() => purchase && void step("Traveler approved", () => approvePurchase(purchase.purchaseId))}>Approve</button>
            <button type="button" className="pill" disabled={busy || !purchase || ["paid", "cancelled", "expired", "failed"].includes(purchase.status)} onClick={() => purchase && void step("Cancel", () => cancelPurchase(purchase.purchaseId))}>Cancel</button>
          </div>
        </div>

        <div className="shop-step">
          <p className="mark">4 · Agent pays</p>
          <div className="demo-actions">
            <button type="button" className="pill" disabled={busy || !purchase} onClick={() => void pay()}>Pay</button>
            <button type="button" className="pill" disabled={busy || !purchase} onClick={() => purchase && void step("Status", () => refreshPurchase(purchase.purchaseId))}>Refresh status</button>
          </div>
          <p className="demo-note">Try Pay before Approve, or Pay twice. The server refuses or returns the same result.</p>
        </div>
      </section>

      {purchase && outcome(purchase) ? (
        <section className="demo-status" aria-label="Result">
          <p><strong>{outcome(purchase)}</strong></p>
          <p>Purchase {purchase.purchaseId}{purchase.escrowId ? ` · escrow ${purchase.escrowId}` : ""}</p>
          {purchase.chargedAmount ? <p>Charged {purchase.chargedAmount} {purchase.currency}{purchase.paidVia ? ` via ${purchase.paidVia}` : ""}</p> : null}
          {purchase.explorerUrl ? <p><a href={purchase.explorerUrl} target="_blank" rel="noreferrer">Transaction {purchase.txHash?.slice(0, 12)}…</a></p> : null}
          {purchase.receiptUrl ? <p><a href={purchase.receiptUrl} target="_blank" rel="noreferrer">Settlement receipt</a></p> : null}
          {purchase.resource ? <pre className="shop-resource">{JSON.stringify(purchase.resource, null, 2)}</pre> : null}
        </section>
      ) : null}

      <section aria-label="Activity" className="shop-log">
        <p className="mark">Activity</p>
        {log.length === 0 ? <p className="demo-note">Server responses appear here.</p> : null}
        <ul>
          {log.map((line, index) => (
            <li key={`${line.at}-${index}`} data-tone={line.tone}><span>{line.at}</span> {line.text}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
