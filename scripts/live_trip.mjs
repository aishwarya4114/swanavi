/**
 * Trip-channel experiment on the stray open channel. You run this. It is not a mock.
 *
 * Story: one channel for a trip. Booking 1 is delivered: pay 0.01 RLUSD. Booking 2 is
 * delivered: pay 0.01 more, as a cumulative voucher of 0.02. Booking 3 is cancelled: nothing
 * is signed. Then settle (merchant gets paid, receipt published) and close (unused cap
 * returns to the budget, vault event PayoutClosed).
 *
 * What it sends, from the agent wallet (gas in XRP):
 *   - redeemVoucher for cumulative 0.01 RLUSD   (skipped if the chain already shows >= 0.01)
 *   - redeemVoucher for cumulative 0.02 RLUSD   (skipped if the chain already shows >= 0.02)
 * Everything else is a service call (sign-in message, record-redemption, settle, close checkpoint).
 * Rerunning after a failure resumes from the on-chain redeemed amount; it never pays twice.
 *
 * Hard limits in this file: channel is fixed; MAX_PAYOUT is 0.02 RLUSD; every outgoing
 * transaction is decoded before it leaves and refused unless it is redeemVoucher on this
 * channel for at most MAX_PAYOUT. Environment variables cannot raise these.
 *
 * Order matters: settle must succeed before close, so the merchant payout is never raced by
 * the vault returning the cap. If settle fails the channel is left open and the script says so.
 *
 * KEEP_OPEN=1 stops after settle and leaves the channel open for later experiments (x402).
 * Close it afterwards with close_channel.mjs. This flag defers the close; it raises no limit.
 *
 * Run in your own terminal:
 *   AGENT_PRIVATE_KEY=0x... node live_trip.mjs      (the exact command is in PROGRESS.md, "Run commands")
 * Offline test of the transaction guard (no network, no key):
 *   node --test test/trip-guard.test.mjs
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const { signIn, signVoucher, settle, closeChannel, PAYMENT_LEDGER_ABI } = require('../ap4m-hackathon-sdk.js');

const API_URL = process.env.AP4M_API_URL || 'https://hackathon.ap4m.build';
const TEAM_NAME = process.env.TEAM_NAME || 'Swanavi';
const CHANNEL_ID = '0x14dc20af40d782b2a80ccb4bfa5cdecd6faf6c441c26d63d1fbe0af7980762c0';
const EXPECTED_AGENT = '0x5492fd1F22C6eFE98F1b9C2237091A6A621ce153';
const DEPOSIT_BLOCK = 9224767; // vault DepositReserved for our 20 RLUSD; PayoutClosed sums start here
const EXPLORER = 'https://explorer.testnet.xrplevm.org';
const MAX_PAYOUT = ethers.parseUnits('0.02', 18);

const BOOKINGS = [
  { name: 'Booking 1 (delivered)', price: ethers.parseUnits('0.01', 18), outcome: 'deliver' },
  { name: 'Booking 2 (delivered)', price: ethers.parseUnits('0.01', 18), outcome: 'deliver' },
  { name: 'Booking 3 (cancelled)', price: ethers.parseUnits('0.01', 18), outcome: 'cancel' },
];

const LEDGER_ABI = [
  ...PAYMENT_LEDGER_ABI,
  'function channels(bytes32) view returns (bytes32 allocationId,bytes32 merchantPspId,bytes32 requestDigest,bytes32 authorityAttestationId,bytes32 merchantAttestationId,bytes32 merchantId,bytes32 latestVoucherDigest,uint256 cap,uint256 redeemed,address agent,uint64 allocationGeneration,uint8 status,address payout,uint64 merchantGeneration,address merchantPspSigner,uint64 merchantPspSignerGeneration,uint64 validAfter,uint64 validBefore)',
  'function agentAllocations(bytes32) view returns (bytes32 agentPspId,bytes32 agentParticipantIdHash,bytes32 authorityCommitment,bytes32 scopeCommitment,bytes32 authorityAttestationId,address agent,uint256 cap,uint256 reserved,uint256 spent,uint64 validAfter,uint64 validBefore,uint64 generation,uint8 status)',
  'event VoucherRedeemed(bytes32 indexed channelId,bytes32 indexed claimId,bytes32 indexed voucherDigest,bytes32 allocationId,address agent,bytes32 merchantId,address payout,address submitter,uint256 previousCumulativeAmount,uint256 cumulativeAmount,uint256 amount)',
];
const VAULT_ABI = [
  'function payoutIdByChannel(bytes32) view returns (bytes32)',
  'function payoutBinding(bytes32) view returns ((bytes32 reservationId,bytes32 channelId,bytes32 merchantPspId,bytes32 merchantId,address payout,uint256 cap,uint256 available,uint256 disbursed,uint256 returned,uint256 executionCount,uint64 boundAt,uint8 status))',
  'function reservation(bytes32) view returns ((bytes32 accountId,bytes32 allocationId,bytes32 authorityCommitment,bytes32 scopeCommitment,bytes32 depositOperationId,uint256 amount,uint256 unassigned,uint256 activePayoutCapacity,uint256 disbursed,uint256 released,uint32 payoutBindingCount,uint32 activePayouts,uint64 validAfter,uint64 allocationValidBefore,uint64 bindingValidBefore,uint8 status))',
  'event PayoutClosed(bytes32 indexed payoutId,bytes32 indexed reservationId,bytes32 indexed operationId,uint256 returned)',
  'event ClaimPaid(bytes32 indexed claimId,bytes32 indexed payoutId,bytes32 indexed channelId,address payout,uint256 amount,uint256 cumulativeDisbursed,uint64 paidAt)',
];

const f = (wei) => ethers.formatUnits(wei, 18);
const txLink = (hash) => `${EXPLORER}/tx/${hash}`;

/**
 * Decode a signed raw transaction and refuse it unless it is redeemVoucher, to the ledger,
 * on the expected channel, for a cumulative amount of at most maxPayout, with zero value.
 * Returns { cumulativeAmount } when allowed; throws otherwise. Pure; no network.
 */
