/**
 * Local JSON API and dashboard, version 3.
 *   PAYMENTS_MODE=mock  (default) local ledger, nothing on chain, badge MOCK.
 *   PAYMENTS_MODE=ap4m  live: one AP4M trip channel, vouchers signed by the agent wallet, budget
 *                       read from the chain, badge LIVE. Needs TRIP_CHANNEL_ID and the agent key
 *                       in the environment; ap4m_executor.mjs is the only file that reads them.
 *   X402_SELLERS=http://127.0.0.1  (ap4m) sellers are x402 merchants on ports 4311–4314
 *                       (x402_sellers.mjs); release reads the 402, refuses above the lock,
 *                       signs, and the seller redeems. Without it, release signs a voucher directly.
 * This file holds no key, prints no key, and never opens a channel.
 */

import { timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMerchants, finishEscrow } from './merchants.mjs';
import { API_VERSION, PaymentError, createPayments, formatRlusd } from './payments.mjs';
import { findStores, getQuote, searchCatalog } from './stores/catalog.mjs';
import { handleStoreMcp } from './stores/mcp.mjs';
import { TicketError } from './tickets/errors.mjs';
import { handleTicketMcp } from './tickets/mcp.mjs';
import { createTicketService } from './tickets/service.mjs';

const DEFAULT_PORT = 8787;
const BODY_LIMIT = 32_768;
const here = dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(join(here, 'dashboard.html'));

export function createHandler({ payments, merchants, token, tickets, approvalToken = null }) {
  const clients = new Set();
  const requestLog = [];

  function fanout(event) {
    const packet = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      try { client.write(packet); } catch { clients.delete(client); }
    }
  }

  function remember(method, path, status) {
    const entry = { at: new Date().toISOString(), method, path, status };
    requestLog.unshift(entry);
    if (requestLog.length > 40) requestLog.pop();
    fanout({ type: 'log', entry });
  }

  payments.setSellerStatus((sellerId) => {
    try { return merchants.get(sellerId).outcome; } catch { return null; }
  });
  payments.setSellerResource((sellerId, sku) => merchants.resourceFor(sellerId, sku));
  payments.setStoreExtra(() => ({ sellers: merchants.exportState() }));
  payments.setOnEvent((event) => fanout(event));

  return async function handler(req, res) {
    try {
      if (req.method === 'OPTIONS') {
        writeHead(res, 204);
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': dashboardHtml.length,
          'Cache-Control': 'no-store',
          ...cors(),
        });
        res.end(dashboardHtml);
        remember(req.method, url.pathname, 200);
        return;
      }
      authorize(req, token);
      const parts = url.pathname.split('/').filter(Boolean);
      const body = req.method === 'POST' ? await readBody(req) : {};
      await route(req.method ?? 'GET', parts, body, req, res, payments, merchants, clients, requestLog, tickets, approvalToken);
      remember(req.method, url.pathname, res.statusCode || 200);
    } catch (error) {
      const code = error instanceof PaymentError ? error.code : 'internal';
      if (!res.headersSent) sendError(res, error);
      remember(req.method, new URL(req.url ?? '/', 'http://127.0.0.1').pathname, res.statusCode || statusFor(code));
    }
  };
}

