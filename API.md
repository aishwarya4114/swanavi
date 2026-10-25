# Swanavi escrow API

Version 3. 2026-10-25.

Protected payments for the trip agent. A booking locks a quoted amount, then either pays the seller or returns that amount. Two modes, same routes, same JSON shapes:

| | `PAYMENTS_MODE=mock` (default) | `PAYMENTS_MODE=ap4m` |
| --- | --- | --- |
| What holds the money | memory | one AP4M payment channel per trip on XRPL EVM Testnet |
| `release` | changes numbers | signs one cumulative voucher and submits `redeemVoucher` (event `VoucherRedeemed`) |
| `refund` of a lock | changes numbers | changes numbers; the cap returns on chain when the trip closes (`PayoutClosed`) |
| Budget meter | memory | read from the chain on every request (cached 4 to 10 s) |
| Badge | `MOCK` | `LIVE` on the header; per booking `LIVE` only with a confirmed transaction, otherwise `LOCAL` |
| Key in this process | none | the agent key, in `ap4m_executor.mjs` only; never logged or sent anywhere |

Use `mock` for rehearsals. Use `ap4m` for the judged run.

## Version 3 response changes

Every change from version 2. Fields not listed are unchanged.

**All four functions are asynchronous.** `release` in `ap4m` mode takes 10 to 20 seconds (one block plus the service record). Clients must tolerate that.

**Removed** (they belonged to the v2 no-network stub, which is gone):

- Booking: `stub`, `execution`, `plannedSdkCalls`.
- Budget: `stub`, `execution`.
- `AP4M_TODOS` export.

**Booking** (`POST /escrows`, `GET /escrows/:id`, list rows, `release`, `refund`, `finish`), new fields:

- `explorerUrl` — string or `null`. Explorer link for `txHash`.
- `claimId` — string or `null`. The ledger's claim id from `VoucherRedeemed`.
- `blockNumber` — number or `null`.
- `cumulativeAmount` — string or `null`. The voucher total signed for this payment (channel redeemed before it plus this bill). Vouchers are cumulative per channel; this is what the chain shows.
- `settlement` — object or `null`: `{ receiptUrl, amountRlusd, payoutTx, payoutTxUrl, settlementTx, settlementTxUrl, settledAt }`. Filled a few seconds after a live release once the service pays the merchant.
- `chainStatus` — `"confirmed"`, `"failed"`, `"missing"`, `"unverified"` or `null`. Set by the live release and re-checked on every restart.
- `live` — boolean. `true` only when `mode` is `ap4m`, `txHash` is set and `chainStatus` is `confirmed`.
- `badge` — `"LIVE"` (as above), `"LOCAL"` (ap4m mode, nothing on chain for this row: locked, refunded, quoted, overcharged) or `"MOCK"`.
- `note` — one plain sentence saying what backs the row.

Changed meaning:

- `txHash` — the `redeemVoucher` transaction in `ap4m`. Still `null` in `mock`.
- `receiptUrl` — same as `settlement.receiptUrl`. Still `null` in `mock`.
- `channelId` — the trip channel in `ap4m` on every booking (also on locked ones, since the lock is a slice of that channel). `null` in `mock`.
- `finalBill` under the lock: **the difference is now freed** and counted in `refundedTotal` (v2 kept the full lock as spent).
- `status` has a new transient value `paying` (voucher submitted, block not yet mined). A client that sees `paying` should poll.
- `reason` has new values: `trip_closed` (lock released by `POST /trip/close` or because the channel was found closed on restart), `redeem_failed` (the chain shows no payment; status went back to `locked`), `redeem_unconfirmed` (two cases: the payment IS on chain but its confirmation is not yet available, status stays `paying`; or a restart found a `paying` row with no transaction on chain, status back to `locked`).

**Auto-resume (3.1).** When the payment call fails, the server re-reads the channel. If `redeemed` rose by exactly this booking's bill, the payment happened and only the confirmation was lost; after one block the server recovers it **without signing anything** (x402: the retained, already-signed header is re-sent and the seller replays its stored outcome; direct voucher: the `VoucherRedeemed` event is read) and answers `200 delivered` with the real `txHash`. If recovery is not possible yet the row stays `paying` and the response is `503 redeem_unconfirmed`. A `release` on a `paying` row retries the confirmation only; it can never produce a second payment. `refund` on `paying` stays `409 invalid_state`.

