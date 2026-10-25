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
import { API_VERSION, PaymentError, createPayments } from './payments.mjs';

const DEFAULT_PORT = 8787;
const BODY_LIMIT = 32_768;
const here = dirname(fileURLToPath(import.meta.url));
const dashboardHtml = readFileSync(join(here, 'dashboard.html'));

export function createHandler({ payments, merchants, token }) {
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
  payments.setSellerResource((sellerId) => {
    try { return merchants.get(sellerId).resourceUrl ?? null; } catch { return null; }
  });
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
      await route(req.method ?? 'GET', parts, body, req, res, payments, merchants, clients, requestLog);
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
  const server = createServer(createHandler({ payments: pay, merchants: shops, token: expected }));
  const timer = setInterval(() => pay.sweep(), 1000);
  timer.unref();
  server.on('close', () => { clearInterval(timer); pay.stop?.(); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolve({ server, host, port: bound, url: `http://${host}:${bound}`, payments: pay, merchants: shops, reconciled });
    });
  });
}

async function route(method, parts, body, req, res, payments, merchants, clients, requestLog) {
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
    const escrowId = await payments.createEscrow(body.sellerId, body.amount, body.deadlineSeconds);
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
