import { FIXTURES } from './catalog.mjs';

// Ports are fixed in the catalog. The x402 helper serves one price per port.
export const TICKET_RESOURCES = FIXTURES.map((row) => ({
  sellerId: row.sellerId,
  name: row.title,
  sku: row.sku,
  title: row.title,
  price: row.unitAmount,
  x402Port: row.x402Port,
  stateId: `${row.sellerId}-${row.sku}`,
  demoTicket: true,
}));

export function ticketResource(sellerId, sku) {
  const entry = TICKET_RESOURCES.find((row) => row.sellerId === sellerId && row.sku === sku);
  if (!entry) throw new Error(`Unknown ticket SKU ${sellerId}/${sku ?? '(missing)'}`);
  return entry;
}