**Deadlines and repairs (3.1).** A deadline never refunds a booking the chain may have paid: `paying` rows are never expired, and a `locked` row with a retained x402 purchase (`agent-state/<escrowId>/purchase.json`, `complete: false`) is checked against the chain first; if the redemption is there the row becomes `delivered` (non-signing), otherwise the deadline refund proceeds. New booking field `repaired` (`null` normally): when a row that was wrongly `locked`/`redeem_failed` or `refunded`/`deadline` is corrected from chain evidence, it holds `{ from, reason, trigger: "deadline" | "restart", via: "resume" | "VoucherRedeemed", at }`; the wrong refund is undone in the budget totals.

**Budget** (`GET /budget`, and `budget` inside other responses), new fields:

- `version` — number `3`.
- `source` — `"memory"` or `"chain"`.
- `asOf` — ISO time of the chain read behind the numbers.
- `block` — chain block of the fund read, or `null`.
- `trip` — `null` in mock. In ap4m: `{ channelId, status, cap, redeemed, settled, merchantPayout, agent, validBefore, openedTxUrl, closeTxUrl, payoutClosedTxUrl, returned, live: true }`.
- `fund` — `null` in mock. In ap4m, the whole team budget as the chain holds it: `{ deposit, locked, spent, settled, free, refunded, block, asOf, links, live: true }`. `locked` is the cap of open channels, `spent` is paid out, `free` is unassigned deposit, `refunded` is the sum of `PayoutClosed.returned` events for this funding account.
- `drift` — `null` when the local bookings agree with the chain; otherwise `{ chainRedeemed, localDelivered }`.

Changed meaning in ap4m mode:

- `total` is the **trip channel cap** (not the 19 of mock).
- `spent` is the channel's **redeemed total read from the chain**.
- `remaining` is `cap - redeemed - reserved`; `0` after the trip is closed.
- `refundedTotal` is local frees (refund, deadline, bill under lock, trip close) plus the on-chain `returned` once the trip is closed.
- `live` is `true` and `badge` is `"LIVE"` whenever the server runs in `ap4m` mode, because every number in the block comes from a chain read. Per-booking `live` is stricter (needs a transaction).

**Health** — `version` is `3`; `network` is `"xrpl-evm-testnet"` in ap4m, `"disabled"` in mock.

**New routes:**

- `GET /trip` — `{ mode, live, trip, fund, drift }` (the same objects as in the budget).
- `POST /trip/close` — ends the trip. Response `{ live, closeTx, closeTxUrl, payoutClosedTx, payoutClosedTxUrl, returned, freedLocks, channelId, mode, budget }`. In mock everything chain-related is `null` and `live` is `false`.

**New errors**, all JSON `{ error, message, ...details }`:

| code | HTTP | When |
| --- | --- | --- |
| `over_cap` | 409 | `release` would sign a voucher above the channel cap. Nothing is signed. Status stays `locked`. |
| `channel_closed` | 409 | Lock, release or close on a closed trip channel. |
| `redeem_failed` | 502 | The payment transaction failed or was not mined. Status is back to `locked`, `reason` is `redeem_failed`. |
| `close_failed` | 502 | `POST /trip/close` could not close the channel. |
| `in_progress` | 409 | `POST /trip/close` while a payment is still being mined. |
| `live_mode` | 409 | `POST /fund` in ap4m mode. Funding happens on the participant portal. |
| `chain_unavailable` | 503 | The RPC did not answer and there is no cached channel state. |

**Error message change:** `overcharged` message now reads "Release was refused before any signature."

**x402 (3.1, same version number; additive):** with `X402_SELLERS=http://127.0.0.1` the four sellers are real x402 merchants (`x402_sellers.mjs`, ports 4311–4314) and a live `release` buys over x402 instead of signing a voucher directly: it GETs the seller's `/resource`, reads the 402 price, **refuses a price above the lock before anything is signed** (`409 overcharged`, `reason: x402_price_exceeds_lock`, `finalBill` is the asked price), otherwise signs one cumulative voucher in answer to the 402; the seller submits `redeemVoucher` and pays the gas. A price under the lock pays the price and frees the difference. New booking fields: `paidVia` (`"x402"`, `"voucher"` or `null`) and `resource` (the JSON the seller delivered). New error `seller_unavailable` (502): the seller gave no 402; lock unchanged. Without `X402_SELLERS` nothing changes.

