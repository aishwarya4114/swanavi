import { TicketError } from './errors.mjs';

const PROTOCOL = '2025-06-18';

const TOOLS = [
  {
    name: 'list_ticket_offers',
    description: 'List demo admission offers in New York. Every offer is a demo ticket and is not valid for admission. indoor is optional.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['city'],
      properties: {
        city: { type: 'string', const: 'New York' },
        indoor: { type: 'boolean' },
      },
    },
  },
  {
    name: 'get_ticket_slots',
    description: 'List 10:00 and 14:00 America/New_York slots for one demo attraction on one local date.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['attractionId', 'date'],
      properties: {
        attractionId: { type: 'string' },
        date: { type: 'string' },
      },
    },
  },
  {
    name: 'quote_ticket',
    description: 'Hold one seat for 120 seconds and return a fixed quote. This does not approve, sign, or pay. quantity must be 1.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['attractionId', 'sku', 'slotId', 'quantity'],
      properties: {
        attractionId: { type: 'string' },
        sku: { type: 'string' },
        slotId: { type: 'string' },
        quantity: { type: 'integer', const: 1 },
      },
    },
  },
  {
    name: 'purchase_ticket',
    description: 'Buy a quote the traveler already confirmed in the app. Retries with the same idempotencyKey resume the same order. A pending order is not an issued ticket.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['quoteId', 'idempotencyKey'],
      properties: {
        quoteId: { type: 'string' },
        idempotencyKey: { type: 'string', minLength: 1, maxLength: 128 },
      },
    },
  },
  {
    name: 'get_ticket_order',
    description: 'Read one ticket order. This can finish an already paid ticket. It does not start a payment.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['orderId'],
      properties: { orderId: { type: 'string' } },
    },
  },
  {
    name: 'cancel_ticket_hold',
    description: 'Cancel an unpaid quote and return its seat. Paid, pending, and issued orders cannot be cancelled.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['orderId'],
      properties: { orderId: { type: 'string' } },
    },
  },
];

export async function handleTicketMcp(body, tickets) {
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
      serverInfo: { name: 'swanavi-tickets', version: '1.0.0' },
    });
  }
  if (method === 'ping') return ok(id, {});
  if (method === 'tools/list') return ok(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    try {
      const data = await callTool(tickets, name, args);
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredContent: data,
        isError: false,
      });
    } catch (error) {
      const payload = errorPayload(error);
      return ok(id, {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, `Unknown method ${method ?? ''}.`);
}

async function callTool(tickets, name, args) {
  if (name === 'list_ticket_offers') return tickets.listOffers(args);
  if (name === 'get_ticket_slots') return tickets.getSlots(args);
  if (name === 'quote_ticket') return tickets.quote(args);
  if (name === 'purchase_ticket') return tickets.purchase(args);
  if (name === 'get_ticket_order') return tickets.getOrder(args);
  if (name === 'cancel_ticket_hold') return tickets.cancel(args);
  throw new TicketError('invalid_request', `Unknown tool ${name ?? ''}.`);
}

function errorPayload(error) {
  const payload = {
    error: {
      code: error instanceof TicketError ? error.code : 'invalid_request',
      message: error instanceof Error ? error.message : 'Request failed.',
    },
  };
  if (error instanceof TicketError && error.orderId) payload.orderId = error.orderId;
  return payload;
}

function ok(id, result) {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id, code, message) {
  return { status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

export { TOOLS };
