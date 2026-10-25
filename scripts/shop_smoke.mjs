/**
 * Deterministic MCP smoke client for the shop purchase path. It is not proof that an AI agent chose
 * the tools; it proves the two targets and the host approval continuation work end to end.
 *
 *   SWANAVI_BASE_URL       default http://127.0.0.1:8787
 *   SWANAVI_TOKEN          service token (required)
 *   STORE_APPROVAL_TOKEN   host approval token; plays the operator who reviewed the preparation
 *   SHOP_SMOKE_SKU         default BIKE-2H at central-park-bikes
 *   SHOP_SMOKE_ALLOW_SPEND=1  required when /health reports live: the operator authorizes a testnet spend
 *
 * Prints purchase/escrow IDs, price, status, transaction hash and receipt URL. Never prints tokens.
 */

const base = (process.env.SWANAVI_BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const token = process.env.SWANAVI_TOKEN;
const approval = process.env.STORE_APPROVAL_TOKEN;
const storeId = process.env.SHOP_SMOKE_STORE || 'central-park-bikes';
const sku = process.env.SHOP_SMOKE_SKU || 'BIKE-2H';

async function http(method, path, body, extra = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Swanavi-Token': token, ...extra },
    body: body == null ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

let rpcId = 0;
async function mcp(path, method, params) {
  const { body } = await http('POST', path, { jsonrpc: '2.0', id: (rpcId += 1), method, params });
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function tool(path, name, args) {
  const result = await mcp(path, 'tools/call', { name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.structuredContent?.error ?? result.content)}`);
  return result.structuredContent;
}

function show(label, purchase) {
  const { purchaseId, status, quotedAmount, chargedAmount, escrowId, live, paidVia, txHash, settlementStatus, receiptUrl, mode } = purchase;
  console.log(label, JSON.stringify({ purchaseId, status, mode, live, quotedAmount, chargedAmount, escrowId, paidVia, txHash, settlementStatus, receiptUrl }));
}

async function main() {
  if (!token) throw new Error('Set SWANAVI_TOKEN.');
  const health = (await http('GET', '/health')).body;
  console.log(`server mode ${health.mode}, live ${health.live}`);
  if (health.live && process.env.SHOP_SMOKE_ALLOW_SPEND !== '1') {
    throw new Error('The server is live. Set SHOP_SMOKE_ALLOW_SPEND=1 only after the operator authorizes this testnet spend.');
  }
  for (const path of ['/mcp', '/stores/purchases/mcp']) {
    const init = await mcp(path, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'shop-smoke', version: '1' } });
    await http('POST', path, { jsonrpc: '2.0', method: 'notifications/initialized' });
    const { tools } = await mcp(path, 'tools/list', {});
    console.log(`${path}: ${init.serverInfo.name} tools ${tools.map((t) => t.name).join(', ')}`);
    if (tools.some((t) => /approv/.test(t.name))) throw new Error(`${path} exposes an approval tool.`);
  }
  const { stores } = await tool('/mcp', 'list_stores', { city: 'NYC' });
  console.log(`stores: ${stores.length}`);
  await tool('/mcp', 'search_catalog', { storeId });
  const quote = await tool('/mcp', 'get_quote', { storeId, sku });
  console.log(`quote ${quote.storeId} ${quote.sku} ${quote.amount} RLUSD verified ${quote.verified}`);
  const key = `smoke-${sku}-${Date.now()}`;
  let { purchase } = await tool('/stores/purchases/mcp', 'prepare_store_purchase', { storeId, sku, maximumAmount: quote.amount, idempotencyKey: key });
  show('prepared', purchase);
  if (!approval) {
    console.log('No STORE_APPROVAL_TOKEN: stopping at the host approval step. Approve in the host app, then call purchase_store_item with this purchaseId.');
    return;
  }
  const approved = await http('POST', `/stores/purchases/${purchase.purchaseId}/approve`, null, { 'X-Store-Approval-Token': approval });
  if (approved.status !== 200) throw new Error(`approve: ${JSON.stringify(approved.body.error)}`);
  ({ purchase } = await tool('/stores/purchases/mcp', 'purchase_store_item', { purchaseId: purchase.purchaseId }));
  show('pay', purchase);
  const started = Date.now();
  for (const delay of [1, 2, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5]) {
    if (purchase.status !== 'paying' && (purchase.settlementStatus !== 'pending')) break;
    if (Date.now() - started > 60_000) break;
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    ({ purchase } = await tool('/stores/purchases/mcp', 'get_store_purchase', { purchaseId: purchase.purchaseId }));
    show('status', purchase);
  }
  if (purchase.status === 'paying') console.log(`Still pending after 60 s. Keep polling ${purchase.purchaseId}; do not prepare a replacement.`);
  if (purchase.status === 'paid' && purchase.settlementStatus === 'pending') console.log('Paid; settlement receipt pending. Poll later. A late receipt is not a reason to pay again.');
  console.log(purchase.mode === 'mock' ? 'Result: demo shop, mock payment.' : purchase.live ? `Result: demo shop, testnet payment confirmed${purchase.receiptUrl ? ', settled' : ', settlement pending'}.` : 'Result: demo shop, no confirmed chain evidence yet.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
