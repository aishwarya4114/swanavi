/**
 * OPENS A CHANNEL. One of the three remaining openings. Run only with CONFIRM_OPEN=yes after
 * the operator has decided which slot this is (rehearsal / demo / spare).
 *
 * The fresh channel that pays OUR merchant wallet 0x4581…1Ce0C:
 *
 *   0. read our merchant wallet's RLUSD and XRP (BEFORE)
 *   1. sign in; refuse to continue unless /public/participant/me says the team's merchant payout
 *      is our wallet and not the pool (so the slot is never spent on a channel to the pool)
 *   2. requestChannel with cap CAP (default 0.10 RLUSD): one vault transaction from the agent
 *      wallet (gas in XRP), then wait for the service to bind the payout and open it
 *   3. refuse to pay unless the open channel's payout == our wallet (on chain)
 *   4. pay PAY (default 0.01; PAY=0 skips) with one cumulative voucher through the guarded executor
 *   5. record-redemption, settle, wait until our wallet's RLUSD balance rises, print AFTER and delta
 *   6. leave the channel OPEN (this is the point) and print the TRIP_CHANNEL_ID line for the server
 *
 * Costs: CAP is reserved from the 17 RLUSD free budget until the channel closes (then returned);
 * PAY leaves the budget for good; two transactions' gas from the agent wallet.
 *
 *   AGENT_PRIVATE_KEY=0x... CONFIRM_OPEN=yes [CAP=0.10] [PAY=0.01] node live_merchant_channel.mjs
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';
import { createExecutorFromEnv } from '../ap4m_executor.mjs';
import { OUR_MERCHANT_WALLET, readBalances } from './merchant_status.mjs';

const require = createRequire(import.meta.url);
const sdk = require('../ap4m-hackathon-sdk.js');

const API = process.env.AP4M_API_URL || 'https://hackathon.ap4m.build';
const CAP = process.env.CAP || '0.10';
const PAY = ethers.parseUnits(process.env.PAY || '0.01', 18);
const MAX_PAY = ethers.parseUnits('0.02', 18);
const fmt = (wei) => `${ethers.formatUnits(wei, 18)} RLUSD`;

async function main() {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) throw new Error('Set AGENT_PRIVATE_KEY.');
  if (ethers.parseUnits(CAP, 18) > ethers.parseUnits('1', 18)) throw new Error(`CAP ${CAP} is above 1 RLUSD; not without a decision.`);
  if (PAY > MAX_PAY) throw new Error('PAY above 0.02 is not allowed by this script.');

  const config = await (await fetch(`${API}/public/config`)).json();
  const provider = new ethers.JsonRpcProvider(process.env.AP4M_RPC_URL || config.network.rpcUrl, Number(config.network.chainId || 1449000), { staticNetwork: true });
  const explorer = config.network.explorerUrl || 'https://explorer.testnet.xrplevm.org';
  const agent = new ethers.Wallet(key, provider);
  console.log(`agent ${agent.address}  merchant wallet ${OUR_MERCHANT_WALLET}`);

  // 0. BEFORE
  const before = await readBalances(provider, config.contracts.rlusdToken, OUR_MERCHANT_WALLET);
  console.log(`BEFORE  our merchant wallet: ${fmt(before.rlusd)}, ${ethers.formatEther(before.xrp)} XRP`);

  // 1. the team's merchant must be ours
  const session = await sdk.signIn(API, process.env.TEAM_NAME || 'Swanavi', agent);
  const headers = { Authorization: `Bearer ${session.token}` };
  const me = await (await fetch(`${API}/public/participant/me`, { headers })).json();
  const team = me.team ?? me;
  console.log(`service: merchant id ${team.merchant_id ?? '(none)'}, payout ${team.merchant_wallet ?? '(none)'}, pool ${team.merchant_is_pool}`);
  if ((team.merchant_wallet ?? '').toLowerCase() !== OUR_MERCHANT_WALLET.toLowerCase() || team.merchant_is_pool !== false) {
    throw new Error('The team\'s merchant payout is not our wallet yet. Register it first (portal "Add my wallet" or register_merchant.mjs). No channel opened.');
  }
  const open = (await sdk.listChannels(API, session.token)).filter((c) => c.channel_status === 'open');
  console.log(`open channels now: ${open.length} (${open.map((c) => c.channel_id.slice(0, 10) + '…').join(', ') || 'none'}); the vault allows 3 at once`);
  if (open.length >= 3) throw new Error('3 channels are already open; close one first (close_channel.mjs). No channel opened.');

  if (process.env.CONFIRM_OPEN !== 'yes') {
    console.log(`\nDry run. Would open a channel with cap ${CAP} RLUSD to merchant ${team.merchant_id} paying ${OUR_MERCHANT_WALLET}, then pay ${fmt(PAY)}.`);
    console.log('Re-run with CONFIRM_OPEN=yes to do it. This uses one of the remaining openings.');
    return;
  }

  // 2. open
  console.log(`\nopening a channel with cap ${CAP} RLUSD (one vault tx from the agent wallet, then the service binds and opens)…`);
  const t0 = Date.now();
  const channel = await sdk.requestChannel(API, session.token, agent, { capRlusd: CAP, merchantId: team.merchant_id });
  console.log(`channel ${channel.channel_id} ${channel.channel_status} after ${Math.round((Date.now() - t0) / 1000)} s; service says payout ${channel.payout}, merchant ${channel.merchant_id}`);

  // 3. on-chain payout check before any payment
  const x = await createExecutorFromEnv({ ...process.env, TRIP_CHANNEL_ID: channel.channel_id }, { log() {}, warn: console.warn, error: console.error });
  const onChain = await x.readChannel();
  console.log(`on chain: status ${onChain.status}, cap ${fmt(onChain.cap)}, payout ${onChain.payout}, opened ${x.links.tx(onChain.openedTx)}`);
  if (onChain.payout.toLowerCase() !== OUR_MERCHANT_WALLET.toLowerCase()) {
    throw new Error(`The channel pays ${onChain.payout}, not our wallet. Not paying anything. Close it with CHANNEL_ID=${channel.channel_id} node close_channel.mjs`);
  }
  console.log(`\nTRIP_CHANNEL_ID=${channel.channel_id}`);
  if (PAY === 0n) { console.log('PAY=0: channel left open, nothing paid.'); return; }

  // 4. pay
  const paid = await x.redeem({ cumulativeAmount: PAY, expectedPrevious: 0n });
  console.log(`paid ${fmt(paid.amount)}: VoucherRedeemed block ${paid.blockNumber} ${x.links.tx(paid.txHash)}  claim ${paid.claimId}`);

  // 5. record, settle, watch the balance
  const rec = await x.recordRedemption(paid.txHash);
  console.log(`record-redemption -> ${rec.ok ? 'ok' : `HTTP ${rec.status} ${rec.error ?? ''}`}`);
  const t1 = Date.now();
  const settled = await x.settle();
  console.log(`settle took ${Math.round((Date.now() - t1) / 1000)} s, claims_settled ${settled.claimsSettled}, payout tx ${x.links.tx(settled.payoutTx)}`);
  for (const r of settled.receipts) console.log(`receipt ${r.claimId.slice(0, 10)}… ${r.amountRlusd} RLUSD ${r.receiptUrl ?? '(not published yet)'}`);
  let after = await readBalances(provider, config.contracts.rlusdToken, OUR_MERCHANT_WALLET);
  for (let i = 0; i < 20 && after.rlusd <= before.rlusd; i++) {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    after = await readBalances(provider, config.contracts.rlusdToken, OUR_MERCHANT_WALLET);
  }
  console.log(`AFTER   our merchant wallet: ${fmt(after.rlusd)} (${after.rlusd >= before.rlusd ? '+' : ''}${ethers.formatUnits(after.rlusd - before.rlusd, 18)}), ${ethers.formatEther(after.xrp)} XRP   ${explorer}/address/${OUR_MERCHANT_WALLET}`);
  if (after.rlusd - before.rlusd !== paid.amount) console.log('NOTE: the balance change does not equal the payment yet; check again in a minute (settlement is the service\'s transaction).');
  const end = await x.readChannel();
  console.log(`channel ${channel.channel_id} left ${end.status}, cap ${fmt(end.cap)}, redeemed ${fmt(end.redeemed)}.`);
  console.log(`\nFor the server:  PAYMENTS_MODE=ap4m TRIP_CHANNEL_ID=${channel.channel_id} X402_SELLERS=http://127.0.0.1 …`);
  console.log(`For the sellers: MERCHANT_ID=${team.merchant_id} MERCHANT_PAYOUT=${OUR_MERCHANT_WALLET}`);
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