export function checkOutgoingTransaction(rawTransaction, { ledgerAddress, channelId, maxPayout }) {
  const parsed = ethers.Transaction.from(rawTransaction);
  if ((parsed.to ?? '').toLowerCase() !== ledgerAddress.toLowerCase()) throw new Error(`Blocked: transaction to ${parsed.to}, not the ledger.`);
  if (parsed.value !== 0n) throw new Error('Blocked: transaction carries value.');
  const iface = new ethers.Interface(PAYMENT_LEDGER_ABI);
  let call = null;
  try { call = iface.parseTransaction({ data: parsed.data }); } catch { call = null; }
  if (!call || call.name !== 'redeemVoucher') throw new Error(`Blocked: ${call?.name ?? 'unknown call'} is not redeemVoucher.`);
  const [voucher] = call.args;
  if (voucher.channelId.toLowerCase() !== channelId.toLowerCase()) throw new Error('Blocked: voucher is for another channel.');
  if (voucher.cumulativeAmount > maxPayout) throw new Error(`Blocked: cumulative ${f(voucher.cumulativeAmount)} is above MAX_PAYOUT ${f(maxPayout)}.`);
  return { cumulativeAmount: voucher.cumulativeAmount };
}
const links = [];
function note(step, hash, detail = '') {
  if (!hash) return;
  links.push({ step, hash, detail });
  console.log(`   ${step}: ${txLink(hash)} ${detail}`);
}

