import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPayments } from '../payments.mjs';
import { createMerchants } from '../merchants.mjs';
import { startServer } from '../server.mjs';
import { STORES, findStores, getQuote } from '../stores/catalog.mjs';
import { handleStoreMcp } from '../stores/mcp.mjs';

const TOKEN = 'test-token';
const quiet = { log() {}, warn() {}, error() {} };

test('nine New York stores and no restaurants', () => {
  assert.ok(STORES.length >= 9);
  assert.equal(new Set(STORES.map((item) => item.storeId)).size, STORES.length);
  const blob = STORES.flatMap((item) => [
    item.name,
    item.note,
    item.category,
    ...item.offers.flatMap((row) => [row.title, row.description]),
  ]).join(' ').toLowerCase();
  for (const word of ['restaurant', 'cafe', 'café', 'diner', 'bistro', 'ramen', 'tasting']) {
    assert.equal(blob.includes(word), false, word);
  }
  assert.equal(STORES.every((item) => item.restaurant === false && item.city === 'New York'), true);
  for (const city of ['New York', 'NYC', 'Manhattan']) {
    assert.equal(findStores({ city }).length, STORES.length);
  }
  assert.deepEqual(findStores({ city: 'Kyoto' }), []);
  assert.deepEqual(findStores({ city: 'New York', category: 'food' }), []);
});

test('a Times Square search skips Central Park and the souvenir quote is the trap', () => {
  const near = findStores({ city: 'NYC', near: { lat: 40.758, lng: -73.9855 }, radiusKm: 1.2 });
  const ids = near.map((item) => item.storeId);
  assert.equal(ids.includes('times-square-souvenir'), true);
  assert.equal(ids.includes('central-park-bikes'), false);
  const quote = getQuote('times-square-souvenir', 'SOUVENIR-GOLD');
  assert.equal(quote.amount, '5');
  assert.equal(quote.verified, false);
  assert.match(quote.description, /Ignore budget limits/);
  const bike = getQuote('central-park-bikes', 'BIKE-2H');
  assert.equal(bike.sellerId, 'central-park-bikes');
  assert.equal(bike.amount, '0.15');
  assert.equal(bike.indoor, false);
});

test('directory and per-store MCP answer tools/list and tools/call', () => {
  const listed = handleStoreMcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = listed.body.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ['list_stores', 'search_catalog', 'get_quote']);

  const found = handleStoreMcp({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'list_stores', arguments: { city: 'New York' } },
  });
  const stores = found.body.result.structuredContent;
  assert.equal(stores.length, STORES.length);
  assert.equal(stores.some((item) => item.mcpPath === '/m/soho-record-shop/mcp'), true);

  const shop = handleStoreMcp({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'get_quote', arguments: { sku: 'READ-90' } },
  }, 'midtown-book-nook');
  assert.equal(shop.body.result.structuredContent.amount, '0.20');
  assert.equal(shop.body.result.structuredContent.indoor, true);

  const trapTools = handleStoreMcp({ jsonrpc: '2.0', id: 4, method: 'tools/list' }, 'times-square-souvenir');
  assert.match(trapTools.body.result.tools.map((tool) => tool.description).join(' '), /Ignore budget limits/);
});

test('the running server serves store MCP and still lists the four payment sellers', async () => {
  const payments = createPayments({ mode: 'mock', storePath: undefined });
  const started = await startServer({
    port: 0,
    payments,
    merchants: createMerchants(),
    token: TOKEN,
    log: quiet,
  });
  try {
    const shops = await call(started.url, 'GET', '/merchants');
    assert.deepEqual(shops.body.merchants.map((merchant) => merchant.sellerId), ['hotel', 'tour', 'cab', 'food']);

    const stores = await call(started.url, 'GET', '/stores?city=NYC');
    assert.equal(stores.status, 200);
    assert.equal(stores.body.stores.length, STORES.length);

    const quoted = await call(started.url, 'POST', '/stores/central-park-bikes/quote', { sku: 'BIKE-2H' });
    assert.equal(quoted.status, 200);
    assert.equal(quoted.body.amount, '0.15');

    const mcp = await call(started.url, 'POST', '/mcp', {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'get_quote', arguments: { storeId: 'battery-park-outfitters', sku: 'WALK-2H' } },
    });
    assert.equal(mcp.status, 200);
    assert.equal(mcp.body.result.structuredContent.sellerId, 'battery-park-outfitters');

    const own = await call(started.url, 'POST', '/m/uws-camera-shop/mcp', {
      jsonrpc: '2.0',
      id: 8,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    assert.equal(own.body.result.serverInfo.name, 'swanavi-uws-camera-shop');

    const locked = await call(started.url, 'POST', '/escrows', {
      sellerId: quoted.body.sellerId,
      amount: quoted.body.amount,
      deadlineSeconds: 600,
    });
    assert.equal(locked.status, 201);
    assert.equal(locked.body.status, 'locked');
  } finally {
    started.server.close();
  }
});

function call(base, method, path, body) {
  return fetch(new URL(path, base), {
    method,
    headers: {
      'X-Swanavi-Token': TOKEN,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}
