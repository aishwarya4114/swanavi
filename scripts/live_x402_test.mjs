/**
 * x402 rehearsal on the stray channel. The agent side of x402, no human in the loop:
 *
 *   1. read each seller's 402 (nothing signed), print price against the maximum and the decision
 *   2. buy hotel at 0.01: answer the 402 with a signed cumulative voucher, the seller submits
 *      redeemVoucher, verify VoucherRedeemed
 *   3. buy cab at 0.01 (cumulative 0.04 on this channel)
 *   4. ask tour, whose price the operator set above the maximum: refused BEFORE signing; prove
 *      it by re-reading channel.redeemed (unchanged) and by the absence of any purchase file
 *   5. record both redemptions with the service, settle, print receipt URLs, payout tx,
 *      merchant wallet RLUSD before/after
 *
 * Hard limits, all enforced before any signature:
 *   MAX_PRICE       0.01 per purchase (cannot be raised above 0.01)
 *   EXPERIMENT_CAP  0.03: the channel's redeemed total may never go above this. A new purchase is
 *                   made only when redeemed-on-chain + price <= EXPERIMENT_CAP, read fresh each time.
 *                   What is already redeemed on the channel counts as already paid (0.02 before this
 *                   experiment, 0.03 after the hotel purchase of the first run). Raise it only with approval.
 * Fixed channel; never opens or closes a channel. This process signs vouchers; it never broadcasts a
 * transaction (the executor's guard is armed for nothing, so any attempt would throw). The seller
 * process (x402_sellers.mjs) is what sends the redemption, from the submitter wallet.
 *
 * Resume: a purchase that got a 503 "payment_pending_or_unavailable" from the seller is left on disk
 * in agent-state/<operation>/purchase.json with complete: false. Step 0 finishes every such purchase
 * by re-sending the SAME signed header (the executor's resume() cannot sign). Nothing new is paid.
 *
 * Run it in your own terminal with the key in AGENT_PRIVATE_KEY (see PROGRESS.md "Run commands").
 * Needs x402_sellers.mjs running first, with PRICE_TOUR=0.05 so the refusal step has something to refuse.
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { createExecutorFromEnv } from '../ap4m_executor.mjs';
import { DEFAULTS, resourceUrlFor } from '../merchants.mjs';

const STRAY_CHANNEL = '0x14dc20af40d782b2a80ccb4bfa5cdecd6faf6c441c26d63d1fbe0af7980762c0';
const MAX_PRICE = ethers.parseUnits(process.env.MAX_PRICE || '0.01', 18);
const EXPERIMENT_CAP = ethers.parseUnits(process.env.EXPERIMENT_CAP || '0.03', 18);
const BUY = (process.env.BUY || 'hotel,cab').split(',').map((s) => s.trim()).filter(Boolean);
const REFUSE = (process.env.REFUSE || 'tour').split(',').map((s) => s.trim()).filter(Boolean);
const SELLERS = process.env.X402_SELLERS || 'http://127.0.0.1';
const fmt = (wei) => `${ethers.formatUnits(wei, 18)} RLUSD`;

async function main() {
  if (MAX_PRICE > ethers.parseUnits('0.01', 18)) throw new Error('MAX_PRICE above 0.01 is not allowed in this rehearsal.');
  if (EXPERIMENT_CAP > ethers.parseUnits('0.05', 18)) throw new Error('EXPERIMENT_CAP above 0.05 is not allowed in this rehearsal.');
  const env = { ...process.env, TRIP_CHANNEL_ID: process.env.TRIP_CHANNEL_ID || STRAY_CHANNEL };
  const x = await createExecutorFromEnv(env, { log() {}, warn: console.warn, error: console.error });
  console.log(`agent ${x.agent}  channel ${x.channelId}`);
  console.log(`limits: ${fmt(MAX_PRICE)} per purchase; channel redeemed may not pass ${fmt(EXPERIMENT_CAP)}\n`);

  const start = await x.readChannel();
  if (start.status !== 'open') throw new Error(`channel is ${start.status}; nothing to do`);
  const balanceBefore = await x.merchantBalance(start.payout);
  console.log(`BEFORE  cap ${fmt(start.cap)}  redeemed ${fmt(start.redeemed)} (already paid; counts against the cap)  merchant payout ${start.payout} holds ${fmt(balanceBefore)}\n`);
  if (start.redeemed > EXPERIMENT_CAP) throw new Error(`channel redeemed ${fmt(start.redeemed)} is already above EXPERIMENT_CAP ${fmt(EXPERIMENT_CAP)}; refusing to do anything`);

  /** The one rule for new money: fresh chain read, redeemed + price must fit under the cap. */
  async function mayPay(price, label) {
    const now = await x.readChannel();
    if (now.redeemed + price > EXPERIMENT_CAP) {
      console.log(`  ${label}: SKIPPED, redeemed ${fmt(now.redeemed)} + ${fmt(price)} would pass EXPERIMENT_CAP ${fmt(EXPERIMENT_CAP)}. Nothing signed.`);
      return false;
    }
    return true;
  }

  const bought = [];

  // 0. finish any purchase left unresolved by an earlier run (re-sends the same signed header; signs nothing)
  const pending = x.pendingPurchases();
  console.log(`== 0. unresolved purchases on disk: ${pending.length}`);
  for (const p of pending) {
    console.log(`  ${p.operation}: signed cumulative ${ethers.formatUnits(p.previousCumulativeAmount + p.maximumAmount, 18)} at most, previous ${ethers.formatUnits(p.previousCumulativeAmount, 18)}  -> resuming`);
    try {
      const result = await x.resume({ operation: p.operation });
      bought.push(result);
      console.log(`  resolved: paid ${fmt(result.amount)}  cumulative ${ethers.formatUnits(result.previous, 18)} -> ${ethers.formatUnits(result.cumulativeAmount, 18)}  block ${result.blockNumber}`);
      console.log(`  tx ${x.links.tx(result.txHash)}`);
      console.log(`  claim ${result.claimId}`);
      console.log(`  resource ${JSON.stringify(result.resource)}`);
    } catch (error) {
      console.log(`  still unresolved: ${error.code ?? ''} ${error.message}`);
      console.log('  (the seller answers 503 while it cannot confirm the redemption; run again in a minute; nothing is signed by resuming)');
      process.exitCode = 2;
    }
  }

  // 1. read every 402, sign nothing
  console.log('== 1. 402 challenges (nothing signed)');
  const quotes = {};
  for (const entry of DEFAULTS) {
    const url = resourceUrlFor(SELLERS, entry);
    try {
      const q = await x.quote(url);
      quotes[entry.sellerId] = q;
      const decision = q.price > MAX_PRICE ? 'REFUSE (above maximum)' : 'accept';
      console.log(`  ${entry.sellerId.padEnd(5)} asks ${fmt(q.price).padStart(14)}  payTo ${q.payTo}  prev cumulative ${ethers.formatUnits(q.previousCumulativeAmount ?? 0n, 18)}  -> ${decision}`);
      if (q.payTo.toLowerCase() !== start.payout.toLowerCase()) console.log(`     WARNING payTo differs from the channel payout ${start.payout}`);
    } catch (error) {
      console.log(`  ${entry.sellerId.padEnd(5)} no 402: ${error.message}`);
    }
  }

  // 2-3. buy (skipped when a seller of the same name was already paid by a resumed purchase this run)
  for (const sellerId of BUY) {
    const entry = DEFAULTS.find((e) => e.sellerId === sellerId);
    const q = quotes[sellerId];
    console.log(`\n== buy ${sellerId}`);
    if (!entry || !q) { console.log('  skipped: no 402'); continue; }
    if (bought.some((b) => b.resource?.sellerId === sellerId)) { console.log('  skipped: already paid by the resumed purchase above'); continue; }
    if (q.price > MAX_PRICE) { console.log(`  skipped: ${fmt(q.price)} is above the maximum; nothing signed`); continue; }
    if (!(await mayPay(q.price, sellerId))) continue;
    const operation = `x402-${sellerId}-${Math.floor(Date.now() / 1000)}`;
    const before = await x.readChannel();
    let result;
    try {
      result = await x.buy({ resourceUrl: q.resourceUrl, maximumAmount: MAX_PRICE, operation });
    } catch (error) {
      const after = await x.readChannel();
      console.log(`  not confirmed: ${error.code ?? ''} ${error.message}`);
      console.log(`  channel redeemed before ${fmt(before.redeemed)} after ${fmt(after.redeemed)}`);
      console.log(`  ${after.redeemed > before.redeemed ? 'The redemption WAS mined; the seller could not confirm it in time. Run this script again: step 0 resumes it without signing.' : 'Nothing was redeemed.'}`);
      process.exitCode = 2;
      break;
    }
    bought.push(result);
    console.log(`  paid ${fmt(result.amount)}  cumulative ${ethers.formatUnits(result.previous, 18)} -> ${ethers.formatUnits(result.cumulativeAmount, 18)}`);
    console.log(`  VoucherRedeemed block ${result.blockNumber} submitted by ${result.submitter}`);
    console.log(`  tx ${x.links.tx(result.txHash)}`);
    console.log(`  claim ${result.claimId}`);
    console.log(`  resource ${JSON.stringify(result.resource)}`);
    const after = await x.readChannel();
    if (after.redeemed !== before.redeemed + result.amount) console.log(`  WARNING chain redeemed ${fmt(after.redeemed)} does not equal before + paid`);
  }

  // 4. refuse
  for (const sellerId of REFUSE) {
    const q = quotes[sellerId];
    console.log(`\n== ${sellerId}: expected refusal`);
    if (!q) { console.log('  no 402 to refuse'); continue; }
    const before = await x.readChannel();
    try {
      await x.buy({ resourceUrl: q.resourceUrl, maximumAmount: MAX_PRICE, operation: `x402-${sellerId}-refused-${Math.floor(Date.now() / 1000)}` });
      console.log(`  UNEXPECTED: purchase went through at ${fmt(q.price)}. Set PRICE_${sellerId.toUpperCase()} above ${fmt(MAX_PRICE)} on the sellers.`);
      process.exitCode = 3;
    } catch (error) {
      const after = await x.readChannel();
      console.log(`  refused: ${error.code ?? ''} ${error.message}`);
      console.log(`  channel redeemed before ${fmt(before.redeemed)} after ${fmt(after.redeemed)} ${after.redeemed === before.redeemed ? '(unchanged: nothing was signed or submitted)' : 'CHANGED!'}`);
      if (error.code !== 'price_above_max') console.log('  note: refused for another reason than price; check the sellers\' PRICE_* setting');
    }
  }

  // 5. record + settle
  if (bought.length) {
    console.log('\n== 5. record and settle');
    for (const r of bought) {
      const rec = await x.recordRedemption(r.txHash);
      console.log(`  record-redemption ${r.txHash.slice(0, 10)}… -> ${rec.ok ? 'ok' : `HTTP ${rec.status} ${rec.error ?? ''} (harmless if the service already settled this claim on its own)`}`);
    }
    const t0 = Date.now();
    const settled = await x.settle();
    console.log(`  settle took ${Math.round((Date.now() - t0) / 1000)} s, claims_settled ${settled.claimsSettled}`);
    console.log(`  payout tx ${x.links.tx(settled.payoutTx)}`);
    console.log(`  settlement tx ${x.links.tx(settled.settlementTx)}`);
    for (const r of settled.receipts) console.log(`  receipt ${r.claimId.slice(0, 10)}… ${r.amountRlusd} RLUSD ${r.receiptUrl ?? '(not published yet)'}`);
  }

  const end = await x.readChannel();
  const balanceAfter = await x.merchantBalance(end.payout);
  console.log(`\nAFTER   cap ${fmt(end.cap)}  redeemed ${fmt(end.redeemed)}  merchant payout holds ${fmt(balanceAfter)} (${balanceAfter >= balanceBefore ? '+' : ''}${ethers.formatUnits(balanceAfter - balanceBefore, 18)})`);
  console.log(`channel left ${end.status}. This script never opens or closes a channel.`);
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
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}
