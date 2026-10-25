const STATUS = {
  invalid_request: 400,
  unauthorized: 401,
  policy_denied: 403,
  approval_required: 403,
  not_found: 404,
  not_available: 409,
  quote_expired: 409,
  price_changed: 409,
  idempotency_conflict: 409,
  cannot_cancel: 409,
  supplier_unavailable: 502,
};

export class TicketError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'TicketError';
    this.code = code;
    this.status = STATUS[code] ?? 500;
    this.orderId = extra.orderId ?? null;
  }
}

export function rejectUnknown(input, allowed) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TicketError('invalid_request', 'Input must be an object.');
  }
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) {
      throw new TicketError('invalid_request', `Unknown field ${key}.`);
    }
  }
}
