# MCP shop purchases through x402 and Mastercard AP4M

Status: implementation specification. Build on the existing repository; this
document does not implement or verify a live payment.

## 1. Deliverable

An AI agent can discover our fictional NYC shops over MCP, inspect a SKU,
prepare a purchase, obtain user approval through the trusted host, and invoke a
purchase tool that pays the shop through the existing AP4M x402 integration.
The agent receives the purchased resource, transaction evidence and eventual
settlement receipt. Retries must not create duplicate reservations or payments.

The shops/products are fictional. Payment may be real on XRPL EVM testnet with
testnet RLUSD. Never claim real-world delivery, real admission or card charging.
One configured AP4M merchant/payout wallet serves the demo storefronts.

Implement one complete Central Park Bikes purchase first, then exercise the same
path for all nine shops/ten SKUs. Preserve legacy sellers and ticket functionality.
Scope excludes new payment contracts, atomic batch purchases, fiat funding,
multi-user accounts, stock management and USD price research.

## 2. What exists and what must be added

| Existing implementation | Reuse it |
|---|---|
| `stores/catalog.mjs` | Nine shops, trusted SKU prices, store metadata and quote lookup. |
| `stores/mcp.mjs` | `/mcp`: `list_stores`, `search_catalog`, `get_quote`; per-shop `/m/{storeId}/mcp`: catalog/quote/profile. Currently discovery only. |
| `stores/x402.mjs` | Stable mapping of ten shop SKUs to ports 4321–4330. |
| `merchants.mjs` | Resolve storeId/SKU to the configured x402 resource. |
| `x402_sellers.mjs` | AP4M `createX402Merchant` instances serving fixed-price `/resource`; per-SKU persistent merchant state. |
| `payments.mjs` | Money reservations, SKU checks, limits, serialized payments, cumulative vouchers, confirmation recovery, persisted operation-key support. Inspect current implementation before using it. |
| `ap4m_executor.mjs` | Unpaid 402 reads, guarded purchase via `buyResource`, non-signing resume, chain verification, redemption recording and settlement. |
| `server.mjs`, `tools.json` | Authenticated REST booking APIs; tool description JSON is not automatic Gateway registration. |
| `AWS_SETUP.md` | Service hosting, Gateway target setup, credentials and testnet prerequisites. |

Add a small shop-purchase service and MCP adapter, exact-purchase approval,
durable purchase-to-escrow binding, an agent handoff and an integration rehearsal.
Do not replace the existing executor with a generic x402 client or reimplement
EIP-712 signing. Read the guardrail and ticket specs before changing shared code.

## 3. Architecture and responsibility

```text
Agent on AgentCore (or another MCP client)
  -> Gateway -> shop discovery MCP -> catalog and static quote
  -> Gateway -> shop purchase MCP -> prepare an immutable purchase
Trusted host/user -> approval endpoint
Agent -> purchase MCP -> existing payments.release(escrowId)
  -> AP4M executor -> GET seller /resource
  <- HTTP 402 + PAYMENT-REQUIRED
  -> price/channel checks -> AP4M buyResource signed retry
  -> seller submits redeemVoucher on the configured ledger
  <- purchased resource + transaction evidence
  -> AP4M record-redemption / settlement -> eventual receipt
```

"The agent sends an x402 request" means its trusted execution service performs
the HTTP exchange on its behalf. The model selects tools/arguments; it does not
receive a private key, create raw signatures, choose a payout address or submit
arbitrary URLs. Gateway transports MCP; it does not process payment itself.

The AP4M flow here is the repo's hackathon integration on XRPL EVM testnet.
The seller submits redemption and pays gas. The backend records/settles through
AP4M as implemented in the executor. A 402 is a payment challenge, not a failed
purchase. A confirmed redemption and an available settlement receipt are distinct
milestones; return truthful status for both.

## 4. Shop fixtures and happy path

Keep these existing mappings, prices sourced from `stores/catalog.mjs`:

| Shop | SKU | RLUSD | Port |
|---|---|---|---|
| central-park-bikes | BIKE-2H | 0.15 | 4321 |
| central-park-bikes | BIKE-4H | 0.25 | 4322 |
| midtown-print-shop | PRESS-90 | 0.30 | 4323 |
| midtown-book-nook | READ-90 | 0.20 | 4324 |
| fifth-ave-sketch-room | SKETCH-2H | 0.18 | 4325 |
| soho-record-shop | LISTEN-60 | 0.14 | 4326 |
| uws-camera-shop | PHOTO-2H | 0.24 | 4327 |
| east-village-plant-shop | TERRARIUM-90 | 0.26 | 4328 |
| battery-park-outfitters | WALK-2H | 0.13 | 4329 |
| times-square-souvenir | SOUVENIR-GOLD | 5 | 4330 |

