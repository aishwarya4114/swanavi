import { STORES } from './catalog.mjs';

// Stable ports: never derive these from catalog ordering. Each helper instance
// serves exactly one fixed-price /resource, so different SKUs need distinct ports.
const PORTS = {
  'central-park-bikes': { 'BIKE-2H': 4321, 'BIKE-4H': 4322 },
  'midtown-print-shop': { 'PRESS-90': 4323 },
  'midtown-book-nook': { 'READ-90': 4324 },
  'fifth-ave-sketch-room': { 'SKETCH-2H': 4325 },
  'soho-record-shop': { 'LISTEN-60': 4326 },
  'uws-camera-shop': { 'PHOTO-2H': 4327 },
  'east-village-plant-shop': { 'TERRARIUM-90': 4328 },
  'battery-park-outfitters': { 'WALK-2H': 4329 },
  'times-square-souvenir': { 'SOUVENIR-GOLD': 4330 },
};

export const STORE_RESOURCES = STORES.flatMap((store) => store.offers.map((offer) => {
  const x402Port = PORTS[store.storeId]?.[offer.sku];
  if (!x402Port) throw new Error(`Missing x402 port for ${store.storeId}/${offer.sku}`);
  return {
    sellerId: store.storeId, name: store.name, sku: offer.sku,
    title: offer.title, price: offer.amount, x402Port,
    stateId: `${store.storeId}-${offer.sku}`,
  };
}));

export function storeResource(sellerId, sku) {
  const entry = STORE_RESOURCES.find((row) => row.sellerId === sellerId && row.sku === sku);
  if (!entry) throw new Error(`Unknown x402 store SKU ${sellerId}/${sku ?? '(missing)'}`);
  return entry;
}