async function main() {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) {
    console.error('Set AGENT_PRIVATE_KEY in the environment. This file does not read a key file.');
    process.exit(1);
  }
  const wallet = new ethers.Wallet(key);
  if (wallet.address.toLowerCase() !== EXPECTED_AGENT.toLowerCase()) {
    console.error(`This key is for ${wallet.address}, not the agent wallet ${EXPECTED_AGENT}. Stopping.`);
    process.exit(1);
  }

  const config = await (await fetch(`${API_URL}/public/config`)).json();
  const rpcUrl = process.env.AP4M_RPC_URL || config.network.rpcUrl;
  const ledgerAddress = config.contracts.paymentLedger;
  const vaultAddress = config.contracts.pooledEscrowVault;
  const tokenAddress = config.contracts.rlusdToken;
  console.log('Agent address:', wallet.address);
  console.log('RPC:', rpcUrl, ' Ledger:', ledgerAddress, ' Vault:', vaultAddress);
  console.log('Channel:', CHANNEL_ID);
  console.log('Maximum total payout this script can sign:', f(MAX_PAYOUT), 'RLUSD');

  // Guarded provider: every outgoing transaction is decoded and must be redeemVoucher on this
  // channel for at most MAX_PAYOUT, addressed to the ledger. Anything else is refused.
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1449000, { staticNetwork: true });
  const rawSend = provider.send.bind(provider);
  provider.send = async (method, params) => {
    if (method === 'eth_sendTransaction') throw new Error('Blocked eth_sendTransaction.');
    if (method === 'eth_sendRawTransaction') {
      checkOutgoingTransaction(params[0], { ledgerAddress, channelId: CHANNEL_ID, maxPayout: MAX_PAYOUT });
    }
    return rawSend(method, params);
  };
  const signer = wallet.connect(provider);
  const ledger = new ethers.Contract(ledgerAddress, LEDGER_ABI, signer);
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
  const token = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);

  // Channel must be ours, open, and small enough that cap is not a question.
  const channel = await ledger.channels(CHANNEL_ID);
  if (Number(channel.status) !== 1) { console.error(`Channel status is ${channel.status}, not open. Stopping.`); process.exit(1); }
  if (channel.agent.toLowerCase() !== wallet.address.toLowerCase()) { console.error(`Channel agent is ${channel.agent}, not this wallet. Stopping.`); process.exit(1); }
  if (channel.redeemed > MAX_PAYOUT) { console.error(`Channel already redeemed ${f(channel.redeemed)}, above MAX_PAYOUT. Stopping.`); process.exit(1); }
  const payoutId = await vault.payoutIdByChannel(CHANNEL_ID);
  const binding = await vault.payoutBinding(payoutId);
  const reservationId = binding.reservationId;
  const merchantPayout = channel.payout;
  console.log('Merchant payout wallet for this channel:', merchantPayout);
  console.log('Vault payoutId:', payoutId, ' reservationId:', reservationId);

  const before = await snapshot('BEFORE', { ledger, vault, token, channel, reservationId, payoutId, allocationId: channel.allocationId, merchantPayout, provider });

  console.log('\n== Sign in (message signature only)');
  let session = await signIn(API_URL, TEAM_NAME, wallet);
  console.log('   signed in');

  // Bookings. cumulative is the running total of delivered bookings.
  console.log('\n== Bookings');
  let cumulative = 0n;
  const claims = [];
  for (const booking of BOOKINGS) {
    if (booking.outcome !== 'deliver') {
      console.log(`   ${booking.name}: price ${f(booking.price)}. Seller cancelled. NO voucher signed. Nothing sent.`);
      continue;
    }
    cumulative += booking.price;
    if (cumulative > MAX_PAYOUT) { console.error('   Would exceed MAX_PAYOUT. Stopping before signing.'); process.exit(1); }
    if (cumulative > channel.cap) { console.error('   Would exceed the channel cap. Stopping before signing.'); process.exit(1); }
    const onChain = (await ledger.channels(CHANNEL_ID)).redeemed;
    if (onChain >= cumulative) {
      console.log(`   ${booking.name}: chain already shows redeemed ${f(onChain)} >= ${f(cumulative)}. Already paid in an earlier run. Skipping.`);
      continue;
    }
    if (onChain !== cumulative - booking.price) {
      console.error(`   ${booking.name}: chain shows redeemed ${f(onChain)}, expected ${f(cumulative - booking.price)}. Stopping before signing.`);
      process.exit(1);
    }
    console.log(`   ${booking.name}: price ${f(booking.price)}. Delivered. Signing cumulative ${f(cumulative)} and submitting...`);
    const started = Date.now();
    const signature = await signVoucher(signer, ledgerAddress, CHANNEL_ID, cumulative);
    const tx = await ledger.redeemVoucher({ channelId: CHANNEL_ID, cumulativeAmount: cumulative }, signature);
    const receipt = await tx.wait();
    const event = receipt.logs.map((log) => { try { return ledger.interface.parseLog(log); } catch { return null; } }).find((e) => e?.name === 'VoucherRedeemed');
    const claimId = event?.args.claimId ?? null;
    claims.push({ booking: booking.name, claimId, txHash: receipt.hash, amount: event?.args.amount ?? booking.price });
    console.log(`   mined in ${Date.now() - started} ms, block ${receipt.blockNumber}, amount ${event ? f(event.args.amount) : '?'}, claimId ${claimId}`);
    note(`VoucherRedeemed ${booking.name}`, receipt.hash, `(agent paid ${f(booking.price)} RLUSD, running total ${f(cumulative)})`);
    const record = await fetch(`${API_URL}/public/participant/record-redemption`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ tx_hash: receipt.hash }),
    });
    const recorded = await record.json().catch(() => ({}));
    console.log(`   record-redemption: HTTP ${record.status}${recorded.claim_id ? `, claim ${recorded.claim_id}` : ''}${recorded.error ? `, ${recorded.error}` : ''}`);
  }
  const redeemedNow = (await ledger.channels(CHANNEL_ID)).redeemed;
  console.log(`   On-chain redeemed is now ${f(redeemedNow)} RLUSD. Cancelled booking: 0 signed, 0 moved.`);

  // Settle first. The merchant must be paid before the cap is returned.
  console.log('\n== Settle (service pays the merchant from the vault, records settlement, publishes receipts)');
  let settled;
  try {
    const started = Date.now();
    settled = await settle(API_URL, session.token, CHANNEL_ID);
    console.log(`   settled in ${Date.now() - started} ms; claims_settled: ${settled.claims_settled}, amount_rlusd: ${settled.amount_rlusd}, recipient: ${settled.recipient}`);
    note('ClaimPaid (vault payout to merchant)', settled.payout_tx);
    note('SettlementRecorded (ledger)', settled.settlement_tx);
    for (const receipt of settled.receipts ?? []) {
      console.log(`   receipt: claim ${receipt.claim_id} ${receipt.amount_rlusd} RLUSD -> ${receipt.receipt_url ?? '(not published yet)'}`);
    }
    if (settled.receipt_url) console.log('   latest receipt:', settled.receipt_url.startsWith('http') ? settled.receipt_url : API_URL + settled.receipt_url);
  } catch (error) {
    console.error('   SETTLE FAILED:', clip(error));
    console.error('   The channel is left OPEN on purpose. Rerun this script later; paid bookings are skipped and it goes straight to settle and close.');
    process.exitCode = 1;
    await snapshot('AFTER (not closed)', { ledger, vault, token, channel, reservationId, payoutId, allocationId: channel.allocationId, merchantPayout, provider }, before);
    return;
  }

  if (process.env.KEEP_OPEN === '1') {
    console.log('\n== KEEP_OPEN=1: channel left OPEN on purpose for later experiments.');
    console.log('   Close it later with: AGENT_PRIVATE_KEY=... node close_channel.mjs');
    await snapshot('AFTER (settled, still open)', { ledger, vault, token, channel, reservationId, payoutId, allocationId: channel.allocationId, merchantPayout, provider }, before);
    console.log('\n== Explorer links, in order');
    for (const entry of links) console.log(`   ${entry.step}: ${txLink(entry.hash)} ${entry.detail}`);
    return;
  }

  // Close: service signs the final checkpoint with us, sends ChannelClosed, then closes the vault payout.
  console.log('\n== Close channel (unused cap should return to the budget)');
  const closeStarted = Date.now();
  let closed;
  try {
    closed = await closeChannel(API_URL, session.token, wallet, CHANNEL_ID);
  } catch (error) {
    console.log('   first close attempt failed, signing in again:', clip(error));
    session = await signIn(API_URL, TEAM_NAME, wallet);
    closed = await closeChannel(API_URL, session.token, wallet, CHANNEL_ID);
  }
  console.log(`   close accepted in ${Date.now() - closeStarted} ms; final cumulative amount: ${closed.final_cumulative_amount ?? '?'}`);
  note('ChannelClosed (ledger)', closed.tx_hash);
  const closeReceipt = closed.tx_hash ? await waitForReceipt(provider, closed.tx_hash) : null;
  const fromBlock = closeReceipt ? closeReceipt.blockNumber - 2 : (await provider.getBlockNumber()) - 20;
  console.log('   waiting for the vault PayoutClosed event (up to 3 minutes)...');
  const payoutClosed = await waitForPayoutClosed(vault, payoutId, fromBlock);
  if (payoutClosed) {
    console.log(`   PayoutClosed after ${Date.now() - closeStarted} ms: returned ${f(payoutClosed.args.returned)} RLUSD`);
    note('PayoutClosed (vault returns unused cap)', payoutClosed.txHash, `(returned ${f(payoutClosed.args.returned)} RLUSD)`);
  } else {
    console.log('   PayoutClosed not seen within 3 minutes. Run `node chain_inspect.mjs` later; the vault may still emit it.');
  }

  const after = await snapshot('AFTER', { ledger, vault, token, channel, reservationId, payoutId, allocationId: channel.allocationId, merchantPayout, provider }, before);

  console.log('\n== Summary');
  console.log(`   Paid to merchant (vault disbursed delta): ${f(after.disbursed - before.disbursed)} RLUSD  (expected 0.02)`);
  console.log(`   Returned to budget (PayoutClosed sum delta): ${f(after.returnedSum - before.returnedSum)} RLUSD  (expected 1.98)`);
  console.log(`   Free budget (unassigned) delta: ${f(after.unassigned - before.unassigned)} RLUSD  (expected +1.98)`);
  console.log(`   Locked (activePayoutCapacity) delta: ${f(after.locked - before.locked)} RLUSD  (expected -2.0)`);
  console.log(`   Merchant wallet RLUSD delta: ${f(after.merchantBalance - before.merchantBalance)} RLUSD  (expected +0.02)`);
  console.log(`   Cancelled booking: nothing signed, nothing moved.`);
  console.log('\n== Explorer links, in order');
  for (const entry of links) console.log(`   ${entry.step}: ${txLink(entry.hash)} ${entry.detail}`);
}

