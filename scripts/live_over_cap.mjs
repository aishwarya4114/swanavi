/**
 * Over-cap voucher test on the stray channel. You run this. It is not a mock.
 *
 * Method 3, as agreed: simulate first, broadcast only if the simulation reverted.
 *
 *   1. Print the PaymentLedger function list (evidence that nothing can raise a channel cap).
 *   2. Read the channel on chain: must be open, cap 2, redeemed 0, agent = this wallet.
 *   3. CONTROL: sign a valid in-cap voucher for cumulative 0.01 RLUSD and eth_call it. It must
 *      NOT revert. This is the same voucher live_trip.mjs will submit for booking 1, so
 *      the only exposure is 0.01 RLUSD we intend to pay anyway. It is not broadcast here.
 *      If the control reverts the test is inconclusive: exit 4, nothing broadcast.
 *   3b. Sign one voucher in memory for cap + 1 wei. Neither signature is printed or saved.
 *   4. eth_call redeemVoucher with it. If the call does NOT revert: loud warning, process.exit(3),
 *      nothing is broadcast. (The signature was seen by the public RPC node only.)
 *      Both call results are printed side by side so the revert is attributable to the cap.
 *   5. Re-read the channel. Abort unless it still reads open / cap 2 / redeemed 0 / agent ours.
 *   6. Broadcast the same calldata with a manual gasLimit so the revert is mined and visible on
 *      the explorer. Expected: status 0 (Fail). Cost: gas only.
 *   7. Re-read the channel. redeemed must still be 0.
 *
 * Replay note: if the chain rejects this voucher once it rejects it forever, because no ledger
 * function changes a channel's cap. If the simulation does not revert, we stop; the signature is
 * then worth at most this channel's 2 RLUSD cap and nothing else.
 *
 * Run in your own terminal:
 *   AGENT_PRIVATE_KEY=0x... node live_over_cap.mjs      (the exact command is in PROGRESS.md, "Run commands")
 */

import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const { signVoucher, PAYMENT_LEDGER_ABI } = require('../ap4m-hackathon-sdk.js');

const API_URL = process.env.AP4M_API_URL || 'https://hackathon.ap4m.build';
const CHANNEL_ID = '0x14dc20af40d782b2a80ccb4bfa5cdecd6faf6c441c26d63d1fbe0af7980762c0';
const EXPECTED_AGENT = '0x5492fd1F22C6eFE98F1b9C2237091A6A621ce153';
const EXPECTED_CAP = ethers.parseUnits('2', 18);
const CONTROL_AMOUNT = ethers.parseUnits('0.01', 18); // booking 1 of live_trip.mjs
const GAS_LIMIT = 250_000n; // run 1's successful redeem used 164,199
const EXPLORER = 'https://explorer.testnet.xrplevm.org';

// Every function on the PaymentLedger, copied from the AP4M SDK package,
// dist/payment-ledger.js lines 131-158 (PAYMENT_LEDGER_ABI and the view ABI).
const LEDGER_FUNCTIONS = [
  'recordAllocationAuthorityAttestations', 'setAllocationAuthorityAttestationStatus',
  'emergencySuspendAllocationAuthorityAttestation', 'emergencySuspendAgentAllocation',
  'publishAllocationRoot', 'applyAgentAllocations', 'setAgentAllocationStatus',
  'openChannel', 'closeChannel', 'redeemVoucher', 'redeemDynamicVoucher', 'recordSettlement',
  // views
  'participantRegistry', 'participantRegistryCodeHash', 'registryConfigurationId', 'deploymentId',
  'activeAllocationRoot', 'agentAllocations', 'currentAllocationAuthorityAttestationGeneration',
  'allocationAuthorityAttestationRecords', 'channels', 'claims', 'availableAgentCapacity',
];

