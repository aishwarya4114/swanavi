import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createMerchants } from '../merchants.mjs';
import { createPayments } from '../payments.mjs';
import { startServer } from '../server.mjs';
import { createTicketService } from '../tickets/service.mjs';
import { TOOLS } from '../tickets/mcp.mjs';

const TOKEN = 'test-token';
const APPROVAL = 'approval-token';
const START = Date.parse('2026-10-25T16:00:00.000Z');
const quiet = { log() {}, warn() {}, error() {} };

function call(base, method, path, body, headers = {}) {
  const target = new URL(path, base);
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method,
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const auth = { 'X-Swanavi-Token': TOKEN };
const both = { ...auth, 'X-Ticket-Approval-Token': APPROVAL };

async function listening() {
  const dir = mkdtempSync(join(tmpdir(), 'swanavi-http-'));
  const clock = { value: START };
  const payments = createPayments({
    mode: 'mock', now: () => clock.value, storePath: join(dir, 'bookings.json'),
    maxBooking: '4', spendCeiling: '6', log: quiet,
  });
  const tickets = createTicketService({
    payments, statePath: join(dir, 'tickets.json'), now: () => clock.value, mode: 'mock',
  });
  const started = await startServer({
    port: 0, payments, merchants: createMerchants(), token: TOKEN, tickets, approvalToken: APPROVAL, log: quiet,
  });
  return { dir, started, payments };
}

test('ticket HTTP and MCP agree, and the agent credential cannot approve', async () => {
  const ctx = await listening();
  try {
    const denied = await call(ctx.started.url, 'GET', '/tickets/offers?city=New%20York');
    assert.equal(denied.status, 401);

    const listed = await call(ctx.started.url, 'GET', '/tickets/offers?city=New%20York&indoor=true', null, auth);
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.offers.map((offer) => offer.sku), ['ART-ADULT', 'HISTORY-ADULT']);
    assert.equal(listed.body.offers.every((offer) => offer.demo === true), true);

    const tools = await call(ctx.started.url, 'POST', '/tickets/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, auth);
    const names = tools.body.result.tools.map((tool) => tool.name);
    assert.deepEqual(names, TOOLS.map((tool) => tool.name));
    assert.equal(names.includes('approve'), false);
    assert.equal(JSON.stringify(tools.body).includes('/tickets/approvals'), false);
    const registry = JSON.parse(readFileSync(new URL('../tools.json', import.meta.url), 'utf8'));
    assert.equal(registry.tools.some((tool) => tool.path === '/tickets/approvals'), false);

    const mcpOffers = await call(ctx.started.url, 'POST', '/tickets/mcp', {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'list_ticket_offers', arguments: { city: 'New York', indoor: true } },
    }, auth);
    assert.equal(mcpOffers.body.result.isError, false);
    assert.deepEqual(mcpOffers.body.result.structuredContent, listed.body);
    assert.equal(mcpOffers.body.result.content[0].text, JSON.stringify(listed.body));

    const storeTools = await call(ctx.started.url, 'POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list' }, auth);
    assert.equal(storeTools.body.result.tools.some((tool) => tool.name === 'list_ticket_offers'), false);

    const slots = await call(ctx.started.url, 'GET', '/tickets/offers/nyc-demo-art-gallery/slots?date=2026-10-26', null, auth);
    assert.equal(slots.status, 200);
    assert.equal(slots.body.slots[0].slotId, 'nyc-demo-art-gallery:2026-10-26:10:00');
    const quoted = await call(ctx.started.url, 'POST', '/tickets/quotes', {
      attractionId: 'nyc-demo-art-gallery', sku: 'ART-ADULT', slotId: slots.body.slots[0].slotId, quantity: 1,
    }, auth);
    assert.equal(quoted.status, 201);
    assert.equal(quoted.body.quote.amount, '0.20');

    const early = await call(ctx.started.url, 'POST', '/tickets/mcp', {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'purchase_ticket', arguments: { quoteId: quoted.body.quote.quoteId, idempotencyKey: 'req-http' } },
    }, auth);
    assert.equal(early.body.result.isError, true);
    assert.equal(early.body.result.structuredContent.error.code, 'approval_required');
    assert.equal(early.body.result.content[0].text, JSON.stringify(early.body.result.structuredContent));
    assert.equal((await ctx.payments.listEscrows()).length, 0);

    const missing = await call(ctx.started.url, 'POST', '/tickets/approvals', { quoteId: quoted.body.quote.quoteId }, auth);
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, 'unauthorized');
    const wrong = await call(ctx.started.url, 'POST', '/tickets/approvals', { quoteId: quoted.body.quote.quoteId }, { ...auth, 'X-Ticket-Approval-Token': 'nope' });
    assert.equal(wrong.status, 401);
    const approved = await call(ctx.started.url, 'POST', '/tickets/approvals', { quoteId: quoted.body.quote.quoteId }, both);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.quoteId, quoted.body.quote.quoteId);

    const bought = await call(ctx.started.url, 'POST', '/tickets/mcp', {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'purchase_ticket', arguments: { quoteId: quoted.body.quote.quoteId, idempotencyKey: 'req-http' } },
    }, auth);
    assert.equal(bought.body.result.isError, false);
    assert.equal(bought.body.result.structuredContent.order.status, 'issued');
    assert.equal(bought.body.result.structuredContent.order.ticket.label, 'Demo ticket — not valid for admission');
    assert.equal(bought.body.result.structuredContent.order.payment.live, false);
    const order = await call(ctx.started.url, 'GET', `/tickets/orders/${bought.body.result.structuredContent.order.orderId}`, null, auth);
    assert.equal(order.status, 200);
    assert.equal(order.body.order.ticket.ticketId, bought.body.result.structuredContent.order.ticket.ticketId);
    assert.equal((await ctx.payments.listEscrows()).length, 1);
  } finally {
    ctx.started.server.close();
    ctx.payments.stop();
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('an unresolved purchase is HTTP 202 and not an issued ticket', async () => {
  const payments = createPayments({ mode: 'mock', log: quiet });
  const tickets = {
    async reconcile() {},
    async sweep() {},
    async purchase() {
      return {
        order: {
          orderId: 'ord_pending', quoteId: 'qt_pending', escrowId: 'escrow_pending',
          status: 'payment_pending', paymentStatus: 'pending', ticket: null, payment: null,
          error: { code: 'redeem_unconfirmed', message: 'waiting' },
        },
      };
    },
  };
  const started = await startServer({ port: 0, payments, token: TOKEN, tickets, approvalToken: APPROVAL, log: quiet });
  try {
    const pending = await call(started.url, 'POST', '/tickets/purchases', { quoteId: 'qt_pending', idempotencyKey: 'req-1' }, auth);
    assert.equal(pending.status, 202);
    assert.equal(pending.body.order.status, 'payment_pending');
    assert.equal(pending.body.order.ticket, null);
  } finally {
    started.server.close();
    payments.stop();
  }
});
