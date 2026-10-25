# NYC demo ticket agent handoff

The booking agent is a separate Gateway client. This repository does not invoke it. The attractions page can quote, confirm, cancel, and refresh a demo order. It never calls `purchase_ticket`. Agent invocation remains the teammate's integration and was not acceptance-tested here.

Register and call the ticket tools in this order.

1. Register `/tickets/mcp` as a second Gateway target, using the same pattern as `AWS_SETUP.md` section 2a. Do not put the approval token in the gateway.
2. Call `list_ticket_offers`, then `get_ticket_slots`, then `quote_ticket`. Read the returned amount, currency, slot, and expiry. Do not substitute a client amount.
3. Stop before `purchase_ticket`. Return the quote to the traveler for confirmation.
4. On the continuation, call `purchase_ticket` with a stable idempotency key and the Gateway tool name discovered for this target, including any Gateway prefix. Do not hard-code a prefix.
5. If the order is `payment_pending` or `ticket_pending`, poll `get_ticket_order` with bounded backoff. Do not buy a second ticket. If it stays pending, report the order id.
6. Return the ticket and receipt only when the order status is `issued`.

Every issued ticket carries the label `Demo ticket — not valid for admission`. `delivered` on an escrow means the payment completed. It does not mean the traveler attended.

The sandbox rehearsal in `scripts/ticket_rehearsal.mjs` was not run against an operator channel. No testnet funds were spent.