export async function startServer({
  port = DEFAULT_PORT,
  host = '127.0.0.1',
  payments,
  merchants,
  token,
  storePath,
  maxBooking = '4',
  spendCeiling = '6',
  mode = 'mock',
  executor = null,
  x402BaseUrl = null,
  tickets = null,
  approvalToken = null,
  ticketStatePath = null,
  channelId = null,
  now = null,
  log = console,
} = {}) {
  const expected = token ?? process.env.SWANAVI_TOKEN;
  if (!expected) {
    throw new PaymentError('bad_request', 'Set SWANAVI_TOKEN. This server does not invent a token.');
  }
  const file = storePath ?? join(here, 'bookings.json');
  const pay = payments ?? createPayments({
    mode: mode === 'ap4m' ? 'ap4m' : 'mock',
    maxBooking,
    spendCeiling,
    storePath: file,
    executor,
    log,
  });
  const shops = merchants ?? createMerchants({ sellers: pay.loadedSellers ?? [], x402BaseUrl });
  if (pay.live) {
    const withX402 = shops.list().filter((s) => s.resourceUrl).map((s) => `${s.sellerId}=${s.resourceUrl}`);
    log.log?.(withX402.length ? `x402 sellers: ${withX402.join(' ')}` : 'no X402_SELLERS set: live release signs vouchers directly');
  }
  warnIfOpen(host, log);
  let reconciled = null;
  if (pay.live) {
    reconciled = await pay.reconcile();
    log.log?.(`reconciled ${reconciled.checked} booking(s) with the chain; changes: ${JSON.stringify(reconciled.changes)}${reconciled.drift ? `; DRIFT ${JSON.stringify(reconciled.drift)}` : ''}`);
  }
  const approval = approvalToken ?? process.env.TICKET_APPROVAL_TOKEN ?? null;
  const readSellerPrice = pay.live && executor && typeof executor.quote === 'function'
    ? async (sellerId, sku) => formatRlusd((await executor.quote(shops.resourceFor(sellerId, sku))).price)
    : null;
  const desk = tickets ?? createTicketService({
    payments: pay,
    statePath: ticketStatePath ?? join(here, 'tickets-state', 'state.json'),
    now: now ?? (() => Date.now()),
    mode: pay.mode,
    channelId: pay.live ? (executor?.channelId ?? channelId ?? null) : null,
    readSellerPrice,
  });
  await desk.reconcile();
  const server = createServer(createHandler({ payments: pay, merchants: shops, token: expected, tickets: desk, approvalToken: approval }));
  const timer = setInterval(() => { pay.sweep(); desk.sweep().catch((error) => log.warn?.(`ticket sweep failed: ${String(error.message).slice(0, 120)}`)); }, 1000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); pay.stop?.(); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolve({ server, host, port: bound, url: `http://${host}:${bound}`, payments: pay, merchants: shops, tickets: desk, reconciled });
    });
  });
}

