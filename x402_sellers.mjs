/**
 * Our four sellers as real x402 merchants, one process, built on the official
 * createX402Merchant helper (ap4m-x402.mjs). Each seller is its own fixed-price merchant on
 * its own port (the helper requires the path to be exactly /resource):
 *
 *   hotel 4311   tour 4312   cab 4313   food 4314
 *
 * An agent GETs /resource with X-AP4M-CHANNEL-ID and receives a 402 with the price; it answers
 * with a signed cumulative voucher; this process submits redeemVoucher from the submitter wallet
 * (it pays the gas), waits for the block, verifies the VoucherRedeemed event and returns the
 * booking confirmation. The helper keeps a SQLite store per seller so a retried payment is never
 * redeemed twice.
 *
 * Environment (the key is read here only and never printed):
 *   MERCHANT_SUBMITTER_KEY  wallet with XRP for gas that sends redemptions (required)
 *   MERCHANT_ID             the merchant id the channel is bound to (required)
 *   MERCHANT_PAYOUT         that merchant's payout wallet (required); the helper refuses a
 *                           channel bound to another merchant or payout (403)
 *   PRICE_HOTEL / PRICE_TOUR / PRICE_CAB / PRICE_FOOD   RLUSD, default 0.01 each
 *   AP4M_API_URL            default https://hackathon.ap4m.build
 *   AP4M_RPC_URL            default: the RPC from /public/config
 *   X402_SELLERS_HOST       default 127.0.0.1 (loopback only; put HTTPS in front for other machines)
 *   STATE_DIRECTORY         default ./merchant-state (one sub-directory per seller)
 *
 * For the rehearsal on the stray channel 0x14dc20af…, MERCHANT_ID and MERCHANT_PAYOUT are the
 * values that channel is bound to (see PROGRESS.md). For the demo channel they are our own
 * merchant from the participant portal.
 */

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { createX402Merchant, loadX402Context } from './ap4m-x402.mjs';
import { DEFAULTS, resourceUrlFor } from './merchants.mjs';

export function sellerPrices(env = process.env) {
  const prices = {};
  for (const entry of DEFAULTS) {
    const raw = env[`PRICE_${entry.sellerId.toUpperCase()}`] || '0.01';
    prices[entry.sellerId] = ethers.parseUnits(raw, 18);
  }
  return prices;
}

export function sellerContent(entry) {
  // Fixed per seller: the helper returns the same content for every sale of this resource.
  return {
    sellerId: entry.sellerId,
    name: entry.name,
    confirmation: `Booking confirmed by ${entry.name}. Paid over x402 on an AP4M channel; see the VoucherRedeemed event in PAYMENT-RESPONSE.`,
  };
}

export async function startSellers({
  env = process.env,
  log = console,
} = {}) {
  const key = env.MERCHANT_SUBMITTER_KEY;
  const merchantId = (env.MERCHANT_ID || '').toLowerCase();
  const payout = env.MERCHANT_PAYOUT || '';
  if (!key) throw new Error('Set MERCHANT_SUBMITTER_KEY (a wallet with XRP for gas). Never put it in a file in this repo.');
  if (!/^0x[0-9a-f]{64}$/.test(merchantId)) throw new Error('Set MERCHANT_ID to the merchant id the channel is bound to.');
  if (!ethers.isAddress(payout)) throw new Error('Set MERCHANT_PAYOUT to that merchant\'s payout wallet.');
  const apiUrl = env.AP4M_API_URL || 'https://hackathon.ap4m.build';
  const host = env.X402_SELLERS_HOST || '127.0.0.1';
  const stateRoot = env.STATE_DIRECTORY || join(process.cwd(), 'merchant-state');
  const context = await loadX402Context(apiUrl);
  const config = await (await fetch(`${apiUrl}/public/config`)).json();
  const provider = new ethers.JsonRpcProvider(env.AP4M_RPC_URL || config.network.rpcUrl, Number(config.network.chainId || 1449000), { staticNetwork: true });
  // One nonce manager shared by the four sellers so two redemptions in a row never collide.
  const submitter = new ethers.NonceManager(new ethers.Wallet(key, provider));
  const submitterAddress = await submitter.getAddress();
  const gas = await provider.getBalance(submitterAddress);
  log.log(`submitter ${submitterAddress} has ${ethers.formatEther(gas)} XRP for gas`);
  if (gas === 0n && env.ALLOW_NO_GAS !== '1') throw new Error(`Submitter ${submitterAddress} has no XRP. Fund it from the faucet first (ALLOW_NO_GAS=1 to serve 402s only).`);
  log.log(`merchant ${merchantId} payout ${payout}`);

  const prices = sellerPrices(env);
  const sellers = [];
  for (const entry of DEFAULTS) {
    const resourceUrl = resourceUrlFor(`http://${host}`, entry);
    const merchant = createX402Merchant({
      context,
      provider,
      submitter,
      stateDirectory: join(stateRoot, entry.sellerId),
      resourceUrl,
      merchantParticipantId: merchantId,
      payout,
      amount: prices[entry.sellerId].toString(),
      content: sellerContent(entry),
    });
    await new Promise((resolve, reject) => {
      merchant.server.once('error', reject);
      merchant.server.listen(entry.x402Port, host, resolve);
    });
    log.log(`${entry.sellerId.padEnd(5)} ${entry.name.padEnd(32)} ${ethers.formatUnits(prices[entry.sellerId], 18).padStart(6)} RLUSD  ${resourceUrl}`);
    sellers.push({ ...entry, resourceUrl, merchant, price: prices[entry.sellerId] });
  }
  return {
    sellers,
    submitter: submitterAddress,
    async close() {
      await Promise.all(sellers.map((s) => s.merchant.close()));
    },
  };
}

function runningAsCli() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (runningAsCli()) {
  startSellers().then((running) => {
    console.log('sellers up. Ctrl-C closes them cleanly (removes the merchant.lock files).');
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.once(signal, () => { running.close().finally(() => process.exit(0)); });
    }
  }).catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