**Removed contradiction:** v2 said in one place that `release` ignores the seller switch and in another that it refuses cancelled sellers. The second is true, since v2's last change: `release` returns `409 seller_cancelled` or `seller_failed` and signs nothing.

**`tools.json`** is version 3 and adds `getBudget` (`GET /budget`) and `closeTrip` (`POST /trip/close`).

## Running it

```bash
# mock (rehearsal)
SWANAVI_TOKEN=choose-a-long-token node server.mjs

# live (the agent key is read from the environment by ap4m_executor.mjs; see README.md "Run it live")
SWANAVI_TOKEN=choose-a-long-token PAYMENTS_MODE=ap4m TRIP_CHANNEL_ID=0x... node server.mjs
```

The token is read from the environment. It is not written in this repo. The process refuses to start if `SWANAVI_TOKEN` is unset. In ap4m mode it also refuses to start without the agent key and `TRIP_CHANNEL_ID`. **The server never opens a channel.** The trip channel is opened once, by hand, with the operator script, and its id is passed in.

On start in ap4m mode the server reconciles `bookings.json` with the chain before listening: `paying` rows are looked up by cumulative amount in `VoucherRedeemed` logs (x402 rows also complete their retained purchase by a non-signing resume); `locked` rows with `reason: redeem_failed` and `refunded` rows with `reason: deadline` that still have a retained x402 purchase in `agent-state/<escrowId>/purchase.json` are checked the same way and become `delivered` with `repaired` set if the chain has the redemption; `delivered` rows have their transaction receipt re-checked; a channel found closed on chain releases every lock with `reason: trip_closed`. If `bookings.json` belongs to another channel the server refuses to start.

It listens on `http://127.0.0.1:8787`. Set `PORT` only if you need another port. `HOST` defaults to `127.0.0.1`. `HOST=0.0.0.0` is allowed and prints `WARNING: HOST is open. This API is reachable from other machines.`

`GET /` and `OPTIONS` do not need the token, because a browser navigation cannot send it. Every other route requires header `X-Swanavi-Token`. Responses are JSON except `GET /` and `GET /events`. A browser on another origin can call it (`Access-Control-Allow-Origin: *`, header `X-Swanavi-Token` allowed).

Other environment variables: `PAYMENTS_MODE=ap4m` or `mock` (default `mock`), `MAX_BOOKING_RLUSD` (default `4`), `REAL_SPEND_CEILING` (default `6`), `AP4M_API_URL` (default `https://hackathon.ap4m.build`), `AP4M_RPC_URL` (optional; default is the public RPC from the service config), `TEAM_NAME` (default `Swanavi`), `X402_SELLERS` (ap4m; base URL of the seller process, normally `http://127.0.0.1`; unset means direct vouchers). The ceiling is a local safety limit. It is not approval to spend 6 RLUSD on chain; in ap4m mode the channel cap is the hard limit the chain enforces.

Bookings are stored in `bookings.json` and loaded on start. That file is gitignored.

Amounts are decimal strings with at most 18 places, such as `"0.01"`. The server stores them as 18-decimal integers. Send `"0.40"`, not `0.40`. A JSON number is accepted only when it is a whole RLUSD amount such as `1`.

## Sellers

| sellerId | Name | Quote |
| --- | --- | --- |
| `hotel` | The Plaza Hotel | `4` RLUSD |
| `tour` | Statue of Liberty Ferry | `3` RLUSD |
| `cab` | Yellow Cab, Midtown to Brooklyn | `2` RLUSD |
| `food` | Katz's Delicatessen | `2.5` RLUSD |

Each seller has a switch: `deliver`, `cancel`, or `fail`. New sellers start on `deliver`. The quote is advice; the agent sends the amount it wants to lock (the live rehearsal uses `0.01`).

## States

| status | Meaning |
| --- | --- |
| `quoted` | The price was recorded and the lock was rejected. No RLUSD is reserved. |
| `locked` | The quote is reserved from the budget. In ap4m this is a local slice of the channel cap; nothing is signed. |
| `paying` | ap4m only. The voucher is signed and submitted; waiting for the block. Poll. |
| `delivered` | The seller was paid. In ap4m: `VoucherRedeemed` on chain, `txHash` set. |
| `refunded` | The reserved amount is back in the budget. `reason` is `refund`, `deadline` or `trip_closed`. Nothing was ever signed for this booking. |
| `overcharged` | The final bill was above the lock. Release was refused before any signature. The reservation is back in the budget. |

