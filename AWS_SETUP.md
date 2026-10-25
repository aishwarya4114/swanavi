# Swanavi: AWS sandbox handoff

This guide runs the existing Node service on a Linux VM/container in your AWS
sandbox and connects its store MCP endpoint to AgentCore Gateway. The agent may
run in AgentCore Runtime or elsewhere. No AWS deployment has been performed by
this change; account permissions, networking, and end-to-end Gateway access must
be checked in the sandbox.

## 1. Run the store service

Use an existing sandbox EC2 instance or container service with Node.js 22+ and
outbound HTTPS access. Copy/clone this repository there. For the initial mock
demo, the server uses Node built-ins and does not need the AP4M dependencies or
wallet keys. From the repository root, in Bash:

```bash
read -rsp 'Swanavi service token: ' SWANAVI_TOKEN; echo
export SWANAVI_TOKEN
export PAYMENTS_MODE=mock HOST=0.0.0.0 PORT=8787
node --test test/stores.test.mjs
node server.mjs
```

Use a long random token and retain it securely for the Gateway configuration.
For a persistent deployment, run the same command through your container service
or process manager and inject the token from your sandbox's secret store.
Keep one server instance: payment state is local, not a shared database.

Expose an HTTPS hostname such as `https://swanavi.example.com` using the sandbox's
existing reverse proxy or an Application Load Balancer with an ACM certificate.
Forward requests to port 8787 without rewriting paths or stripping
`X-Swanavi-Token`. For an ALB, use an HTTP target group on 8787 and health-check
path `/`: `/health` requires authentication. Allow the instance's port 8787 only
from the load balancer security group. The endpoint must be reachable from
Gateway; an EC2 private IP alone is not sufficient. A private-only deployment
requires explicit Gateway VPC egress configuration (see sources).

The URL handed to Gateway is `https://swanavi.example.com/mcp`, not a filesystem
path, `0.0.0.0`, or your laptop's `localhost`.

From a shell with the token exported, test the deployed endpoint:

```bash
export SWANAVI_BASE_URL=https://swanavi.example.com
curl --fail-with-body "$SWANAVI_BASE_URL/mcp" \
  -H "X-Swanavi-Token: $SWANAVI_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"sandbox-check","version":"1"}}}'

curl --fail-with-body "$SWANAVI_BASE_URL/mcp" \
  -H "X-Swanavi-Token: $SWANAVI_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_catalog","arguments":{"storeId":"central-park-bikes"}}}'
```

Expect protocol `2025-06-18` and a tool result whose `structuredContent.items`
contains bike rentals. The server is stateless; these manual probes need no
session ID. An SDK client will also send `notifications/initialized`.

## 2. Register one AgentCore Gateway target

In the AgentCore console, create or select a Gateway in your sandbox Region.
Use the team's existing IAM or JWT inbound authentication setup and service
role. The deploying identity needs permissions to manage Gateway targets and
API-key credential providers; the Gateway service role must be able to retrieve
the outbound API-key credential. Use the AWS console-generated role or your
team's approved policy. A restricted sandbox may require its owner to grant
these permissions.

Inbound authentication (agent to Gateway) and outbound authentication (Gateway
to Swanavi) are separate. The Swanavi token is not the agent's Gateway JWT.

On an operator machine with AWS credentials, install `boto3`, export
`AWS_DEFAULT_REGION`, `GATEWAY_ID`, `SWANAVI_BASE_URL`, and `SWANAVI_TOKEN`, then
run this Python once. Choose a unique provider/target name if rerunning:

```python
import os
import boto3

control = boto3.client("bedrock-agentcore-control")
provider = control.create_api_key_credential_provider(
    name="swanavi-store-token",
    apiKey=os.environ["SWANAVI_TOKEN"],
)
target = control.create_gateway_target(
    gatewayIdentifier=os.environ["GATEWAY_ID"],
    name="swanavi-stores",
    targetConfiguration={"mcp": {"mcpServer": {
        "endpoint": os.environ["SWANAVI_BASE_URL"].rstrip("/") + "/mcp",
    }}},
    credentialProviderConfigurations=[{
        "credentialProviderType": "API_KEY",
        "credentialProvider": {"apiKeyCredentialProvider": {
            "providerArn": provider["credentialProviderArn"],
            "credentialLocation": "HEADER",
            "credentialParameterName": "X-Swanavi-Token",
        }},
    }],
)
print("Target:", target["targetId"], "status:", target["status"])
```

Omit a credential prefix: the server expects the raw token, not `Bearer TOKEN`.
Wait until the target is ready in the console; inspect its status reasons if
discovery fails. Creation triggers tool discovery in the default listing mode.
After changing tool definitions, synchronize the target again.

