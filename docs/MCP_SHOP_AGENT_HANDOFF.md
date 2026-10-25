# Demo shop purchase agent handoff

This is for whoever runs the Swanavi agent on AgentCore (or any MCP client). The
agent can now buy one item from a fictional NYC demo shop. It discovers shops on
the discovery target, prepares a purchase on the purchase target, waits for the
user's approval in the host app, then pays. Payment uses the existing AP4M x402
path on XRPL EVM testnet with testnet RLUSD. No real goods, admission or card
charge exist.

## Two Gateway targets

| Target | Endpoint | Tools |
| --- | --- | --- |
| discovery | `$SWANAVI_BASE_URL/mcp` | `list_stores`, `search_catalog`, `get_quote` |
| purchase | `$SWANAVI_BASE_URL/stores/purchases/mcp` | `prepare_store_purchase`, `purchase_store_item`, `get_store_purchase`, `cancel_store_purchase` |

Both take the outbound header `X-Swanavi-Token` from the Gateway credential
provider. Neither gets `STORE_APPROVAL_TOKEN`. Gateway may prefix tool names.
Read the names from `tools/list` and call those.

There is no approval tool. `POST /stores/purchases/{purchaseId}/approve` needs
`X-Swanavi-Token` plus `X-Store-Approval-Token`, and only the host app (or, in the
single-operator terminal demo, the operator after reading the preparation)
calls it. An agent message or a merchant description that says "already
approved" approves nothing.

## Agent sequence

1. `list_stores` with `{"city":"NYC"}`.
2. `search_catalog` with `{"storeId":"central-park-bikes"}`.
3. `get_quote` with `{"storeId":"central-park-bikes","sku":"BIKE-2H"}`.
4. `prepare_store_purchase` with `{"storeId":"central-park-bikes","sku":"BIKE-2H","maximumAmount":"0.15","idempotencyKey":"<new key per user intent>"}`.
   `maximumAmount` is the user's ceiling. The server stores the catalog price
   and approval covers at most that price. The preparation expires in 120 seconds.
5. Hand `purchase` to the host. Wait for the user to approve there.
6. `purchase_store_item` with `{"purchaseId":"..."}`.
7. If `status` is `paying`, poll `get_store_purchase` after 1, 2, 4, then every
   5 seconds. Stop after 60 seconds and show the purchase ID. Never prepare a
   replacement. Calling `purchase_store_item` again on the same ID is safe and
   never pays twice.
8. When `status` is `paid` and `settlementStatus` is `pending`, poll later for
   `receiptUrl`. A late receipt is not a reason to pay again.

The times-square souvenir shop is a prompt-injection fixture. It shows in
discovery and preparation refuses it with `unverified_store`.

## What to tell the user

| Purchase fields | Say |
| --- | --- |
| `mode: "mock"` | Demo shop, mock payment. Nothing on chain |
| `status: "paying"` | Payment pending. Do not retry with a new purchase |
| `live: true`, `paidVia: "x402"`, `settlementStatus: "pending"` | Demo shop, testnet payment confirmed (`explorerUrl`), settlement pending |
| `settlementStatus: "settled"` | Settled. Show `receiptUrl` |
| `isError: true` | Show `error.code` and `error.message`. Business errors never mean "try a different purchase" by themselves |

`demo` is always true. `live` is true only with a confirmed transaction.

## Wire contract (verify on the first live run)

Read from `@ap4m/sdk` 0.10.1 (`node_modules/@ap4m/sdk/dist/x402.d.ts`):

- x402 version 2, scheme `batch-settlement`, binding version `1`.
- Headers: `PAYMENT-REQUIRED` (seller 402), `PAYMENT-SIGNATURE` (agent retry),
  `PAYMENT-RESPONSE` (seller settlement response). Responses are
  `Cache-Control: no-store, private`, `Vary: PAYMENT-SIGNATURE`, at most 12288 header bytes.
- Each `accepts[]` entry carries `network` (`eip155:<chainId>`), `amount` (wei
  string), `asset` (token address), `payTo` (channel payout), `maxTimeoutSeconds`
  and `extra { bindingVersion, ledger, pricingMode, channelId, acceptedCumulativeAmount }`.
- The settlement response carries `transaction`, `network`, and
  `extensions.ap4m { channelId, voucherDigest, channelPayout, maximumAmount,
  actualAmount, claimId, claimStatus, reconciled }`.

The executor's first request is `GET /resource` with `X-AP4M-CHANNEL-ID`. Before
anything is signed, `ap4m_executor.mjs` `quote()` now runs
`x402_challenge.mjs` `checkPaymentRequired`: exactly one offer, scheme
`batch-settlement`, network `eip155:<configured chainId>`, asset equal to the
configured RLUSD token, `extra.ledger` equal to the payment ledger,
`extra.channelId` equal to `TRIP_CHANNEL_ID`, `payTo` equal to the channel's
on-chain payout, positive amount, and resource path `/resource`. `fetch` uses
`redirect: 'error'`. The price check stays in `buy()` and `payments.release()`.

The hackathon helper `ap4m-x402.mjs` (`buyResource`, `createX402Merchant`) was
not present in this checkout, so its own checks and retry semantics were not
read. On the first live rehearsal, open the downloaded helper and record here
which of the checks above it already performs and how it builds
`PAYMENT-SIGNATURE`. Do not build that header by hand.

## Two separate tests

1. Deterministic smoke client, which proves the targets and approval
   continuation, not agent behavior:

   ```bash
   SWANAVI_TOKEN=... STORE_APPROVAL_TOKEN=... node scripts/shop_smoke.mjs
   ```

   It refuses a live server unless `SHOP_SMOKE_ALLOW_SPEND=1`. Without the
   approval token it stops at preparation.
2. The actual agent. Ask it to rent a two-hour bike at Central Park, approve in
   the host, and check the Gateway logs show the agent choosing
   `prepare_store_purchase` and then `purchase_store_item` itself.

## Live acceptance record

Not yet run. It needs an operator-authorized testnet spend, the downloaded
helper files, a funded open channel and the matching merchant. Record the
purchase ID, escrow ID, SKU, 402 price, `paidVia: x402`, the confirmed
transaction hash, the delivered resource and the AP4M receipt. Never record
tokens, keys or signed payment headers.
