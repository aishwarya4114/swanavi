/**
 * Four legacy sellers and nine catalog stores. outcome is a switch:
 *   deliver — finish calls release
 *   cancel  — finish calls refund
 *   fail    — finish calls refund
 * Prices are demo quotes. Nothing here talks to a chain.
 *
 * Each seller also has a fixed x402 port. When createMerchants gets an x402BaseUrl
 * (server: X402_SELLERS=http://127.0.0.1), the seller carries resourceUrl and a live
 * release buys over x402 from that URL instead of signing a voucher directly.
 */

import { PaymentError, formatRlusd, parseRlusd } from './payments.mjs';
import { STORES } from './stores/catalog.mjs';
import { STORE_RESOURCES, storeResource } from './stores/x402.mjs';
import { TICKET_RESOURCES, ticketResource } from './tickets/x402.mjs';

export { STORE_RESOURCES, TICKET_RESOURCES };

export const DEFAULTS = [
  { sellerId: 'hotel', name: 'The Plaza Hotel', price: '4', x402Port: 4311 },
  { sellerId: 'tour', name: 'Statue of Liberty Ferry', price: '3', x402Port: 4312 },
  { sellerId: 'cab', name: 'Yellow Cab, Midtown to Brooklyn', price: '2', x402Port: 4313 },
  { sellerId: 'food', name: "Katz's Delicatessen", price: '2.5', x402Port: 4314 },
];

const OUTCOMES = new Set(['deliver', 'cancel', 'fail']);

export function resourceUrlFor(baseUrl, entry) {
  if (!baseUrl) return null;
  const url = new URL(baseUrl);
  url.port = String(entry.x402Port);
  url.pathname = '/resource';
  url.search = '';
  url.hash = '';
  return url.href;
}

export function createMerchants({ sellers = [], x402BaseUrl = null } = {}) {
  const merchants = new Map(DEFAULTS.map((entry) => [entry.sellerId, {
    sellerId: entry.sellerId,
    name: entry.name,
    price: formatRlusd(parseRlusd(entry.price)),
    outcome: 'deliver',
    finalBill: null,
    x402Port: entry.x402Port,
    resourceUrl: resourceUrlFor(x402BaseUrl, entry),
  }]));
  for (const store of STORES) {
    merchants.set(store.storeId, {
      sellerId: store.storeId, name: store.name, price: store.offers[0].amount,
      outcome: 'deliver', finalBill: null,
      offers: STORE_RESOURCES.filter((entry) => entry.sellerId === store.storeId)
        .map((entry) => ({ sku: entry.sku, price: entry.price, resourceUrl: resourceUrlFor(x402BaseUrl, entry) })),
    });
  }
  for (const saved of sellers) {
    const merchant = merchants.get(saved?.sellerId);
    if (!merchant || !OUTCOMES.has(saved.outcome)) continue;
    merchant.outcome = saved.outcome;
    merchant.finalBill = saved.finalBill ?? null;
  }

  function mustGet(sellerId) {
    const merchant = merchants.get(sellerId);
    if (!merchant) throw new PaymentError('seller_not_found', `Unknown seller ${sellerId}.`, { sellerId });
    return merchant;
  }

  function view(merchant) {
    return { ...merchant };
  }

  function list() {
    return [...merchants.values()].map(view);
  }

  function get(sellerId) {
    return view(mustGet(sellerId));
  }

  /**
   * @param {string} sellerId
   * @param {{ outcome: 'deliver' | 'cancel' | 'fail', finalBill?: string | null }} patch
   */
  function setSwitch(sellerId, patch) {
    const merchant = mustGet(sellerId);
    if (!patch || !OUTCOMES.has(patch.outcome)) {
      throw new PaymentError('bad_request', 'outcome must be deliver, cancel, or fail.');
    }
    if (patch.outcome !== 'deliver' && patch.finalBill != null) {
      throw new PaymentError('bad_request', 'finalBill is only used when outcome is deliver.');
    }
    merchant.outcome = patch.outcome;
    if (patch.finalBill == null) merchant.finalBill = null;
    else merchant.finalBill = formatRlusd(parseRlusd(patch.finalBill));
    return view(merchant);
  }

  function exportState() {
    return list();
  }

  function resourceFor(sellerId, sku) {
    if (STORES.some((store) => store.storeId === sellerId)) {
      if (!x402BaseUrl) throw new PaymentError('seller_unavailable', 'Catalog payments require X402_SELLERS.');
      let entry;
      try { entry = storeResource(sellerId, sku); }
      catch (error) { throw new PaymentError('bad_request', error.message); }
      return resourceUrlFor(x402BaseUrl, entry);
    }
    if (TICKET_RESOURCES.some((entry) => entry.sellerId === sellerId)) {
      if (!x402BaseUrl) throw new PaymentError('seller_unavailable', 'Ticket payments require X402_SELLERS.');
      let entry;
      try { entry = ticketResource(sellerId, sku); }
      catch (error) { throw new PaymentError('bad_request', error.message); }
      return resourceUrlFor(x402BaseUrl, entry);
    }
    return merchants.get(sellerId)?.resourceUrl ?? null;
  }

  return { list, get, setSwitch, exportState, resourceFor };
}

/**
 * Apply the seller switch. Locked funds are released only for deliver.
 * cancel and fail both call refund. A deadline that already refunded the
 * escrow is left as it is.
 */
export async function finishEscrow(payments, merchants, escrowId) {
  const current = await payments.getStatus(escrowId);
  if (current.status !== 'locked') return current;
  const merchant = merchants.get(current.sellerId);
  if (merchant.outcome === 'cancel' || merchant.outcome === 'fail') {
    return payments.refund(escrowId);
  }
  if (merchant.finalBill == null) return payments.release(escrowId);
  return payments.release(escrowId, merchant.finalBill);
}
