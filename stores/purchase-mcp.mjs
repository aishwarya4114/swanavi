/**
 * Stateless MCP (JSON-RPC) adapter for demo shop purchases: POST /stores/purchases/mcp.
 * Approval is deliberately absent: only the trusted host can approve, over HTTP, with its own token.
 */

import { ShopError } from './purchases.mjs';

const PROTOCOL = '2025-06-18';

const byId = {
  type: 'object',
  additionalProperties: false,
  required: ['purchaseId'],
  properties: { purchaseId: { type: 'string', minLength: 1 } },
};

const TOOLS = [
  {
    name: 'prepare_store_purchase',
    description: 'Prepare one demo shop item for the user to approve in the host app. Reads the trusted catalog price; maximumAmount is the user\'s upper bound, not a price. Signs nothing and reserves nothing. Expires in 120 seconds. Reuse the same idempotencyKey only to retry this same preparation.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['storeId', 'sku', 'maximumAmount', 'idempotencyKey'],
      properties: {
        storeId: { type: 'string', minLength: 1 },
        sku: { type: 'string', minLength: 1 },
        maximumAmount: { type: 'string', pattern: '^(0|[1-9][0-9]*)(\\.[0-9]{1,18})?$' },
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
  },
  {
    name: 'purchase_store_item',
    description: 'Pay for a prepared purchase the user approved in the host app, over x402 when live. A result with status paying is pending: poll get_store_purchase, do not prepare or pay again. Retrying with the same purchaseId never pays twice.',
    inputSchema: byId,
  },
  {
    name: 'get_store_purchase',
    description: 'Read one shop purchase, its transaction evidence and settlement receipt. May confirm an already signed payment; never starts one.',
    inputSchema: byId,
  },
  {
    name: 'cancel_store_purchase',
    description: 'Cancel a purchase that has not been paid. Paid or possibly paid purchases cannot be cancelled.',
    inputSchema: byId,
  },
];

export async function handlePurchaseMcp(body, purchases) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, -32600, 'JSON-RPC body must be an object.');
  }
  const { id, method, params } = body;
  if (method === 'notifications/initialized') return { status: 202, body: null };
  if (id === undefined || id === null) return rpcError(null, -32600, 'Request id is required.');
  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'swanavi-store-purchases', version: '1.0.0' },
    });
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const data = await callTool(purchases, params?.name, params?.arguments ?? {});
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });
    } catch (error) {
      const payload = {
        error: {
          code: error instanceof ShopError ? error.code : 'invalid_request',
          message: error instanceof Error ? error.message : 'Request failed.',
        },
        purchase: error instanceof ShopError ? error.purchase : null,
      };
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true });
    }
  }
  return rpcError(id, -32601, `Unknown method ${method ?? ''}.`);
}

function callTool(purchases, name, args) {
  if (name === 'prepare_store_purchase') return purchases.prepare(args);
  if (name === 'purchase_store_item') return purchases.pay(args);
  if (name === 'get_store_purchase') return purchases.get(args);
  if (name === 'cancel_store_purchase') return purchases.cancel(args);
  throw new ShopError('invalid_request', `Unknown tool ${name ?? ''}.`);
}

function ok(id, result) {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id, code, message) {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

export { TOOLS };