async function snapshot(label, { ledger, vault, token, channel, reservationId, payoutId, allocationId, merchantPayout, provider }, before) {
  const [ch, alloc, resv, binding, merchantBalance, head] = await Promise.all([
    ledger.channels(CHANNEL_ID), ledger.agentAllocations(allocationId), vault.reservation(reservationId),
    vault.payoutBinding(payoutId), token.balanceOf(merchantPayout), provider.getBlockNumber(),
  ]);
  const returnedSum = await sumPayoutClosed(vault, reservationId, head);
  const s = {
    block: head, channelStatus: Number(ch.status), channelRedeemed: ch.redeemed, cap: ch.cap,
    locked: resv.activePayoutCapacity, disbursed: resv.disbursed, unassigned: resv.unassigned, amount: resv.amount,
    bindingStatus: Number(binding.status), bindingReturned: binding.returned, bindingDisbursed: binding.disbursed,
    allocReserved: alloc.reserved, allocSpent: alloc.spent, returnedSum, merchantBalance,
  };
  const d = (k) => before ? `  (was ${f(before[k])})` : '';
  console.log(`\n== ${label}  (block ${head})`);
  console.log(`   channel: status ${s.channelStatus} (1 open, 2 closed), cap ${f(s.cap)}, redeemed ${f(s.channelRedeemed)}${before ? `  (was ${f(before.channelRedeemed)})` : ''}`);
  console.log(`   budget reservation (20 RLUSD): locked ${f(s.locked)}${d('locked')}, disbursed ${f(s.disbursed)}${d('disbursed')}, unassigned ${f(s.unassigned)}${d('unassigned')}`);
  console.log(`   sum of PayoutClosed.returned since deposit: ${f(s.returnedSum)}${d('returnedSum')}`);
  console.log(`   this channel's vault payout: status ${s.bindingStatus} (1 active, 2 closed), disbursed ${f(s.bindingDisbursed)}, returned ${f(s.bindingReturned)}`);
  console.log(`   ledger allocation: reserved ${f(s.allocReserved)}${d('allocReserved')}, spent ${f(s.allocSpent)}${d('allocSpent')}`);
  console.log(`   merchant payout wallet RLUSD: ${f(s.merchantBalance)}${d('merchantBalance')}`);
  return s;
}