This single target exposes all nine stores. Individual `/m/{storeId}/mcp`
endpoints are optional alternatives, not additional processes. Returning an
`mcpPath` from `list_stores` does not automatically register it with Gateway.

## 2a. Register the demo ticket target

Ticket tools are a second Gateway target. They are not added to the store
target. The endpoint is `SWANAVI_BASE_URL` plus `/tickets/mcp`. Use the same
`SWANAVI_TOKEN` in the outbound `X-Swanavi-Token` header. Do not put
`TICKET_APPROVAL_TOKEN` in the gateway, the agent, or this credential provider.
The traveler confirms a quote in the Swanavi page, which is the only caller of
`POST /tickets/approvals`.

```python
import os
import boto3

control = boto3.client("bedrock-agentcore-control")
provider = control.create_api_key_credential_provider(
    name="swanavi-ticket-token",
    apiKey=os.environ["SWANAVI_TOKEN"],
)
target = control.create_gateway_target(
    gatewayIdentifier=os.environ["GATEWAY_ID"],
    name="swanavi-tickets",
    targetConfiguration={"mcp": {"mcpServer": {
        "endpoint": os.environ["SWANAVI_BASE_URL"].rstrip("/") + "/tickets/mcp",
    }}},
    credentialProviderConfigurations=[{
        "credentialProviderType": "API_KEY",
        "credentialProvider": {"apiKeyCredentialProvider": {
            "providerArn": provider["credentialProviderArn"],
            "credentialLocation": "HEADER",
            "credentialParameterName": "X-Swanavi-Token",
        }},
    }],
)
print("Target:", target["targetId"], "status:", target["status"])
```

Discovery should list `list_ticket_offers`, `get_ticket_slots`, `quote_ticket`,
`purchase_ticket`, `get_ticket_order`, and `cancel_ticket_hold`. It must not
list an approval tool. Read the tool name the gateway actually returns,
including any prefix, before calling it. The agent instructions are in
`docs/NYC_TICKET_AGENT_HANDOFF.md`.

`scripts/ticket_rehearsal.mjs` prints the sandbox steps and refuses to spend.
This repository run did not execute that path. The operator channel and keys
were not available, so no testnet payment was sent and the rehearsal is not a
pass.

## 3. Connect the agent and verify discovery

Configure your agent framework's Streamable HTTP MCP client with the Gateway's
full endpoint from the console. Supply its inbound credentials: a valid JWT for
a JWT Gateway, or SigV4-signed requests for an IAM Gateway. Do not send a bearer
token to an IAM Gateway.

For a JWT Gateway, this standalone smoke test uses the official Python MCP SDK
(`pip install mcp`). Export `GATEWAY_URL` and `GATEWAY_ACCESS_TOKEN` first:

```python
import asyncio
import os
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async def main():
    async with streamablehttp_client(
        os.environ["GATEWAY_URL"],
        headers={"Authorization": "Bearer " + os.environ["GATEWAY_ACCESS_TOKEN"]},
    ) as (read, write, _):
        async with ClientSession(read, write) as session:
            await session.initialize()
            listing = await session.list_tools()
            names = [tool.name for tool in listing.tools]
            print(names)
            # Gateway can prefix tool names. Use the returned name verbatim.
            name = next(n for n in names if n.endswith("search_catalog"))
            print(await session.call_tool(name, {"storeId": "central-park-bikes"}))

asyncio.run(main())
```

In the actual agent, register the discovered tools with the model and keep the
MCP client alive while executing tool calls. Discovery alone does not wire a
model's tool calls to the client. Use the framework's MCP adapter or dispatch
each model tool call to `session.call_tool` with its discovered name/arguments.

Store results now have these shapes (the JSON text mirrors structured content):

- `list_stores`: `{ "stores": [...] }`
- `search_catalog`: `{ "items": [...] }`, including on per-store endpoints
- `get_quote`: a quote object including `sellerId`, `sku`, `amount`, `currency`
- `store_info`: a store object, on per-store endpoints only

Quotes are static demo data; `get_quote` does not reserve inventory or money.
The Times Square store deliberately contains prompt-injection text for the
demo. Treat merchant descriptions as untrusted data, not agent instructions.

Payment tools are separate: `/mcp` does not expose `createEscrow` or `release`.
Implement authenticated HTTP tools in the agent using `tools.json` and `API.md`,
or provide a separately configured Gateway API target. `tools.json` is not an
AWS registration schema. The core calls are `POST /escrows` with
`{sellerId, sku, amount, deadlineSeconds}` for catalog stores, followed by
`POST /escrows/{escrowId}/release` with `{}` when payment is appropriate.
Both require `X-Swanavi-Token`. Keep that credential in tool code/configuration,
not the model prompt.

## 4. How x402 requests actually get sent