async function route(method, parts, body, req, res, payments, merchants, clients, requestLog, tickets, approvalToken) {
  if (method === 'GET' && parts.length === 1 && parts[0] === 'health') {
    return send(res, 200, {
      ok: true,
      mode: payments.mode,
      live: payments.live,
      badge: payments.live ? 'LIVE' : 'MOCK',
      network: payments.live ? 'xrpl-evm-testnet' : 'disabled',
      service: 'swanavi-pay',
      version: API_VERSION,
    });
  }
  if (method === 'GET' && parts.length === 1 && parts[0] === 'budget') {
    return send(res, 200, await payments.getBudget());
  }
  if (method === 'GET' && parts.length === 1 && parts[0] === 'trip') {
    const budget = await payments.getBudget();
    return send(res, 200, { mode: payments.mode, live: payments.live, trip: budget.trip, fund: budget.fund, drift: budget.drift });
  }
  if (method === 'POST' && parts.length === 2 && parts[0] === 'trip' && parts[1] === 'close') {
    return send(res, 200, await payments.closeTrip());
  }
  if (method === 'GET' && parts.length === 1 && parts[0] === 'events') {
    return openEvents(req, res, payments, clients, requestLog);
  }
  if (method === 'GET' && parts.length === 1 && parts[0] === 'log') {
    return send(res, 200, { log: requestLog });
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'fund') {
    return send(res, 200, await fundResponse(payments, body));
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'kill-switch') {
    if (typeof body.enabled !== 'boolean') {
      throw new PaymentError('bad_request', 'enabled must be true or false.');
    }
    return send(res, 200, await payments.setKilled(body.enabled));
  }
  if (method === 'GET' && parts.length === 1 && parts[0] === 'stores') {
    return send(res, 200, { stores: storesFromQuery(req) });
  }
  if (method === 'GET' && parts.length === 3 && parts[0] === 'stores' && parts[2] === 'catalog') {
    return send(res, 200, { items: asStore(() => searchCatalog(parts[1], { query: searchParams(req).get('query') ?? undefined })) });
  }
  if (method === 'POST' && parts.length === 3 && parts[0] === 'stores' && parts[2] === 'quote') {
    if (typeof body.sku !== 'string' || body.sku.length === 0) {
      throw new PaymentError('bad_request', 'sku is required.');
    }
    return send(res, 200, asStore(() => getQuote(parts[1], body.sku)));
  }
  if (parts[0] === 'tickets') {
    return dispatchTickets(method, parts, body, req, res, tickets, approvalToken);
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'mcp') {
    return sendMcp(res, handleStoreMcp(body));
  }
  if (method === 'POST' && parts.length === 3 && parts[0] === 'm' && parts[2] === 'mcp') {
    return sendMcp(res, handleStoreMcp(body, parts[1]));
  }
  if (method === 'GET' && parts.length === 1 && parts[0] === 'merchants') {
    return send(res, 200, { merchants: merchants.list() });
  }
  if (method === 'GET' && parts.length === 2 && parts[0] === 'merchants') {
    return send(res, 200, merchants.get(parts[1]));
  }
  if (method === 'POST' && parts.length === 3 && parts[0] === 'merchants' && parts[2] === 'switch') {
    const seller = merchants.setSwitch(parts[1], body);
    payments.flush();
    return send(res, 200, seller);
  }
  if (method === 'GET' && parts.length === 1 && parts[0] === 'escrows') {
    return send(res, 200, { escrows: await payments.listEscrows() });
  }
  if (method === 'POST' && parts.length === 1 && parts[0] === 'escrows') {
    const escrowId = await payments.createEscrow(body.sellerId, body.amount, body.deadlineSeconds, body.sku);
    return send(res, 201, await payments.getStatus(escrowId));
  }
  if (parts[0] === 'escrows' && parts.length === 2 && method === 'GET') {
    return send(res, 200, await payments.getStatus(parts[1]));
  }
  if (parts[0] === 'escrows' && parts.length === 3 && method === 'POST' && parts[2] === 'release') {
    const status = body.finalBill === undefined
      ? await payments.release(parts[1])
      : await payments.release(parts[1], body.finalBill);
    return send(res, 200, status);
  }
  if (parts[0] === 'escrows' && parts.length === 3 && method === 'POST' && parts[2] === 'refund') {
    return send(res, 200, await payments.refund(parts[1]));
  }
  if (parts[0] === 'escrows' && parts.length === 3 && method === 'POST' && parts[2] === 'finish') {
    return send(res, 200, await finishEscrow(payments, merchants, parts[1]));
  }
  throw new PaymentError('not_found', `No route for ${method} /${parts.join('/')}.`);
}

