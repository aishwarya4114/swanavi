import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { startResourceSellers } from '../x402_sellers.mjs';
import { STORE_RESOURCES, TICKET_RESOURCES, createMerchants } from '../merchants.mjs';
import { FIXTURES } from '../tickets/catalog.mjs';
import { parseRlusd } from '../payments.mjs';
import { join } from 'node:path';

test('seller helper configuration matches all catalog prices, URLs, SKU content and isolated state', async () => {
  const configured = [];
  const merchants = createMerchants({ x402BaseUrl: 'http://127.0.0.1' });
  const sellers = await startResourceSellers({
    host: '127.0.0.1', stateRoot: 'test-state', env: {}, log: { log() {} },
    createX402Merchant(options) {
      const server = new EventEmitter();
      server.listen = (port, host, ready) => { configured.push({ options, port, host }); ready(); };
      return { server, async close() {} };
    },
  });
  assert.equal(sellers.length, 17);
  assert.equal(new Set(configured.map((row) => row.port)).size, 17);
  assert.equal(new Set(configured.map((row) => row.options.stateDirectory)).size, 17);
  for (const entry of STORE_RESOURCES) {
    const { options } = configured.find((row) => row.port === entry.x402Port);
    assert.equal(options.amount, parseRlusd(entry.price).toString());
    assert.equal(options.content.sellerId, entry.sellerId);
    assert.equal(options.content.sku, entry.sku);
    assert.equal(options.resourceUrl, merchants.resourceFor(entry.sellerId, entry.sku));
    assert.equal(options.stateDirectory, join('test-state', entry.stateId));
  }
  assert.deepEqual(TICKET_RESOURCES.map((entry) => [entry.sellerId, entry.sku, entry.price, entry.x402Port]), FIXTURES.map((row) => [row.sellerId, row.sku, row.unitAmount, row.x402Port]));
  for (const entry of TICKET_RESOURCES) {
    const { options } = configured.find((row) => row.port === entry.x402Port);
    assert.equal(options.amount, parseRlusd(entry.price).toString());
    assert.equal(options.content.sku, entry.sku);
    assert.equal(options.content.demo, true);
    assert.equal(options.content.confirmation, undefined);
    assert.equal(options.resourceUrl, merchants.resourceFor(entry.sellerId, entry.sku));
    assert.equal(options.stateDirectory, join('test-state', entry.stateId));
  }
  for (const port of [4311, 4312, 4313, 4314]) {
    assert.equal(configured.filter((row) => row.port === port).length, 1);
  }
  const listed = new Set(merchants.list().map((merchant) => merchant.sellerId));
  assert.equal(listed.has('hotel'), true);
  assert.equal(listed.has('nyc-demo-art-gallery'), false);
  assert.throws(() => createMerchants().resourceFor('nyc-demo-art-gallery', 'ART-ADULT'), (error) => error.code === 'seller_unavailable');
  assert.throws(() => merchants.resourceFor('nyc-demo-art-gallery', 'OTHER'), (error) => error.code === 'bad_request');
});

test('seller startup failure closes resources that were already created', async () => {
  let count = 0;
  let closed = 0;
  await assert.rejects(startResourceSellers({
    host: '127.0.0.1', stateRoot: 'test-state', env: {}, log: { log() {} },
    createX402Merchant() {
      const number = ++count;
      const server = new EventEmitter();
      server.listen = (_port, _host, ready) => {
        if (number === 6) server.emit('error', new Error('port occupied'));
        else ready();
      };
      return { server, async close() { closed++; } };
    },
  }), /port occupied/);
  assert.equal(closed, 6);
});