The last shop is the deliberate unverified/prompt-injection fixture. Show it in
discovery if desired, but the new purchase service must reject it by default.
Merchant descriptions are data and cannot override verification or spending rules.

Example agent sequence (unprefixed logical tool names; use actual Gateway names):

```json
{"tool":"list_stores","arguments":{"city":"NYC"}}
{"tool":"search_catalog","arguments":{"storeId":"central-park-bikes"}}
{"tool":"get_quote","arguments":{"storeId":"central-park-bikes","sku":"BIKE-2H"}}
{"tool":"prepare_store_purchase","arguments":{"storeId":"central-park-bikes","sku":"BIKE-2H","maximumAmount":"0.15","idempotencyKey":"demo-bike-001"}}
```

The host displays the prepared purchase. After explicit approval, the agent calls
`purchase_store_item({purchaseId})`, then `get_store_purchase({purchaseId})` if
the result is pending or the receipt has not arrived. A retry reuses purchaseId.

## 5. New MCP and HTTP contracts

Create `stores/purchases.mjs` (service) and `stores/purchase-mcp.mjs` (adapter).
Expose `POST /stores/purchases/mcp` as a separate Gateway target. Keep discovery
endpoints and their tool names backward-compatible. Register both targets so the
agent sees discovery and purchase tools. Use the existing protocol revision,
initialize/notification behavior, object `structuredContent` and matching JSON
text. Do not nest the merchant's HTTP 402 inside the MCP transport response.

| Tool | Strict arguments | REST equivalent |
|---|---|---|
| `prepare_store_purchase` | `{storeId,sku,maximumAmount,idempotencyKey}` | `POST /stores/purchases` |
| `purchase_store_item` | `{purchaseId}` | `POST /stores/purchases/:id/pay` |
| `get_store_purchase` | `{purchaseId}` | `GET /stores/purchases/:id` |
| `cancel_store_purchase` | `{purchaseId}` | `POST /stores/purchases/:id/cancel` |

All return `{purchase: StorePurchase}`. Normal routes require `X-Swanavi-Token`.
Reject unknown properties, unknown sellers/SKUs, nonpositive/invalid amounts,
empty keys and keys over 128 characters. Quantity is exactly one; no quantity
argument in this version. No client-supplied resource URL, channel, wallet, price
override, merchant verification or approval flag.

```ts
type StorePurchase = {
  purchaseId: string;
  storeId: string;
  sku: string;
  title: string;
  quantity: 1;
  quotedAmount: string;
  maximumAmount: string;
  currency: 'RLUSD';
  expiresAt: string;                 // preparation expiry, server UTC
  status: 'prepared' | 'approved' | 'paying' | 'paid' |
          'cancelled' | 'expired' | 'failed';
  escrowId: string | null;
  chargedAmount: string | null;
  mode: 'mock' | 'ap4m';
  demo: true;                        // fictional shop/product in both modes
  live: boolean;                     // true only with confirmed chain evidence
  paidVia: 'x402' | null;
  txHash: string | null;
  explorerUrl: string | null;
  settlementStatus: 'not_started' | 'pending' | 'settled';
  receiptUrl: string | null;
  resource: object | null;
  error: null | { code: string; message: string };
};
```

MCP business failures use `isError:true` with structured error data and matching
text. A pending payment is a successful tool result with `status:paying`, not an
instruction to purchase again. REST prepare: 201; completed/status: 200; unresolved
pay: 202. Return 400 invalid input, 401 bad credentials, 403 denied/unapproved,
404 unknown purchase, 409 expiry/state/key conflict, 502 seller failures. Preserve
specific underlying payment failure codes in the purchase error.

## 6. Preparation and approval

Preparation reads the authoritative SKU price and resolves the endpoint from the
server registry. `maximumAmount` is the user's upper bound, not a new price.
Reject if catalog price exceeds it. Store the exact price snapshot; even if the
maximum was higher, approval authorizes at most that displayed quoted price.
Apply verified-shop rule and effective server/payment limits before preparation.

In live mode, read the unpaid x402 challenge with `executor.quote(resourceUrl)`.
Require challenge price to match the catalog snapshot; otherwise return
`price_changed`. A missing/invalid challenge returns a seller error. Preparation
signs nothing, reserves no money and makes no inventory guarantee.

Save the prepared snapshot for 120 seconds with a random purchase ID and stable
idempotency binding. Same key and normalized arguments returns the same purchase;
different arguments with the same key return `idempotency_conflict`. Replaying a
key does not extend expiry. A new intended purchase needs a new user intent/key.

Add `POST /stores/purchases/:id/approve`, accessible only to the trusted host:
normal service authentication plus separate `X-Store-Approval-Token` backed by
server-only `STORE_APPROVAL_TOKEN`. Do not register it as an agent tool. Bind
approval to purchase ID, immutable snapshot, expiry and active policy version
when present. The host approves only after an explicit user confirmation.