async function dispatchTickets(method, parts, body, req, res, tickets, approvalToken) {
  try {
    if (!tickets) throw new TicketError('not_found', 'Ticket service is not configured.');
    if (method === 'GET' && parts.length === 2 && parts[1] === 'offers') {
      return send(res, 200, await tickets.listOffers(offersInput(req)));
    }
    if (method === 'GET' && parts.length === 4 && parts[1] === 'offers' && parts[3] === 'slots') {
      const params = onlyQuery(req, ['date']);
      if (!params.has('date')) throw new TicketError('invalid_request', 'date is required.');
      return send(res, 200, await tickets.getSlots({ attractionId: parts[2], date: params.get('date') }));
    }
    if (method === 'POST' && parts.length === 2 && parts[1] === 'quotes') {
      return send(res, 201, await tickets.quote(body));
    }
    if (method === 'POST' && parts.length === 2 && parts[1] === 'purchases') {
      const result = await tickets.purchase(body);
      const pending = result.order.status === 'payment_pending' || result.order.status === 'ticket_pending';
      return send(res, pending ? 202 : 200, result);
    }
    if (method === 'GET' && parts.length === 3 && parts[1] === 'orders') {
      return send(res, 200, await tickets.getOrder({ orderId: parts[2] }));
    }
    if (method === 'POST' && parts.length === 4 && parts[1] === 'orders' && parts[3] === 'cancel') {
      return send(res, 200, await tickets.cancel({ orderId: parts[2] }));
    }
    if (method === 'POST' && parts.length === 2 && parts[1] === 'approvals') {
      authorizeApproval(req, approvalToken);
      return send(res, 200, await tickets.approve(body));
    }
    if (method === 'POST' && parts.length === 2 && parts[1] === 'mcp') {
      return sendMcp(res, await handleTicketMcp(body, tickets));
    }
    throw new TicketError('not_found', `No route for ${method} /${parts.join('/')}.`);
  } catch (error) {
    if (res.headersSent) throw error;
    const code = error instanceof TicketError ? error.code : (error instanceof PaymentError ? error.code : 'invalid_request');
    const status = error instanceof TicketError ? error.status : (error instanceof PaymentError ? statusFor(error.code) : 400);
    return send(res, status, {
      error: { code, message: error instanceof Error ? error.message : 'Request failed.' },
      ...(error instanceof TicketError && error.orderId ? { orderId: error.orderId } : {}),
    });
  }
}

function offersInput(req) {
  const params = onlyQuery(req, ['city', 'indoor']);
  if (!params.has('city')) throw new TicketError('invalid_request', 'city must be New York.');
  const input = { city: params.get('city') };
  if (!params.has('indoor')) return input;
  const indoor = params.get('indoor');
  if (indoor === 'true') input.indoor = true;
  else if (indoor === 'false') input.indoor = false;
  else throw new TicketError('invalid_request', 'indoor must be true or false.');
  return input;
}

function onlyQuery(req, allowed) {
  const params = searchParams(req);
  for (const key of params.keys()) {
    if (!allowed.includes(key)) throw new TicketError('invalid_request', `Unknown field ${key}.`);
  }
  return params;
}

function authorizeApproval(req, expected) {
  if (typeof expected !== 'string' || expected.length === 0) {
    throw new TicketError('unauthorized', 'Send header X-Ticket-Approval-Token.');
  }
  const header = req.headers['x-ticket-approval-token'];
  if (typeof header !== 'string') {
    throw new TicketError('unauthorized', 'Send header X-Ticket-Approval-Token.');
  }
  const got = Buffer.from(header);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new TicketError('unauthorized', 'Send header X-Ticket-Approval-Token.');
  }
}

async function fundResponse(payments, body) {
  if (body.method !== 'rlusd' && body.method !== 'crypto' && body.method !== 'card') {
    throw new PaymentError('bad_request', 'method must be rlusd, crypto, or card.');
  }
  const simulated = body.method !== 'rlusd';
  const funded = await payments.fund(body.amount);
  return {
    method: body.method,
    amount: funded.credited,
    simulated,
    label: simulated ? 'SIMULATED' : 'local ledger credit',
    onChain: false,
    mode: funded.budget.mode,
    budget: funded.budget,
  };
}

async function openEvents(req, res, payments, clients, requestLog) {
  const hello = {
    type: 'hello',
    budget: await payments.getBudget(),
    bookings: await payments.listEscrows(),
    log: requestLog.slice(0, 12),
  };
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    ...cors(),
  });
  clients.add(res);
  res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, 15000);
  beat.unref();
  req.on('close', () => {
    clearInterval(beat);
    clients.delete(res);
  });
}

function authorize(req, expected) {
  const header = req.headers['x-swanavi-token'];
  if (typeof header !== 'string') {
    throw new PaymentError('unauthorized', 'Send header X-Swanavi-Token.');
  }
  const got = Buffer.from(header);
  const want = Buffer.from(expected);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new PaymentError('unauthorized', 'Send header X-Swanavi-Token.');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        fail(new PaymentError('bad_request', 'JSON body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return succeed({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          fail(new PaymentError('bad_request', 'JSON body must be an object.'));
          return;
        }
        succeed(parsed);
      } catch {
        fail(new PaymentError('bad_request', 'Body must be JSON.'));
      }
    });
    req.on('error', fail);
  });
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Swanavi-Token',
    'Cache-Control': 'no-store',
  };
}

