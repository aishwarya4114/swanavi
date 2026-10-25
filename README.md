# Swanavi protected payments on Mastercard AP4M (XRPL EVM testnet)

A payment layer for an AI trip-planning agent, built on Mastercard's AP4M agent-payment rails over the XRPL EVM
testnet. The agent locks the quoted price for each booking, pays only when the booking is delivered, never signs
anything for a cancelled booking, refuses a bill above the quote before any signature, and lives inside limits that
are enforced in code and, for the channel cap, by the ledger contract itself. It runs the same API in a mock mode
(no network, no keys) and in a live mode (real RLUSD vouchers on testnet).

This is one of two payment rails in the team repo. `docs/SPEC.md` there describes a Python, XRPL-native design;
this folder is a second, independent rail (Node.js, AP4M payment channels) that exposes the same tool names.

## Real vs simulated

| | Status | Evidence |
|---|---|---|
| Voucher redemption on chain (`VoucherRedeemed` on the PaymentLedger) | **REAL** | e.g. `0xfbdba026d69d6dfbc474e7aab7e26b2f7e4fbce2e77d96775ac3a147b024c668` (0.01 RLUSD, 25 Oct 2026) |
| Settlement and payout to the merchant wallet (`ClaimPaid`, `SettlementRecorded`), receipts | **REAL** | merchant wallet `0x4581492018e07F81F055D15BC7EBab4957A1Ce0C` went 0.0 → 0.01 RLUSD on the first paid booking; receipts are published by the AP4M service |
| Channel cap enforced by the ledger | **REAL** | a voucher for cap + 1 wei reverted on chain: `0xd12c1d9beccbafff09216e2fa65ea1353e8ada42fdf3588fd964850a98f8100a` |
| Budget meter read from chain (cap, redeemed, settled, returned) | **REAL** | `GET /budget` in live mode reads the ledger and the vault; nothing is estimated |
| x402: agent reads a 402, decides, signs, seller submits | **REAL** | run live twice; an over-priced 402 was refused before signing |
| Unused cap returned at trip close (`PayoutClosed`) | **REAL** | `POST /trip/close` waits for the vault event and reports `returned` |
| Card or dollar funding of the budget | **SIMULATED** | the testnet budget is funded by the hackathon organisers; `POST /fund` only works in mock mode |
| Crypto conversion, fiat rails | **SIMULATED** | none exists here |
| The "card-tap overcharge" idea | **SIMULATED** | this code refuses an over-quote **bill** before signing; it does not and cannot fix a card terminal charging more |
| Mock mode money | **MOCK** | numbers in memory, no chain |
| Hardware wallet approval, private RPC, mainnet | **FUTURE** | not built; `AP4M_RPC_URL` accepts any RPC URL today |

We do not claim to be first at anything. The novelty is the combination: delivery protection (lock, pay on delivery,
refuse over-quote, cancel costs nothing) on AP4M rails, plus an agent that recovers from a lost confirmation within
its budget instead of paying twice or giving up.

## Architecture

- **One payment channel per trip.** The channel has a cap (the trip budget) and a cumulative redeemed total. Each
  paid booking signs one EIP-712 voucher for `redeemed + bill`; vouchers are cumulative, not per payment. The server
  never opens a channel; an operator does (scripts in `scripts/`) and hands the server `TRIP_CHANNEL_ID`.
- **One merchant payout wallet** per team, registered with the AP4M service. Every channel the team opens pays it.
- **Refund model.** A cancelled or expired booking was never signed, so nothing moves: the lock is a number in the
  server. A bill under the lock pays the bill and frees the rest. At trip close the unused cap goes back to the funding
  vault on chain (`PayoutClosed`, with the returned amount). There is no per-claim refund function anywhere in the
  ledger; a paid voucher is final, which is why payment happens only on delivery.
- **x402.** With `X402_SELLERS` set, the four demo sellers are real x402 merchants (`x402_sellers.mjs`, ports
  4311–4314). `release` fetches the seller's resource, reads the 402 price, refuses a price above the lock before any
  signature, otherwise signs one voucher in answer to the 402; the seller submits the redemption and pays the gas.