`GET /budget` and `GET /escrows/:id` apply deadlines. The process also checks deadlines about once a second.

A bill equal to the lock pays the lock. A lower bill pays the bill and frees the difference.

## Budget

Mock: `total` is `19`. `remaining` is what a new lock can use. `reserved` is the sum of `locked` and `paying` escrows. `spent` is the sum of `delivered` bills.

ap4m: `total` is the channel cap; `spent` is the channel's redeemed total on chain; `reserved` is this server's locks; `remaining = cap - spent - reserved`. The `fund` block shows the whole team deposit as the chain holds it.

## Routes

### `GET /health`

```json
{ "ok": true, "mode": "ap4m", "live": true, "badge": "LIVE", "network": "xrpl-evm-testnet", "service": "swanavi-pay", "version": 3 }
```

Mock: `"mode": "mock", "live": false, "badge": "MOCK", "network": "disabled"`.

### `GET /budget`

```bash
curl -s -H "X-Swanavi-Token: $SWANAVI_TOKEN" http://127.0.0.1:8787/budget
```

ap4m example (values from the stray channel used for rehearsal):

```json
{
  "version": 3,
  "currency": "RLUSD",
  "mode": "ap4m",
  "live": true,
  "badge": "LIVE",
  "source": "chain",
  "asOf": "2026-10-25T05:24:30.000Z",
  "block": 9229279,
  "maxBooking": "4",
  "spendCeiling": "6",
  "killed": false,
  "total": "2",
  "remaining": "1.98",
  "reserved": "0",
  "spent": "0.02",
  "refundedTotal": "0",
  "trip": {
    "channelId": "0x14dc20af40d782b2a80ccb4bfa5cdecd6faf6c441c26d63d1fbe0af7980762c0",
    "status": "open",
    "cap": "2",
    "redeemed": "0.02",
    "settled": "0.02",
    "merchantPayout": "0xC46D99FAaE8482F3876f49cAE56B9F09057CE2B8",
    "agent": "0x5492fd1F22C6eFE98F1b9C2237091A6A621ce153",
    "validBefore": "2026-10-31T01:16:15.000Z",
    "openedTxUrl": "https://explorer.testnet.xrplevm.org/tx/0x9acedeed84fbd13cbfeaa4b9537af5975f34fa08c03d36914099402f49c027c2",
    "closeTxUrl": null,
    "payoutClosedTxUrl": null,
    "returned": null,
    "live": true
  },
  "fund": {
    "deposit": "20",
    "locked": "1.98",
    "spent": "1.02",
    "settled": "1.02",
    "free": "17",
    "refunded": "6",
    "block": 9229279,
    "asOf": "2026-10-25T05:24:30.000Z",
    "links": { "ledger": "https://explorer.testnet.xrplevm.org/address/0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91", "vault": "https://explorer.testnet.xrplevm.org/address/0x83DD9cD010eb46e96eceF8F7eB0a18f7845AaBC0" },
    "live": true
  },
  "drift": null
}
```

Mock: `source` is `"memory"`, `total` is `"19"`, `trip`, `fund` and `drift` are `null`, `badge` is `"MOCK"`.

On the default server a lock above `4` is `amount_limit`, and a lock that would push `reserved + spent` above `6` is `spend_ceiling`, before `over_budget` is considered.

### `GET /trip`

`{ mode, live, trip, fund, drift }`. Same objects as inside the budget. In mock all three are `null`.

### `POST /trip/close`

Ends the trip. Every still-`locked` booking becomes `refunded` with `reason: trip_closed`. In ap4m: settles any unpaid redeemed amount, signs the close checkpoint, closes the channel and waits (up to about 90 s) for the vault's `PayoutClosed`, which returns the unused cap to the funding vault. Refused with `in_progress` while a payment is being mined and with `channel_closed` once closed.

```json
{
  "live": true,
  "closeTx": "0x…",
  "closeTxUrl": "https://explorer.testnet.xrplevm.org/tx/0x…",
  "payoutClosedTx": "0x…",
  "payoutClosedTxUrl": "https://explorer.testnet.xrplevm.org/tx/0x…",
  "returned": "1.98",
  "freedLocks": "0",
  "channelId": "0x14dc…62c0",
  "mode": "ap4m",
  "budget": { "...": "full budget object" }
}
```

