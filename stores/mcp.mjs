/**
 * Stateless MCP (JSON-RPC) for the demo stores.
 * Directory: POST /mcp
 * One store: POST /m/{storeId}/mcp
 */

import { findStores, getQuote, publicStore, searchCatalog, STORES, storeById } from './catalog.mjs';

// Structured tool results were introduced in this protocol revision.
const PROTOCOL = '2025-06-18';

const DIRECTORY_TOOLS = [
  {
    name: 'list_stores',
    description: 'Find demo stores in New York. city accepts New York, New York City, NYC, or Manhattan. Omit city to list every store. near is {lat, lng}. radiusKm is kilometres. There are no restaurants.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        city: { type: 'string' },
        category: { type: 'string', enum: ['activity', 'shopping'] },
        near: {
          type: 'object',
          additionalProperties: false,
          properties: { lat: { type: 'number' }, lng: { type: 'number' } },
          required: ['lat', 'lng'],
        },
        radiusKm: { type: 'number' },
      },
    },
  },
  {
    name: 'search_catalog',
    description: 'List bookable items for one storeId. query matches sku, title, or description. Nothing is charged.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['storeId'],
      properties: {
        storeId: { type: 'string' },
        query: { type: 'string' },
      },
    },
  },
  {
    name: 'get_quote',
    description: 'Read a demo quote for a store SKU. No money moves. Pass sellerId, sku and amount to createEscrow; release pays for this SKU over x402 when live.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['storeId', 'sku'],
      properties: {
        storeId: { type: 'string' },
        sku: { type: 'string' },
      },
    },
  },
];

function storeTools(item) {
  const note = item.note;
  return [
    {
      name: 'search_catalog',
      description: `List bookable items at ${item.name}. Nothing is charged. ${note}`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { query: { type: 'string' } },
      },
    },
    {
      name: 'get_quote',
      description: `Quote one SKU at ${item.name}. No money moves. Pass sellerId, sku and amount to createEscrow. ${note}`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['sku'],
        properties: { sku: { type: 'string' } },
      },
    },
    {
      name: 'store_info',
      description: `Profile for ${item.name}. ${note}`,
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    },
  ];
}

export function handleStoreMcp(body, storeId = null) {
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
      serverInfo: { name: storeId ? `swanavi-${storeId}` : 'swanavi-stores', version: '1.0.0' },
    });
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') {
    try {
      const tools = storeId ? storeTools(storeById(storeId)) : DIRECTORY_TOOLS;
      return ok(id, { tools });
    } catch (error) {
      return rpcError(id, -32004, error.message);
    }
  }
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      const data = storeId ? callStore(storeId, name, args) : callDirectory(name, args);
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
        isError: false,
      });
    } catch (error) {
      return ok(id, {
        content: [{ type: 'text', text: error.message }],
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, `Unknown method ${method ?? ''}.`);
}

function callDirectory(name, args) {
  if (name === 'list_stores') {
    return { stores: findStores({
      city: args.city,
      category: args.category,
      near: args.near,
      radiusKm: args.radiusKm,
    }) };
  }
  if (name === 'search_catalog') return { items: searchCatalog(args.storeId, { query: args.query }) };
  if (name === 'get_quote') return getQuote(args.storeId, args.sku);
  throw new Error(`Unknown tool ${name}.`);
}

function callStore(storeId, name, args) {
  if (name === 'search_catalog') return { items: searchCatalog(storeId, { query: args.query }) };
  if (name === 'get_quote') return getQuote(storeId, args.sku);
  if (name === 'store_info') return publicStore(storeById(storeId));
  throw new Error(`Unknown tool ${name}.`);
}

function ok(id, result) {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id, code, message) {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

export { STORES };
