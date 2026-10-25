/**
 * Close one of our channels. You run this. It is not a mock.
 *
 * Sends no transaction from the agent wallet. The agent wallet signs the service's close
 * checkpoint (not a payment voucher); the service sends ChannelClosed on the ledger and then
 * closes the vault payout, which returns the unused cap to the budget (vault PayoutClosed).
 *
 * If the channel has redeemed vouchers that are not settled yet, this settles them first so the
 * merchant payout is never raced by the cap being returned. If settle fails, nothing is closed.
 *
 * Default channel is the stray one. Pass another as CHANNEL_ID=0x... if needed.
 *
 * Run in your own terminal:
 *   AGENT_PRIVATE_KEY=0x... node close_channel.mjs      (the exact command is in PROGRESS.md, "Run commands")
 */

import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const { signIn, listChannels, settle, closeChannel } = require('../ap4m-hackathon-sdk.js');

const API_URL = process.env.AP4M_API_URL || 'https://hackathon.ap4m.build';
const TEAM_NAME = process.env.TEAM_NAME || 'Swanavi';
const CHANNEL_ID = (process.env.CHANNEL_ID || '0x14dc20af40d782b2a80ccb4bfa5cdecd6faf6c441c26d63d1fbe0af7980762c0').toLowerCase();
const EXPECTED_AGENT = '0x5492fd1F22C6eFE98F1b9C2237091A6A621ce153';
const EXPLORER = 'https://explorer.testnet.xrplevm.org';