**Ask the human before calling this.** The channel cannot be reopened; a new trip needs a new channel, and the team has three openings left.

### `GET /merchants`, `GET /merchants/:sellerId`, `POST /merchants/:sellerId/switch`

Unchanged from v2.

```json
{ "sellerId": "cab", "name": "Yellow Cab, Midtown to Brooklyn", "price": "2", "outcome": "deliver", "finalBill": null }
```

`cancel` and `fail` clear any final bill. `finalBill` is allowed only with `deliver`. Unknown seller: `404 seller_not_found`.

### `GET /escrows`

`{ "escrows": [ ... ] }`. Each item has the same shape as `GET /escrows/:id`.

### `POST /escrows`

`createEscrow(sellerId, amount, deadlineSeconds)`. Locks when the amount fits.

```bash
curl -s -H "X-Swanavi-Token: $SWANAVI_TOKEN" -X POST http://127.0.0.1:8787/escrows \
  -H 'Content-Type: application/json' \
  -d '{"sellerId":"hotel","amount":"0.01","deadlineSeconds":3600}'
```

`201` (ap4m):

```json
{
  "escrowId": "escrow_0123456789abcdef",
  "sellerId": "hotel",
  "amount": "0.01",
  "finalBill": null,
  "status": "locked",
  "reason": null,
  "createdAt": "2026-10-25T05:00:00.000Z",
  "updatedAt": "2026-10-25T05:00:00.000Z",
  "deadlineAt": "2026-10-25T06:00:00.000Z",
  "txHash": null,
  "explorerUrl": null,
  "claimId": null,
  "blockNumber": null,
  "cumulativeAmount": null,
  "receiptUrl": null,
  "settlement": null,
  "channelId": "0x14dc20af40d782b2a80ccb4bfa5cdecd6faf6c441c26d63d1fbe0af7980762c0",
  "chainStatus": null,
  "live": false,
  "badge": "LOCAL",
  "note": "reserved inside the trip channel cap (local); the cap itself is on chain",
  "mode": "ap4m"
}
```

Mock: `channelId` is `null`, `badge` is `"MOCK"`.

Refusals keep the row `quoted` and reserve nothing: `409 amount_limit`, `409 spend_ceiling`, `409 over_budget` (`remaining` in details), `409 killed` (no row), `409 channel_closed` (ap4m, no row).

`sellerId` matches `^[a-z][a-z0-9-]{0,31}$`. `deadlineSeconds` is a positive integer.

### `GET /escrows/:escrowId`

Same object as create. Applies the deadline first. Unknown id: `404 not_found`.

### `POST /escrows/:escrowId/release`

Pays the locked amount, or `finalBill` when that is at or under the lock. Order of checks, all **before anything is signed**:

1. status must be `locked` (`409 invalid_state`),
2. the seller switch must not be `cancel` or `fail` (`409 seller_cancelled` / `seller_failed`, lock unchanged),
3. `finalBill` must not exceed the lock (`409 overcharged`, reservation returned, row stays `overcharged`),
4. ap4m: channel must be open (`409 channel_closed`) and `redeemed + bill` must fit the cap (`409 over_cap`).

Then, in ap4m: the row goes to `paying`, one voucher for `cumulativeAmount = redeemed + bill` is signed and submitted, and the response is sent when the block is mined. If the transaction fails and the chain shows no payment: `502 redeem_failed`, row back to `locked`. If the chain shows the payment but the confirmation is missing: auto-resume (see "Version 3 response changes"), else `503 redeem_unconfirmed` with the row left `paying`.

`200` (ap4m):