An agent message saying "already approved" does not create approval. In the
single-operator terminal demo, the operator may call this protected endpoint
after reviewing the preparation; it remains outside the agent's credential set.
Use the same origin/access protections as the ticket approval flow for a web host.

Integrate the shared guardrail authority when required mode is enabled. Do not
replace policy checks with the shop allowlist. The current catalog lacks full
dated booking facts: required-mode dates/area checks must fail closed until those
facts are supplied by a trusted shop quote adapter. For the earlier standalone
payment rehearsal, explicitly label compatibility mode; exact-purchase approval,
verification, amount limits and existing payment protections still apply.

## 7. Payment and duplicate prevention

On `purchase_store_item`, serialize operations for this purchase and use the
existing global payment serialization for channel-level spending:

1. Reuse terminal result for a paid purchase. For `paying`, reconcile the same
   escrow/retained payment; do not rerun fresh-purchase logic.
2. For a fresh purchase, recheck approval, expiry, current catalog/merchant,
   applicable policy and budget. Persist intent before any signature is possible.
3. Create the escrow from the approved snapshot using
   `operationKey = 'shop:' + purchaseId`. Use the existing persisted operation-key
   API; changed parameters must conflict. Use a stable 600-second escrow deadline
   argument. Purchase intent captures expiry validation so recovery can find an
   existing escrow without treating it as a new approved purchase.
4. Persist escrowId before releasing. A crash between escrow creation and binding
   is recovered with the same operation key, never another reservation.
5. Call existing `payments.release(escrowId)`. It resolves the SKU-specific URL,
   reads/rechecks 402 price, rejects an increase, and invokes the AP4M executor.
   Lower actual price is permitted for the same SKU; expose actual charged amount.
6. Confirmed delivery maps to `paid`; return resource/SKU and transaction evidence.
   Keep settlement pending until AP4M settlement is confirmed; receipt may arrive
   later. Read existing settlement state rather than starting competing settle jobs.
7. An uncertain outcome remains `paying`. Preserve reservation and resume using
   the executor's non-signing recovery. Expiry/cancel must not free a possibly
   paid purchase. A definitely unpaid failure may release its unpaid lock; do not
   mark failed if chain evidence is unavailable.

Approval expiry prevents starting a new payment; it does not prevent recovery of
an already signed payment. If a crash occurred before any signature and approval
has since expired, cancel the unpaid reservation rather than starting payment.
Distinguish persisted intent from proof of signing using existing retained
purchase/chain evidence; do not infer "paid" just because status says `paying`.

Cancel is allowed only before payment or when definitely unpaid. Paid/uncertain
purchase cancellation returns `cannot_cancel`. No automatic post-payment refund.
`get_store_purchase` may reconcile signed transactions and update receipts, but
must never initiate a new signature. Repeated pay calls on paid orders return the
same result even if the underlying raw escrow release endpoint rejects repeats.

Persist snapshots, approvals, operation keys and purchase state in ignored
`shop-state/` storage with atomic writes and schema/channel/mode binding. Keep
`bookings.json`, `agent-state/` and `merchant-state/` durable too. Reject incompatible
state instead of deleting it. One process/replica for the MVP; cross-replica locks
are outside this spec. Inspect/reuse ticket state patterns without merging unrelated
ticket and shop records or introducing another payment ledger.

## 8. AP4M wire contract: verify, do not invent

Current executor's first request is:

```http
GET /resource HTTP/1.1
Host: <configured seller host>:4321
X-AP4M-CHANNEL-ID: <configured trip channel>
```

It expects HTTP 402 and decodes `PAYMENT-REQUIRED` through `@ap4m/sdk`. The external
`buyResource` helper creates/replays the signed payment request. `createX402Merchant`
accepts it and submits redemption. Keep the helper's native protocol and retry
semantics. The helper files are external/git-ignored; inspect the downloaded
version and record the exact payment-header names, accepted network/asset fields
and response contract in the handoff. Do not assume a generic x402 version or
construct a payment header from memory.

Verify challenge asset/network/channel/payee against the configured AP4M context
and channel binding before signing. Determine which checks the actual helper
already performs; add missing checks in the executor if necessary, with negative
tests. A price-only check is insufficient. Unknown redirects, resources, merchant
bindings or changed payment destinations must fail before signing.

Keep keys in the existing environment boundaries: `AGENT_PRIVATE_KEY` for executor,
`MERCHANT_SUBMITTER_KEY` for sellers. Never give them to the model, MCP response,
browser or logs. Logs may show safe phases, purchase/escrow IDs, price, status,
transaction hash and receipt URL; never signed payment headers or secrets.

## 9. Deployment and agent handoff