const LEDGER_ABI = [
  'function channels(bytes32) view returns (bytes32 allocationId,bytes32 merchantPspId,bytes32 requestDigest,bytes32 authorityAttestationId,bytes32 merchantAttestationId,bytes32 merchantId,bytes32 latestVoucherDigest,uint256 cap,uint256 redeemed,address agent,uint64 allocationGeneration,uint8 status,address payout,uint64 merchantGeneration,address merchantPspSigner,uint64 merchantPspSignerGeneration,uint64 validAfter,uint64 validBefore)',
];
const VAULT_ABI = [
  'function payoutIdByChannel(bytes32) view returns (bytes32)',
  'function payoutBinding(bytes32) view returns ((bytes32 reservationId,bytes32 channelId,bytes32 merchantPspId,bytes32 merchantId,address payout,uint256 cap,uint256 available,uint256 disbursed,uint256 returned,uint256 executionCount,uint64 boundAt,uint8 status))',
  'function reservation(bytes32) view returns ((bytes32 accountId,bytes32 allocationId,bytes32 authorityCommitment,bytes32 scopeCommitment,bytes32 depositOperationId,uint256 amount,uint256 unassigned,uint256 activePayoutCapacity,uint256 disbursed,uint256 released,uint32 payoutBindingCount,uint32 activePayouts,uint64 validAfter,uint64 allocationValidBefore,uint64 bindingValidBefore,uint8 status))',
  'event PayoutClosed(bytes32 indexed payoutId,bytes32 indexed reservationId,bytes32 indexed operationId,uint256 returned)',
];
const f = (wei) => ethers.formatUnits(wei, 18);

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
  const provider = new ethers.JsonRpcProvider(process.env.AP4M_RPC_URL || config.network.rpcUrl, 1449000, { staticNetwork: true });
  provider.send = ((orig) => async (m, p) => { if (/^eth_send/.test(m)) throw new Error('This script sends no transaction.'); return orig(m, p); })(provider.send.bind(provider));
  const ledger = new ethers.Contract(config.contracts.paymentLedger, LEDGER_ABI, provider);
  const vault = new ethers.Contract(config.contracts.pooledEscrowVault, VAULT_ABI, provider);

  console.log('Agent address:', wallet.address);
  console.log('Channel:', CHANNEL_ID);
  const channel = await ledger.channels(CHANNEL_ID);
  console.log('On chain: status', Number(channel.status), '(1 open, 2 closed)  cap', f(channel.cap), ' redeemed', f(channel.redeemed), ' agent', channel.agent);
  if (Number(channel.status) !== 1) { console.log('Not open. Nothing to do.'); return; }
  if (channel.agent.toLowerCase() !== wallet.address.toLowerCase()) { console.error('Not our channel. Stopping.'); process.exit(1); }
  const payoutId = await vault.payoutIdByChannel(CHANNEL_ID);
  const binding = await vault.payoutBinding(payoutId);
  const resvBefore = await vault.reservation(binding.reservationId);
  console.log('Vault payout: disbursed', f(binding.disbursed), ' of redeemed', f(channel.redeemed), ' cap', f(binding.cap));
  console.log('Budget before: locked', f(resvBefore.activePayoutCapacity), ' disbursed', f(resvBefore.disbursed), ' unassigned', f(resvBefore.unassigned));

  let session = await signIn(API_URL, TEAM_NAME, wallet);
  const listed = (await listChannels(API_URL, session.token)).find((c) => c.channel_id.toLowerCase() === CHANNEL_ID);
  console.log('Service status:', listed?.channel_status ?? 'not listed');

  if (channel.redeemed > binding.disbursed) {
    console.log(`\n== Settle first: ${f(channel.redeemed - binding.disbursed)} RLUSD redeemed but not yet paid out`);
    try {
      const settled = await settle(API_URL, session.token, CHANNEL_ID);
      console.log('   settled; payout tx', settled.payout_tx ? `${EXPLORER}/tx/${settled.payout_tx}` : null);
      for (const receipt of settled.receipts ?? []) console.log(`   receipt: ${receipt.claim_id} ${receipt.amount_rlusd} RLUSD -> ${receipt.receipt_url ?? '(pending)'}`);
    } catch (error) {
      console.error('   SETTLE FAILED:', clip(error), '\n   Not closing. Try again in a minute.');
      process.exit(1);
    }
  }

  console.log('\n== Close');
  const started = Date.now();
  let closed;
  try {
    closed = await closeChannel(API_URL, session.token, wallet, CHANNEL_ID);
  } catch (error) {
    console.log('   first attempt failed, signing in again:', clip(error));
    session = await signIn(API_URL, TEAM_NAME, wallet);
    closed = await closeChannel(API_URL, session.token, wallet, CHANNEL_ID);
  }
  console.log(`   accepted in ${Date.now() - started} ms; final cumulative amount ${closed.final_cumulative_amount ?? '?'}`);
  console.log('   ChannelClosed:', closed.tx_hash ? `${EXPLORER}/tx/${closed.tx_hash}` : null);

  console.log('   waiting for vault PayoutClosed (up to 3 minutes)...');
  const topics = await vault.filters.PayoutClosed(payoutId).getTopicFilter();
  const fromBlock = (await provider.getBlockNumber()) - 10;
  let seen = null;
  for (let attempt = 0; attempt < 36 && !seen; attempt++) {
    const logs = await provider.getLogs({ address: vault.target, topics, fromBlock, toBlock: 'latest' });
    if (logs.length) seen = { returned: vault.interface.parseLog(logs[0]).args.returned, tx: logs[0].transactionHash };
    else await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (seen) console.log(`   PayoutClosed: returned ${f(seen.returned)} RLUSD  ${EXPLORER}/tx/${seen.tx}`);
  else console.log('   PayoutClosed not seen yet. Run node chain_inspect.mjs later.');

  const resvAfter = await vault.reservation(binding.reservationId);
  console.log('\nBudget after: locked', f(resvAfter.activePayoutCapacity), ' disbursed', f(resvAfter.disbursed), ' unassigned', f(resvAfter.unassigned));
  console.log('Change: locked', f(resvAfter.activePayoutCapacity - resvBefore.activePayoutCapacity), ' unassigned', `+${f(resvAfter.unassigned - resvBefore.unassigned)}`);
}

function clip(error) {
  const text = String(error?.shortMessage ?? error?.message ?? error).replace(/0x[0-9a-fA-F]{100,}/g, '0x[redacted]');
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

main().catch((error) => {
  console.error(clip(error));
  process.exitCode = 1;
});