```json
{
  "escrowId": "escrow_0123456789abcdef",
  "sellerId": "hotel",
  "amount": "0.01",
  "finalBill": "0.01",
  "status": "delivered",
  "reason": null,
  "createdAt": "2026-10-25T05:00:00.000Z",
  "updatedAt": "2026-10-25T05:00:15.000Z",
  "deadlineAt": "2026-10-25T06:00:00.000Z",
  "txHash": "0x9412d2efedde43466ce74ebb7c2471cef8f10cdc9c1ea971aab662d31f0db18c",
  "explorerUrl": "https://explorer.testnet.xrplevm.org/tx/0x9412d2efedde43466ce74ebb7c2471cef8f10cdc9c1ea971aab662d31f0db18c",
  "claimId": "0xe82c7bef5c7a2071320f444762182a3e81ba68d19ae3ce1fe32c56149e518a34",
  "blockNumber": 9229171,
  "cumulativeAmount": "0.01",
  "receiptUrl": null,
  "settlement": null,
  "channelId": "0x14dc20af40d782b2a80ccb4bfa5cdecd6faf6c441c26d63d1fbe0af7980762c0",
  "chainStatus": "confirmed",
  "live": true,
  "badge": "LIVE",
  "note": "VoucherRedeemed on chain",
  "mode": "ap4m"
}
```

A few seconds later `GET` the same id: `receiptUrl` and `settlement` are filled (`payoutTxUrl` is the `ClaimPaid` transaction, `settlementTxUrl` the `SettlementRecorded` one). The server retries settlement in the background for about two minutes; after that, restarting the server retries again.

The transaction and claim shown above are the real 0.01 redemption on the rehearsal channel; the amounts are what the chain holds.

Overcharge: `409`

```json
{
  "error": "overcharged",
  "message": "Final bill exceeds the locked amount. Release was refused before any signature. The reservation returned to the budget.",
  "escrowId": "escrow_0123456789abcdef",
  "status": "overcharged",
  "amount": "0.25",
  "finalBill": "0.5"
}
```

Over cap (ap4m): `409 { "error": "over_cap", "status": "locked", "cap": "2", "redeemed": "1.995" }`. Nothing was signed; the lock stays.

### `POST /escrows/:escrowId/refund`

Returns a `locked` reservation to the budget. `200` with `"status": "refunded"`, `"reason": "refund"`, `txHash: null`, `live: false`. Calling it again returns the same state. Refund of `quoted` marks it `refunded` and moves no funds. Refund of `delivered`, `paying` or `overcharged` is `409 invalid_state`.

In ap4m the freed amount is back inside the channel cap at once (`remaining` rises). It goes back to the funding vault on chain when the trip is closed. There is no per-booking on-chain refund transaction: the ledger has no function for it, and nothing was signed for the booking in the first place.

### `POST /escrows/:escrowId/finish`

Reads the seller switch: `cancel` and `fail` call `refund`; `deliver` calls `release`, with the switch's `finalBill` when set. Same responses as those routes.

## Errors

| HTTP | `error` | When |
| --- | --- | --- |
| 400 | `bad_request` | Missing or invalid `sellerId`, `deadlineSeconds`, `outcome`, or JSON |
| 400 | `bad_amount` | Amount is not a positive decimal string |
| 401 | `unauthorized` | Missing or wrong `X-Swanavi-Token` |
| 404 | `not_found` | Unknown escrow or route |
| 404 | `seller_not_found` | Unknown seller |
| 409 | `over_budget` | Lock is above `remaining` |
| 409 | `amount_limit` | Lock above `maxBooking` |
| 409 | `spend_ceiling` | Lock would put `reserved + spent` above `spendCeiling` |
| 409 | `killed` | Kill switch is on |
| 409 | `overcharged` | Final bill is above the locked amount |
| 409 | `over_cap` | ap4m: voucher would exceed the channel cap |
| 409 | `invalid_state` | Release or refund does not apply to the current status |
| 409 | `seller_cancelled` / `seller_failed` | `release` while the seller switch is `cancel` / `fail` |
| 409 | `channel_closed` | ap4m: trip channel is closed |
| 409 | `in_progress` | `trip/close` while a payment is being mined |
| 409 | `live_mode` | `fund` in ap4m mode |
| 502 | `redeem_failed` | ap4m: payment call failed and the chain shows no payment; lock unchanged |
| 503 | `redeem_unconfirmed` | ap4m: payment is on chain, confirmation not yet available; row stays `paying`; `release` again retries the confirmation only |
| 502 | `seller_unavailable` | ap4m x402: the seller returned no 402; lock unchanged |
| 502 | `close_failed` | ap4m: close failed |
| 503 | `chain_unavailable` | ap4m: RPC down and nothing cached |

Every error body has `error` and `message`. Escrow errors also include `escrowId` and `status` when one exists.

## What the agent should do