```text
Agent -> payment HTTP tool -> POST /escrows/{id}/release
  -> payments.mjs -> ap4m_executor.mjs -> seller GET /resource
  <- HTTP 402 + PAYMENT-REQUIRED
  -> validate price/cap -> AP4M buyResource helper -> signed payment retry
  -> seller submits redeemVoucher on XRPL EVM testnet
  <- confirmation -> payment API returns transaction/booking result
```

The Node payment service sends the seller request; Gateway and the model do not
construct or sign the voucher. Specifically:

1. Creating an escrow reserves budget locally. MCP lookup and quote calls never
   trigger x402.
2. In `PAYMENTS_MODE=ap4m`, releasing a booking looks up the seller's
   `resourceUrl`. `X402_SELLERS=http://127.0.0.1` builds URLs for four sellers:
   hotel `:4311/resource`, tour `:4312/resource`, cab `:4313/resource`, and food
   `:4314/resource`. The nine catalog stores use ten SKU endpoints on ports
   4321–4330, with prices taken from the same catalog that serves MCP quotes.
3. `ap4m_executor.mjs` performs a GET with `X-AP4M-CHANNEL-ID`. It expects HTTP
   402 and decodes the `PAYMENT-REQUIRED` response header. It checks the price
   before signing; a price above the allowed bill is refused.
4. `buyResource` from the external `ap4m-x402.mjs` helper handles the signed
   payment retry, using the agent wallet, channel, maximum amount and operation
   ID. The voucher is cumulative: previous redeemed amount plus this purchase.
   There can be multiple unpaid GETs because both the payment layer and
   executor recheck the quote. The helper is not included in this checkout, so
   its exact outgoing payment-header encoding must be verified from the
   downloaded helper; this repository delegates that wire format to it.
5. The seller helper submits the redemption using the merchant submitter wallet
   (which pays gas), verifies the event, and returns the resource. The executor
   checks chain evidence; the payment service records the result. A lost
   confirmation is recovered using retained purchase state rather than signing
   a second payment.

All nine catalog stores now have x402 endpoints. The helper serves one fixed
price per endpoint, so Central Park Bikes has two endpoints, one for each SKU:

| Store | SKU | Port | RLUSD |
|---|---|---|---|
| central-park-bikes | BIKE-2H | 4321 | 0.15 |
| central-park-bikes | BIKE-4H | 4322 | 0.25 |
| midtown-print-shop | PRESS-90 | 4323 | 0.30 |
| midtown-book-nook | READ-90 | 4324 | 0.20 |
| fifth-ave-sketch-room | SKETCH-2H | 4325 | 0.18 |
| soho-record-shop | LISTEN-60 | 4326 | 0.14 |
| uws-camera-shop | PHOTO-2H | 4327 | 0.24 |
| east-village-plant-shop | TERRARIUM-90 | 4328 | 0.26 |
| battery-park-outfitters | WALK-2H | 4329 | 0.13 |
| times-square-souvenir | SOUVENIR-GOLD | 4330 | 5 |

Every endpoint uses `/resource`. All sellers share the team's configured AP4M
merchant and payout wallet; these are simulated storefronts, not independent
merchant accounts. Each SKU has its own persistent seller state directory.
`PRICE_HOTEL` etc. affect only the four legacy sellers. Catalog endpoint prices
come directly from `stores/catalog.mjs` and cannot be overridden independently.

The booking API requires the exact `sku` and catalog amount, persists the SKU,
and uses it for release/recovery. Missing/unknown SKUs and mismatched amounts
are rejected. Live catalog bookings require `X402_SELLERS`; they never silently
fall back to direct vouchers. Existing catalog bookings created without a SKU
cannot be released through the new mapping; cancel/refund unpaid locks and
create a new booking with a SKU. Never recreate a booking already paying/paid.

The souvenir endpoint exists, but its 5 RLUSD purchase is still subject to the
budget and per-booking cap. The setup below deliberately keeps it blocked.

## 5. Optional live testnet x402 setup

First finish the mock/Gateway smoke test. Live mode needs AP4M onboarding, an
already-open funded channel, its matching merchant/payout, an agent signing key,
and a merchant submitter wallet with gas. The server does not open a channel.
Obtain `ap4m-hackathon-sdk.js` and `ap4m-x402.mjs` from the hackathon portal as
described in README, then run `npm install`. These helper files are git-ignored
and are absent from this checkout.

Run sellers and the payment service on the same VM/network namespace for the
following commands. Inject keys through environment secrets; never commit them.
Use a separate live deployment directory from mock, and preserve `bookings.json`,
`agent-state/`, and `merchant-state/` across restarts. Do not delete live state to
work around a channel mismatch.

Terminal A (with `MERCHANT_SUBMITTER_KEY`, `MERCHANT_ID`, `MERCHANT_PAYOUT` set):