const CHANNELS_ABI = [
  'function channels(bytes32) view returns (bytes32 allocationId,bytes32 merchantPspId,bytes32 requestDigest,bytes32 authorityAttestationId,bytes32 merchantAttestationId,bytes32 merchantId,bytes32 latestVoucherDigest,uint256 cap,uint256 redeemed,address agent,uint64 allocationGeneration,uint8 status,address payout,uint64 merchantGeneration,address merchantPspSigner,uint64 merchantPspSignerGeneration,uint64 validAfter,uint64 validBefore)',
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
  const rpcUrl = process.env.AP4M_RPC_URL || config.network.rpcUrl;
  const ledgerAddress = config.contracts.paymentLedger;
  console.log('Agent address:', wallet.address);
  console.log('RPC:', rpcUrl);
  console.log('Ledger:', ledgerAddress);
  console.log('Channel:', CHANNEL_ID);

  // Transactions are blocked until the simulation has reverted.
  let armed = false;
  const provider = new ethers.JsonRpcProvider(rpcUrl, 1449000, { staticNetwork: true });
  const rawSend = provider.send.bind(provider);
  provider.send = async (method, params) => {
    if (/^eth_send/.test(method) && !armed) throw new Error(`Blocked ${method}: the simulation has not reverted yet.`);
    return rawSend(method, params);
  };
  const signer = wallet.connect(provider);
  const reader = new ethers.Contract(ledgerAddress, CHANNELS_ABI, provider);
  const iface = new ethers.Interface(PAYMENT_LEDGER_ABI);

  // (1) Evidence: no function on the ledger raises a cap.
  console.log('\n== PaymentLedger functions (SDK dist/payment-ledger.js 131-158)');
  console.log('   ' + LEDGER_FUNCTIONS.join(', '));
  const capChangers = LEDGER_FUNCTIONS.filter((name) => /cap|increase|raise|amend|update|extend/i.test(name) && name !== 'availableAgentCapacity');
  console.log('   Functions that could change a channel cap:', capChangers.length === 0 ? 'none' : capChangers.join(', '));

  // (2) Read the channel.
  const before = await readChannel(reader, 'Before simulation');
  requireExpected(before);

  const domain = { name: 'AP4M Payment Ledger', version: '1', chainId: 1449000n, verifyingContract: ledgerAddress };
  const types = { Voucher: [{ name: 'channelId', type: 'bytes32' }, { name: 'cumulativeAmount', type: 'uint256' }] };
  async function voucherCalldata(cumulativeAmount) {
    const signature = await signVoucher(signer, ledgerAddress, CHANNEL_ID, cumulativeAmount);
    const recovered = ethers.verifyTypedData(domain, types, { channelId: CHANNEL_ID, cumulativeAmount }, signature);
    if (recovered.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('signature does not recover to this wallet');
    return iface.encodeFunctionData('redeemVoucher', [{ channelId: CHANNEL_ID, cumulativeAmount }, signature]);
  }
  async function simulate(data) {
    try {
      const raw = await provider.call({ to: ledgerAddress, from: wallet.address, data });
      const [claimId, amount] = iface.decodeFunctionResult('redeemVoucher', raw);
      return { reverted: false, text: `OK, would redeem ${f(amount)} RLUSD, claimId ${claimId}` };
    } catch (error) {
      return { reverted: true, text: revertText(error), error };
    }
  }

  // (3) CONTROL: a valid in-cap voucher must simulate fine. Not broadcast.
  console.log('\n== Control: in-cap voucher, cumulative', f(CONTROL_AMOUNT), 'RLUSD (eth_call only, not broadcast)');
  const controlData = await voucherCalldata(CONTROL_AMOUNT);
  const control = await simulate(controlData);
  console.log('   ', control.reverted ? 'REVERTED: ' + control.text : control.text);
  if (control.reverted) {
    printRevert(control.error);
    console.error('\n   The control voucher reverted, so a revert of the over-cap voucher would prove nothing. Inconclusive. Nothing broadcast. Exit 4.');
    process.exit(4);
  }

  // (3b) Over-cap voucher: cap + 1 wei, in memory only.
  const overCap = before.cap + 1n;
  console.log('\n== Over-cap voucher, cumulative', f(overCap), 'RLUSD (cap + 1 wei)');
  const data = await voucherCalldata(overCap);

  // (4) Simulate.
  console.log('\n== Simulation (eth_call)');
  const overCapSim = await simulate(data);
  const simulationReverted = overCapSim.reverted;
  console.log('   ', simulationReverted ? 'REVERTED.' : 'returned: ' + overCapSim.text);
  if (simulationReverted) printRevert(overCapSim.error);

  console.log('\n== Side by side (same channel, same block, same signer; only the amount differs)');
  console.log(`   cumulative ${f(CONTROL_AMOUNT).padEnd(24)} (in cap)   -> ${control.text}`);
  console.log(`   cumulative ${f(overCap).padEnd(24)} (cap + 1)  -> ${simulationReverted ? 'REVERTED: ' + overCapSim.text : overCapSim.text}`);

  if (!simulationReverted) {
    console.error('\n!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    console.error('!!  THE NODE ACCEPTED A VOUCHER ABOVE THE CAP IN SIMULATION.                 !!');
    console.error('!!  NOTHING WAS BROADCAST. The cap is NOT enforced on chain for this call.   !!');
    console.error('!!  A copy of this signature now exists at the public RPC node.               !!');
    console.error('!!  Do not rerun. Report this. Treat the 2 RLUSD on this channel as at risk.  !!');
    console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
    process.exit(3);
  }

  // (5) Re-read immediately before broadcasting.
  const recheck = await readChannel(reader, 'Immediately before broadcast');
  requireExpected(recheck);
  if (recheck.cap !== before.cap || recheck.redeemed !== before.redeemed) {
    console.error('Channel changed between simulation and broadcast. Stopping.');
    process.exit(1);
  }

  // (6) Broadcast with a manual gas limit so the revert is mined.
  armed = true;
  console.log('\n== Broadcast (manual gasLimit, expect a mined revert)');
  const tx = await signer.sendTransaction({ to: ledgerAddress, data, gasLimit: GAS_LIMIT });
  console.log('   tx hash:', tx.hash);
  console.log('   explorer:', `${EXPLORER}/tx/${tx.hash}`);
  const receipt = await waitForReceipt(provider, tx.hash);
  console.log('   mined in block:', receipt.blockNumber, ' status:', receipt.status, receipt.status === 0 ? '(Fail, as expected)' : '(SUCCESS: NOT EXPECTED)');
  console.log('   gas used:', receipt.gasUsed.toString(), ' cost XRP:', ethers.formatEther(receipt.gasUsed * (receipt.gasPrice ?? 0n)));
  if (receipt.status !== 0) {
    console.error('\n!!  The transaction did not revert. Check the channel state below and the explorer. Do not rerun.');
  }
  try {
    // Replay the mined call at its block to surface the revert data again.
    await provider.call({ to: ledgerAddress, from: wallet.address, data, blockTag: receipt.blockNumber - 1 });
  } catch (error) {
    console.log('   revert data (eth_call at block before mining):');
    printRevert(error);
  }

  // (7) Confirm nothing moved.
  const after = await readChannel(reader, 'After');
  console.log('\n== Result');
  console.log('   redeemed before:', f(before.redeemed), ' after:', f(after.redeemed), after.redeemed === before.redeemed ? '(unchanged)' : '(CHANGED)');
  console.log('   status after:', after.status, after.status === 1 ? '(still open)' : '');
  console.log(`   Over-cap voucher ${receipt.status === 0 && after.redeemed === before.redeemed ? 'REJECTED on chain' : 'NOT rejected: investigate'}.`);
  process.exitCode = receipt.status === 0 && after.redeemed === before.redeemed ? 0 : 2;
}

async function readChannel(reader, label) {
  const c = await reader.channels(CHANNEL_ID);
  const state = { cap: c.cap, redeemed: c.redeemed, status: Number(c.status), agent: c.agent };
  console.log(`\n== ${label}`);
  console.log('   status:', state.status, state.status === 1 ? '(open)' : '(NOT open)', ' cap:', f(state.cap), ' redeemed:', f(state.redeemed), ' agent:', state.agent);
  return state;
}

function requireExpected(state) {
  const problems = [];
  if (state.status !== 1) problems.push(`status is ${state.status}, not open`);
  if (state.cap !== EXPECTED_CAP) problems.push(`cap is ${f(state.cap)}, not 2`);
  if (state.redeemed !== 0n) problems.push(`redeemed is ${f(state.redeemed)}, not 0`);
  if (state.agent.toLowerCase() !== EXPECTED_AGENT.toLowerCase()) problems.push(`agent is ${state.agent}, not ours`);
  if (problems.length) {
    console.error('Channel is not in the expected state:', problems.join('; '), '. Stopping. Nothing was sent.');
    process.exit(1);
  }
}

function revertText(error) {
  const data = error?.data ?? error?.info?.error?.data ?? null;
  const selector = typeof data === 'string' && data.length >= 10 ? data.slice(0, 10) : null;
  const message = error?.reason ?? error?.shortMessage ?? error?.message ?? String(error);
  return `${message}${selector ? ` [selector ${selector}]` : ' [no revert data]'}`;
}

function printRevert(error) {
  const data = error?.data ?? error?.info?.error?.data ?? null;
  console.log('   short message:', error?.shortMessage ?? error?.message ?? String(error));
  if (error?.reason) console.log('   reason:', error.reason);
  if (typeof data === 'string' && data.startsWith('0x')) {
    console.log('   raw revert data:', data);
    const selector = data.slice(0, 10);
    if (selector === '0x08c379a0') {
      try { console.log('   Error(string):', ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10))[0]); } catch { /* raw already printed */ }
    } else if (selector === '0x4e487b71') {
      try { console.log('   Panic(uint256):', ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], '0x' + data.slice(10))[0].toString()); } catch { /* raw already printed */ }
    } else {
      console.log('   custom error selector (no name known from the SDK ABI):', selector);
    }
  } else {
    console.log('   no revert data returned by the node');
  }
}

async function waitForReceipt(provider, hash) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`Transaction ${hash} was not mined within 3 minutes. Check the explorer.`);
}

main().catch((error) => {
  console.error(String(error?.shortMessage ?? error?.message ?? error).replace(/0x[0-9a-fA-F]{100,}/g, '0x[redacted]'));
  process.exitCode = 1;
});