1. `GET /merchants` and choose a quote.
2. `POST /escrows` with that `sellerId`, the amount to lock, and a `deadlineSeconds`.
3. Wait for the seller outcome.
4. `POST /escrows/:id/finish` (or `release` / `refund` directly).
5. On `refunded` or `overcharged`, book someone else. The reserved RLUSD is already back in `remaining`.
6. On `delivered`, keep `txHash` / `explorerUrl`; poll `GET /escrows/:id` until `receiptUrl` is set.
7. `GET /budget` for the meter. Treat `drift` not `null` as a stop signal.
8. Do not call `POST /trip/close` without a human saying so.

## What the dashboard shows

`GET /` is the one-file dashboard. It asks for the token and keeps it in `sessionStorage` only. It then reads `/budget`, `/escrows`, and `/events` with the header.

- Header badge `LIVE` (ap4m) or `MOCK`, `NEW LOCKS STOPPED` when `killed`.
- Meters: Locked (`reserved`), Spent, Refunded (`refundedTotal`), Remaining, with a line saying whether they came from memory or from the chain and at which block.
- Trip box (ap4m only): channel id, status, cap, redeemed, settled, the merchant payout wallet, the team fund numbers, explorer links for the open and close transactions, and a `DRIFT` warning when local and chain disagree.
- One row per booking. The Chain column shows a `LIVE` tag with the `VoucherRedeemed` link only when the row has `live: true`; otherwise `LOCAL` (ap4m, nothing on chain for this row) or `MOCK`, with the row's `note`. The Receipt column links the receipt and the payout transaction once settled.
- A request log from the event stream.

## `POST /fund`

Mock only. Credits the local budget. `crypto` and `card` are simulated (`simulated: true`, `label: "SIMULATED"`); `rlusd` is a local ledger credit (`simulated: false`, `label: "local ledger credit"`). `onChain` is `false` for all three. Response `{ method, amount, simulated, label, onChain, mode, budget }`. In ap4m: `409 live_mode`.

## `POST /kill-switch`

`{ "enabled": true }` stops new locks. Refund, release and close of existing bookings still work. Response `{ killed, mode }`.

## `GET /events`

Server-Sent Events. First event `hello` with `{ type, budget, bookings, log }`. Later events: `booking` (`booking` and `budget`), `budget`, `kill`, `trip` (`trip` and `budget`), `log`. A comment line `: ping` every 15 seconds. `GET /log` returns the same in-memory request list.

## `GET /`

HTML shell for the dashboard. No token. No budget figures in the file.

## Tests

```bash
npm test
```

Runs every file in `test/`. The ap4m path is tested against a fake executor that behaves like the chain (cap, cumulative redeem, settle, close, find-by-amount, verify) without any network; the real executor's transaction guard is tested with real signed transactions offline.

## Operator scripts

These are not HTTP routes. Do not point the Python agent or the UI at them. They live in `scripts/` and are run from the folder root (`node scripts/<name>.mjs`); see README.md for the commands and what each one costs.

- `scripts/live_channel_open_close.mjs` — opens and closes a channel (cap 2). Opens a channel: budgeted; do not run casually.
- `scripts/live_over_cap.mjs` — the over-cap proof (simulate first, broadcast only if the simulation reverted). Result: README.md "Real vs simulated".
- `scripts/live_trip.mjs` — pays 0.01 then 0.01 (cumulative 0.02) on a fixed channel, settles, and with `KEEP_OPEN=1` leaves it open.
- `x402_sellers.mjs` — the four sellers as x402 merchants (needs a submitter key with gas, `MERCHANT_ID`, `MERCHANT_PAYOUT`).
- `scripts/live_x402_test.mjs` — x402 rehearsal: reads every 402, buys hotel and cab at 0.01, is refused by an over-priced tour before signing, records and settles. Max 0.02 per run.
- `scripts/close_channel.mjs` — settles and closes a channel, waits for `PayoutClosed`.
- `scripts/live_merchant_channel.mjs` — opens a channel to the team's own merchant wallet, pays 0.01, prints the wallet balance before and after, leaves it open (`CONFIRM_OPEN=yes` required).
- `scripts/merchant_status.mjs`, `scripts/register_merchant.mjs` — merchant wallet balances and registration (sign-in / one signed message, no transaction).
- `scripts/chain_inspect.mjs` — read-only chain state and event history.