function asStore(read) {
  try {
    return read();
  } catch (error) {
    if (error.code === 'store_not_found' || error.code === 'sku_not_found') {
      throw new PaymentError('not_found', error.message);
    }
    throw error;
  }
}

function storesFromQuery(req) {
  const params = searchParams(req);
  const near = params.get('lat') != null && params.get('lng') != null
    ? { lat: Number(params.get('lat')), lng: Number(params.get('lng')) }
    : undefined;
  const radius = params.get('radiusKm');
  return findStores({
    city: params.get('city') ?? undefined,
    category: params.get('category') ?? undefined,
    near,
    radiusKm: radius == null ? undefined : Number(radius),
  });
}

function searchParams(req) {
  return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
}

function sendMcp(res, result) {
  if (result.status === 202) {
    writeHead(res, 202, 0);
    res.end();
    return;
  }
  send(res, result.status, result.body);
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  writeHead(res, status, Buffer.byteLength(payload));
  res.end(payload);
}

function writeHead(res, status, length) {
  if (res.headersSent || res.writableEnded) return;
  const headers = cors();
  if (length !== undefined) {
    headers['Content-Type'] = 'application/json; charset=utf-8';
    headers['Content-Length'] = length;
  }
  res.writeHead(status, headers);
}

function statusFor(code) {
  return {
    bad_request: 400,
    bad_amount: 400,
    unauthorized: 401,
    not_found: 404,
    seller_not_found: 404,
    over_budget: 409,
    overcharged: 409,
    over_cap: 409,
    invalid_state: 409,
    seller_cancelled: 409,
    seller_failed: 409,
    amount_limit: 409,
    spend_ceiling: 409,
    killed: 409,
    channel_closed: 409,
    live_mode: 409,
    in_progress: 409,
    idempotency_conflict: 409,
    seller_unavailable: 502,
    redeem_failed: 502,
    redeem_unconfirmed: 503,
    close_failed: 502,
    chain_unavailable: 503,
  }[code] ?? 500;
}

function sendError(res, error) {
  const code = error instanceof PaymentError ? error.code : 'internal';
  send(res, statusFor(code), {
    error: code,
    message: error instanceof Error ? error.message : 'Request failed.',
    ...(error instanceof PaymentError ? error.details : {}),
  });
}

export function warnIfOpen(host, log = console) {
  if (host === '0.0.0.0' || host === '::') {
    log.warn('WARNING: HOST is open. This API is reachable from other machines.');
    return true;
  }
  return false;
}

function runningAsCli() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  const port = process.env.PORT ? Number(process.env.PORT) : DEFAULT_PORT;
  const host = process.env.HOST || '127.0.0.1';
  const mode = process.env.PAYMENTS_MODE === 'ap4m' ? 'ap4m' : 'mock';
  (async () => {
    let executor = null;
    if (mode === 'ap4m') {
      const { createExecutorFromEnv } = await import('./ap4m_executor.mjs');
      executor = await createExecutorFromEnv();
      console.log(`live mode: agent ${executor.agent}, trip channel ${executor.channelId}`);
    }
    const { url, host: boundHost } = await startServer({
      port,
      host,
      mode,
      executor,
      x402BaseUrl: process.env.X402_SELLERS || null,
      maxBooking: process.env.MAX_BOOKING_RLUSD || '4',
      spendCeiling: process.env.REAL_SPEND_CEILING || '6',
    });
    console.log(`escrow listening on ${url} (${boundHost}, mode ${mode}, badge ${mode === 'ap4m' ? 'LIVE' : 'MOCK'})`);
  })().catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