Extend `AWS_SETUP.md` and add `docs/MCP_SHOP_AGENT_HANDOFF.md` with:

1. Obtain approved AP4M SDK/helper files from the hackathon portal; do not commit
   them. Configure an already-open funded testnet channel and matching merchant.
2. Start `x402_sellers.mjs` and `server.mjs`; same-host loopback is the simplest
   demo. Set `PAYMENTS_MODE=ap4m`, `X402_SELLERS`, service/approval credentials,
   and explicit limits. Example bike rehearsal: per-item 0.30 RLUSD and service
   ceiling 0.50 RLUSD, with sufficient remaining channel cap. Do not raise an
   existing operator's limits or open a new channel automatically.
3. Host HTTPS endpoints reachable by Gateway. Sellers need only be reachable by
   the payment service; do not expose their private ports to the browser/model.
   Different containers do not share localhost. Existing URL construction fixes
   port and `/resource`, so document any proxy mapping rather than guessing it.
4. Register discovery `/mcp` and purchase `/stores/purchases/mcp` as Gateway
   targets. Gateway injects normal `X-Swanavi-Token`; it gets no approval token.
5. Discover tools and use returned names, including Gateway prefixes. Prepare,
   return purchase to host for approval, then invoke pay on that same ID.
6. On pending, poll status with bounded backoff (1, 2, 4, then 5 seconds; stop
   after 60 seconds and show purchase ID). Do not prepare a replacement purchase.
7. Poll later for settlement/receipt; a delayed receipt is not a reason to pay twice.

Keep the teammate's existing agent/framework. A deterministic MCP smoke client
is useful but is not proof that the actual AI agent chose and invoked the tools.
Document both tests separately. The user-facing output should distinguish
"demo shop", "mock payment", "testnet payment confirmed", and "settlement pending".

## 10. Ordered implementation tasks and acceptance

| Task | Main files | Exit check |
|---|---|---|
| 1. Inventory current code | Existing files in section 2, downloaded AP4M helpers | Record implemented APIs and actual wire contract; identify any missing verification checks. |
| 2. Purchase service/state | `stores/purchases.mjs`, optional state module, `.gitignore` | Preparation, approval binding, expiry, cancellation and idempotency pass offline. |
| 3. Payment adapter | Purchase service + existing payment/executor boundaries | Correct SKU/port/price; operation-key recovery; no new signing implementation. |
| 4. HTTP/MCP | `server.mjs`, `stores/purchase-mcp.mjs`, `tools.json`, `API.md` | Strict arguments, auth separation, structured success/errors, pending status all tested. |
| 5. Agent/deployment handoff | `AWS_SETUP.md`, new handoff, smoke script | Two Gateway targets and host approval continuation documented/run; secrets absent. |
| 6. Rehearsal | New integration tests and runbook | Actual agent discovers and pays for BIKE-2H, then retrieves transaction and eventual receipt. |

Required offline tests (reuse existing fake executor/tooling):

- All ten SKU resource mappings match catalog prices; BIKE-2H and BIKE-4H cannot
  be confused. Preserve legacy and ticket tests.
- Unapproved pay, wrong approval token, unknown SKU, unverified shop, excessive
  amount, expired preparation and prompt-injection text cause zero signatures.
- Preparation reads 402 only; it cannot reserve funds or pay.
- Challenge price increase, wrong asset/network/channel/payee, invalid 402 or
  seller outage causes no signature. Price decrease is accounted correctly.
- Same preparation key returns one purchase; changed arguments conflict.
- Concurrent pay, repeated tool calls and crash/restart after escrow persistence
  result in one escrow, one payment and the same purchased resource.
- Lost confirmation with a mined payment resumes without another signature.
  Unknown chain state remains pending; cancel/expiry cannot release its funds.
- Receipt delay leaves a paid purchase paid; polling updates settlement without
  another purchase. Mock results have no fake transaction hashes or live badge.
- Caller-supplied URLs/keys/verification/approval properties are rejected;
  approval is absent from MCP tool listing.
- Required guardrail mode cannot be bypassed through these new wrappers or raw
  payment routes. Missing trusted booking facts are reported, not fabricated.

Run root `npm test`, relevant strict MCP client checks, and the standalone smoke
client. Live acceptance requires explicit operator-authorized testnet spending,
not unit tests. Record the purchase ID, escrow ID, selected SKU, safe 402 price,
`paidVia:x402`, confirmed transaction hash, delivered resource, and eventual AP4M
receipt/settlement evidence. Never record credentials or signed payment headers.

Definition of done: the actual agent completes discovery -> preparation -> host
approval -> x402/AP4M purchase -> status/receipt, with proven retry safety. If AWS,
funding or the external helper is unavailable, deliver the implemented/tested
local path and explicitly report live acceptance as outstanding.