Files: `payments.mjs` (state machine, budget, repairs), `server.mjs` (HTTP), `merchants.mjs` (demo sellers),
`ap4m_executor.mjs` (the only file that touches the key, the SDK and the chain, including the transaction guard),
`x402_sellers.mjs`, `dashboard.html`, `tools.json` (the agent's tool definitions), `API.md` (every route and field).

## Known limitation, and what the code does about it

The seller's post-broadcast check can fail once right after the redemption is mined and return HTTP 503
"purchase outcome unavailable". We saw it twice in live runs under public-RPC lag: the payment was on chain both
times, only the confirmation to the agent was lost.

- **Auto-resume.** On a failed payment call the server re-reads the channel. If `redeemed` rose by exactly this
  booking's bill, the payment happened; after one block the server replays the retained, already-signed x402 header
  (the seller returns its stored outcome) or reads the `VoucherRedeemed` event. Nothing is signed a second time. If
  that still fails the booking stays `paying` and the API answers `503 redeem_unconfirmed`; a later `release` only
  retries the confirmation.
- **Deadline repair.** The first version refunded a booking by deadline while its payment was on chain (the real
  food booking `escrow_dd3b899974d748c8`, tx above). Now a deadline never refunds a booking that has a retained
  purchase without checking the chain first, `paying` bookings never expire, and on restart the server repairs
  `locked`/`redeem_failed` and `refunded`/`deadline` rows the chain shows as paid. Such a row carries
  `repaired: { from, reason, trigger, via, at }`.
- 53 offline tests cover these paths with a fake executor (see Testing).

A private RPC (`AP4M_RPC_URL`, set for both the server and the sellers) makes the race rarer; it does not remove it.

## Run it in mock mode (no keys, no network)

```bash
npm install
npm test
SWANAVI_TOKEN=choose-a-long-token node server.mjs
```

Then open `http://127.0.0.1:8787/` for the dashboard and, with `T` set to the token:

```bash
curl -s -H "X-Swanavi-Token: $T" -X POST localhost:8787/escrows -H 'Content-Type: application/json' \
  -d '{"sellerId":"hotel","amount":"0.40","deadlineSeconds":600}'
curl -s -H "X-Swanavi-Token: $T" -X POST localhost:8787/escrows/<escrowId>/release -H 'Content-Type: application/json' -d '{}'
curl -s -H "X-Swanavi-Token: $T" localhost:8787/budget
```

## Run it live (testnet)

Keys come from environment variables only. This README names the variables; it never shows values, and no file in
this folder may contain one (`sh scripts/check-secrets.sh` checks).

1. Download the hackathon helper files from the AP4M portal into this folder: `ap4m-hackathon-sdk.js` and
   `ap4m-x402.mjs` (from `<AP4M_API_URL>/sdk/`). They are hackathon-only and git-ignored here. `npm install` also
   fetches the `@ap4m/sdk` package from the same service.
2. Have the AP4M team onboarded (agent wallet, merchant wallet, funded budget) in the participant portal.
3. Open a trip channel with an operator script (uses a budgeted channel opening), e.g.
   `AGENT_PRIVATE_KEY=… CONFIRM_OPEN=yes node scripts/live_merchant_channel.mjs`, and note the printed
   `TRIP_CHANNEL_ID`.
4. Start the sellers (terminal A) and the server (terminal B):

```bash
# A: sellers as x402 merchants (the submitter wallet pays gas)
MERCHANT_SUBMITTER_KEY=… MERCHANT_ID=… MERCHANT_PAYOUT=… node x402_sellers.mjs
# B: the server, live, on the open channel
SWANAVI_TOKEN=… PAYMENTS_MODE=ap4m TRIP_CHANNEL_ID=… AGENT_PRIVATE_KEY=… X402_SELLERS=http://127.0.0.1 \
  REAL_SPEND_CEILING=0.05 node server.mjs
```

Server variables: `SWANAVI_TOKEN` (required), `PAYMENTS_MODE` (`mock` default, `ap4m` live), `TRIP_CHANNEL_ID`,
`AGENT_PRIVATE_KEY`, `AP4M_API_URL`, `AP4M_RPC_URL`, `TEAM_NAME`, `X402_SELLERS`, `REAL_SPEND_CEILING`,
`MAX_BOOKING_RLUSD`, `PORT`, `HOST`. Seller variables: `MERCHANT_SUBMITTER_KEY`, `MERCHANT_ID`, `MERCHANT_PAYOUT`,
`PRICE_<SELLER>` (default 0.01), `X402_SELLERS_HOST`, `STATE_DIRECTORY`, `ALLOW_NO_GAS`, `AP4M_API_URL`,
`AP4M_RPC_URL`. Without `X402_SELLERS` the server signs vouchers directly instead of buying over x402.

Operator scripts (`scripts/`, run from this folder): `merchant_status.mjs` and `chain_inspect.mjs` are read-only;
`register_merchant.mjs` signs one message, no transaction; `live_*.mjs` and `close_channel.mjs` send transactions and
some open a channel (`live_channel_open_close.mjs`, `live_merchant_channel.mjs`). Each file's header says what it
costs and what it refuses to do.

## Integration

The agent calls the HTTP server; `tools.json` defines the tools in the agent's format: `createEscrow`, `release`,
`refund`, `getStatus`, `getBudget`, `closeTrip`, `fund` (`fund` is mock only; live mode answers `409 live_mode`).

Routes (all need header `X-Swanavi-Token`): `POST /escrows`, `GET /escrows`, `GET /escrows/:id`,
`POST /escrows/:id/release`, `POST /escrows/:id/refund`, `POST /escrows/:id/finish`, `GET /budget`, `GET /trip`,
`POST /trip/close`, `GET /merchants`, `GET /merchants/:id`, `POST /merchants/:id/switch`, `POST /fund`,
`POST /kill-switch`, `GET /events` (server-sent events for a live meter), `GET /log`, `GET /health`, `GET /`
(dashboard). Every field, state and error code is in [`API.md`](API.md). The UI's budget meter is `GET /budget`
(`total`, `remaining`, `reserved`, `spent`, `refundedTotal`, plus `trip` and `fund` read from chain in live mode);
each delivered booking has `txHash`, `explorerUrl` and, once settled, `receiptUrl`.

The team repo's `docs/SPEC.md` describes a different, Python, XRPL-native payment design. This folder does not
implement that spec; it is a second rail with the same tool names so the agent can use either.

## Safety design

- **Transaction guard** (`ap4m_executor.mjs`): every outgoing transaction is decoded before it is sent and must be
  `redeemVoucher` on the known ledger address, for the configured channel, with no value, and for exactly the
  cumulative amount the server armed. Anything else is refused.
- **`REAL_SPEND_CEILING`**: the server refuses a lock that would take reserved + spent above it.
- **Per-booking maximum** (`MAX_BOOKING_RLUSD`): one booking cannot exceed it.
- **Kill switch** (`POST /kill-switch`): refuses every new lock until turned off (bookings already locked can
  still be released or refunded, so a trip in flight can finish cleanly).
- **The server never opens or funds a channel**; the channel cap is the hard limit the ledger enforces.
- Keys are read from the environment only and never logged; the service only ever receives signatures.

## Testing

```bash
npm test
```

`test/escrow.test.mjs` runs the whole state machine, the HTTP server and the budget in mock mode and in live mode
against a **fake executor** (an in-memory chain with cap, cumulative redeem, settle, close, event lookup, retained
purchases and a non-signing resume), including the lost-outcome, deadline and restart-repair cases, plus static
checks that the live scripts never name a key file. `test/channel-scripts.test.mjs` checks the operator scripts the
same way. `test/trip-guard.test.mjs` tests the outgoing-transaction guard with real signed transactions, offline; it
needs `ap4m-hackathon-sdk.js` and skips cleanly when that file is not downloaded. Expected: 52 tests, 8 skipped
without the helper file, 0 failures.
