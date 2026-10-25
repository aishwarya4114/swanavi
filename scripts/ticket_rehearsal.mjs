/**
 * Prints the NYC demo ticket sandbox steps and then stops.
 * It does not sign, lock, or send a payment. Spending stays on the operator
 * machine, with that machine's channel and keys, after a traveler confirms a
 * quote in the Swanavi page.
 */
const steps = [
  '1. Run the Swanavi server in x402 mode with the operator channel and the four legacy sellers on ports 4311-4314. The demo ticket sellers listen on 4341, 4342, and 4343.',
  '2. Set SWANAVI_TOKEN and a separate TICKET_APPROVAL_TOKEN. Give the gateway only SWANAVI_TOKEN. See AWS_SETUP.md section 2a.',
  '3. Register POST /tickets/mcp as a second Gateway target. Do not register POST /tickets/approvals.',
  '4. Open the attractions page, review one demo quote, and confirm it there. The page calls the approval route. The agent does not.',
  '5. Continue the agent with purchase_ticket, a stable idempotency key, and the tool name discovered for this target.',
  '6. If the order stays payment_pending or ticket_pending, poll get_ticket_order. Do not buy a second ticket.',
  '7. Show the ticket and receipt only when the order status is issued. The label is "Demo ticket — not valid for admission".',
];

console.log(steps.join('\n'));
console.error('Refusing to spend. The operator channel and keys are not used by this script, so this is not a sandbox pass.');
process.exit(2);