async function sumPayoutClosed(vault, reservationId, head) {
  const topics = await vault.filters.PayoutClosed(null, reservationId).getTopicFilter();
  let sum = 0n;
  for (let b = DEPOSIT_BLOCK; b <= head; b += 2000) {
    const logs = await vault.runner.provider.getLogs({ address: vault.target, topics, fromBlock: b, toBlock: Math.min(b + 1999, head) });
    for (const log of logs) sum += vault.interface.parseLog(log).args.returned;
  }
  return sum;
}

async function waitForPayoutClosed(vault, payoutId, fromBlock) {
  const topics = await vault.filters.PayoutClosed(payoutId).getTopicFilter();
  const provider = vault.runner.provider;
  for (let attempt = 0; attempt < 36; attempt++) {
    const logs = await provider.getLogs({ address: vault.target, topics, fromBlock, toBlock: 'latest' });
    if (logs.length) return { ...vault.interface.parseLog(logs[0]), txHash: logs[0].transactionHash };
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return null;
}

async function waitForReceipt(provider, hash) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}

function clip(error) {
  const text = String(error?.shortMessage ?? error?.message ?? error).replace(/0x[0-9a-fA-F]{100,}/g, '0x[redacted]');
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
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
    console.error(clip(error));
    process.exitCode = 1;
  });
}