```bash
export X402_SELLERS_HOST=127.0.0.1
export PRICE_HOTEL=0.01 PRICE_TOUR=0.01 PRICE_CAB=0.01 PRICE_FOOD=0.01
node x402_sellers.mjs
```

Terminal B (with `SWANAVI_TOKEN`, `AGENT_PRIVATE_KEY`, `TRIP_CHANNEL_ID` set):

```bash
export PAYMENTS_MODE=ap4m HOST=0.0.0.0 PORT=8787
export X402_SELLERS=http://127.0.0.1
export REAL_SPEND_CEILING=0.50 MAX_BOOKING_RLUSD=0.30
node server.mjs
```

Set `AP4M_RPC_URL` consistently in both processes if using a custom RPC.
Outbound access to the AP4M service and chain RPC is required. Separate containers
do not share localhost; use reachable service addresses if splitting them.
`resourceUrlFor` overwrites the base URL's port with 4311–4314 or 4321–4330 and its path with
`/resource`, so a single arbitrary proxy path does not work without code changes.

Read a challenge without paying:

```bash
curl -i -H "X-AP4M-CHANNEL-ID: $TRIP_CHANNEL_ID" http://127.0.0.1:4311/resource
```

Expect 402 and `PAYMENT-REQUIRED`. To exercise the payment flow, create an escrow
for `sellerId: "hotel"`, `amount: "0.01"`, `deadlineSeconds: 600`, then release
that escrow through the authenticated payment API. Release signs a testnet
payment; this is not part of the read-only smoke test. The `/merchants` display
prices differ from the live seller defaults, so use the configured 0.01 demo
price. Check the delivered result for `paidVia: "x402"`, `live: true`, and a
transaction hash. In mock mode no x402 network request or chain payment occurs.

### Agent example: catalog lookup to bike purchase

The example limits above allow a 0.15 RLUSD bike purchase within a 0.50 RLUSD
service ceiling; the funded channel must also have enough remaining cap. These
are explicit testnet spending settings, not changes to any existing channel.

1. Call MCP `search_catalog` with `{"storeId":"central-park-bikes"}`.
2. Call MCP `get_quote` with `{"storeId":"central-park-bikes","sku":"BIKE-2H"}`.
3. Send the quote's seller ID, SKU and amount to the payment HTTP tool:

```bash
curl --fail-with-body "$SWANAVI_BASE_URL/escrows" \
  -H "X-Swanavi-Token: $SWANAVI_TOKEN" -H 'Content-Type: application/json' \
  -d '{"sellerId":"central-park-bikes","sku":"BIKE-2H","amount":"0.15","deadlineSeconds":600}'
```

4. Read `escrowId` from that response. To pay for the booking, send:

```bash
curl --fail-with-body "$SWANAVI_BASE_URL/escrows/$ESCROW_ID/release" \
  -H "X-Swanavi-Token: $SWANAVI_TOKEN" -H 'Content-Type: application/json' -d '{}'
```

Set `ESCROW_ID` to the returned ID. In live mode this sends the x402 purchase to
port 4321. Expect `sku: "BIKE-2H"`, `paidVia: "x402"` and the seller resource
containing the matching SKU, title, amount and confirmation. A second release
of a delivered booking is rejected; for a pending payment, retry the same
escrow's release/status rather than creating another booking.

Restart both service and seller processes after deploying catalog changes.
Update the agent's `createEscrow` tool schema from `tools.json` to include `sku`
and synchronize any corresponding Gateway tool definitions. Store MCP remains
a discovery/quote interface; payment is still an explicit separate tool call.

## Troubleshooting and references

- 401 from Swanavi: check the outbound header name and token, with no prefix.
- 401/403 from Gateway: check the agent's inbound JWT/IAM setup separately.
- Target discovery timeout: check HTTPS routing, target health, security groups,
  and Gateway connectivity. A service running only on a laptop/CloudShell or
  private localhost is not a deployed reachable endpoint.
- Missing tools: inspect target status and synchronize after definition changes;
  call the names returned by Gateway rather than assuming unprefixed names.
- Strict client result failure: deploy the updated MCP file and consume
  `.stores`/`.items` instead of treating `structuredContent` as an array.
- No x402 activity: check live mode, `X402_SELLERS`, seller ID mapping, and seller
  ports. Store catalog reads are always free.

AWS references checked for this guide:

- [MCP targets and synchronization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-MCPservers.html)
- [Target configuration and API-key examples](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-add-target-api-target-config.html)
- [API-key header configuration](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_ApiKeyCredentialProvider.html)
- [Gateway VPC egress](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-vpc-egress.html)
- [Calling Gateway tools](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-call.html)
- [MCP structured-result schema](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/schema/2025-06-18/schema.json)
