/**
 * Read-only chain inspection of our AP4M budget on XRPL EVM testnet.
 * No key. No transaction. eth_call and eth_getLogs only; eth_send* is blocked below.
 *
 *   node chain_inspect.mjs
 *
 * Prints: the decoded close tx of channel 0x7ef9b2e7…, the ledger channel and allocation,
 * the vault payout binding, reservation and funding account, the vault limits, token balances,
 * and every ledger/vault event for our allocation with explorer links.
 * ABIs come from the AP4M SDK package (payment-ledger.js, pooled-escrow-vault.js, participant-requests.js).
 */
import { ethers } from 'ethers';

const RPC = 'https://rpc.testnet.xrplevm.org';
const LEDGER = '0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91';
const VAULT = '0x83DD9cD010eb46e96eceF8F7eB0a18f7845AaBC0';
const RLUSD = '0x27b57a9D0b8d24EB97259c4E2279e45255e016f3';
const AGENT = '0x5492fd1F22C6eFE98F1b9C2237091A6A621ce153';
const CLOSE_TX = '0xa818efbbcddf323b5afa2649d51dcc23dab4a83dfdbba260717a69fff661cf2b';

const provider = new ethers.JsonRpcProvider(RPC, 1449000, { staticNetwork: true });
provider.send = ((orig) => async (m, p) => { if (/^eth_send/.test(m)) throw new Error('blocked'); return orig(m, p); })(provider.send.bind(provider));

const LEDGER_ABI = [
  'event ChannelClosed(bytes32 indexed channelId,bytes32 indexed allocationId,bytes32 indexed finalCheckpointDigest,bytes32 finalVoucherDigest,uint64 merchantPspSignerGeneration,uint256 redeemed,uint256 unusedCapacityReleased)',
  'event ChannelOpened(bytes32 indexed channelId,bytes32 indexed allocationId,bytes32 indexed merchantPspId,bytes32 requestDigest,bytes32 authorityAttestationId,uint64 allocationGeneration,address agent,bytes32 merchantId,bytes32 merchantAttestationId,uint64 merchantGeneration,address payout,uint256 cap,uint64 validAfter,uint64 validBefore,address merchantPspSigner,uint64 merchantPspSignerGeneration)',
  'event SettlementRecorded(bytes32 indexed claimId,bytes32 indexed channelId,bytes32 indexed settlementDigest)',
  'event VoucherRedeemed(bytes32 indexed channelId,bytes32 indexed claimId,bytes32 indexed voucherDigest,bytes32 allocationId,address agent,bytes32 merchantId,address payout,address submitter,uint256 previousCumulativeAmount,uint256 cumulativeAmount,uint256 amount)',
  'function channels(bytes32 channelId) view returns (bytes32 allocationId,bytes32 merchantPspId,bytes32 requestDigest,bytes32 authorityAttestationId,bytes32 merchantAttestationId,bytes32 merchantId,bytes32 latestVoucherDigest,uint256 cap,uint256 redeemed,address agent,uint64 allocationGeneration,uint8 status,address payout,uint64 merchantGeneration,address merchantPspSigner,uint64 merchantPspSignerGeneration,uint64 validAfter,uint64 validBefore)',
  'function agentAllocations(bytes32 allocationId) view returns (bytes32 agentPspId,bytes32 agentParticipantIdHash,bytes32 authorityCommitment,bytes32 scopeCommitment,bytes32 authorityAttestationId,address agent,uint256 cap,uint256 reserved,uint256 spent,uint64 validAfter,uint64 validBefore,uint64 generation,uint8 status)',
  'function availableAgentCapacity(bytes32 allocationId) view returns (uint256)',
  'function claims(bytes32 claimId) view returns (bytes32 channelId,uint256 amount,bytes32 settlementDigest)',
];
const VAULT_ABI = [
  'event ClaimPaid(bytes32 indexed claimId,bytes32 indexed payoutId,bytes32 indexed channelId,address payout,uint256 amount,uint256 cumulativeDisbursed,uint64 paidAt)',
  'event DepositReserved(bytes32 indexed accountId,bytes32 indexed reservationId,bytes32 indexed allocationId,bytes32 operationId,address sourceWallet,uint256 amount,uint256 cumulativeDeposited,uint64 validAfter,uint64 allocationValidBefore,uint64 bindingValidBefore,bytes32 authorityCommitment,bytes32 scopeCommitment)',
  'event PayoutBound(bytes32 indexed reservationId,bytes32 indexed payoutId,bytes32 indexed channelId,bytes32 operationId,bytes32 merchantPspId,bytes32 merchantId,address payout,uint256 cap,uint64 boundAt)',
  'event PayoutClosed(bytes32 indexed payoutId,bytes32 indexed reservationId,bytes32 indexed operationId,uint256 returned)',
  'event ReservationReleased(bytes32 indexed reservationId,bytes32 indexed accountId,bytes32 indexed operationId,uint256 released)',
  'event AvailableWithdrawn(bytes32 indexed accountId,address indexed sourceWallet,bytes32 indexed operationId,uint256 amount,uint256 remainingAvailable)',
  'event PayoutBindingRequested(bytes32 indexed requestId,bytes32 indexed reservationId,address indexed requester,bytes32 operationId,bytes32 beneficiaryReference,uint256 cap,uint64 accountStatusGeneration,uint64 requestValidBefore,uint64 bindingValidBefore,uint64 createdAt)',
  'event PayoutBindingRequestBound(bytes32 indexed requestId,bytes32 indexed payoutId)',
  'function payoutIdByChannel(bytes32 channelId) view returns (bytes32)',
  'function payoutBinding(bytes32 payoutId) view returns ((bytes32 reservationId,bytes32 channelId,bytes32 merchantPspId,bytes32 merchantId,address payout,uint256 cap,uint256 available,uint256 disbursed,uint256 returned,uint256 executionCount,uint64 boundAt,uint8 status))',
  'function reservationIdByAllocation(bytes32 allocationId) view returns (bytes32)',
  'function reservation(bytes32 reservationId) view returns ((bytes32 accountId,bytes32 allocationId,bytes32 authorityCommitment,bytes32 scopeCommitment,bytes32 depositOperationId,uint256 amount,uint256 unassigned,uint256 activePayoutCapacity,uint256 disbursed,uint256 released,uint32 payoutBindingCount,uint32 activePayouts,uint64 validAfter,uint64 allocationValidBefore,uint64 bindingValidBefore,uint8 status))',
  'function fundingAccount(bytes32 accountId) view returns ((bytes32 payerPspId,bytes32 principalCommitment,bytes32 agentParticipantIdHash,bytes32 purposeCode,bytes32 scopePolicyId,address agent,address sourceWallet,uint256 deposited,uint256 available,uint256 activeReserved,uint256 disbursed,uint256 withdrawn,uint256 fundingRoundCount,uint32 activeReservations,uint256 withdrawalCount,uint64 validBefore,uint64 statusGeneration,uint64 statusChangedAt,bytes32 statusEvidenceDigest,uint8 statusReason,uint8 status))',
  'function vaultLimits() view returns ((uint32 maximumActiveReservationsPerAccount,uint32 maximumPayoutBindingsPerReservation,uint32 maximumActivePayoutsPerReservation,uint64 maximumAccountLifetimeSeconds,uint64 maximumReservationLifetimeSeconds,uint64 maximumBindingAdmissionLifetimeSeconds,uint256 minimumTransferAmount,uint256 maximumFundingRoundAmount,uint256 maximumAccountLiability,uint256 maximumPayoutCap,uint256 maximumAccountedLiability,uint32 maximumBindingRequestsPerReservation,uint64 maximumBindingRequestLifetimeSeconds))',
  'function payoutPaused() view returns (bool)',
  'function configuredToken() view returns (address)',
];
const ledger = new ethers.Contract(LEDGER, LEDGER_ABI, provider);
const vault = new ethers.Contract(VAULT, VAULT_ABI, provider);
const erc20 = new ethers.Contract(RLUSD, ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'], provider);
const f = (w) => ethers.formatUnits(w, 18);
const ts = (t) => new Date(Number(t) * 1000).toISOString();
const explorerTx = (h) => `https://explorer.testnet.xrplevm.org/tx/${h}`;

function show(label, obj, keys) {
  const out = {};
  for (const k of keys) {
    const v = obj[k];
    out[k] = typeof v === 'bigint' ? (/(validAfter|validBefore|boundAt|paidAt|statusChangedAt)/.test(k) ? `${v} (${ts(v)})` : (/(Count|count|status|Status|Generation|generation|Reason|Reservations)/.test(k) ? String(v) : `${f(v)} RLUSD`)) : v;
  }
  console.log(`\n== ${label}`);
  for (const [k, v] of Object.entries(out)) console.log(`  ${k}: ${v}`);
}

const head = await provider.getBlockNumber();
console.log('head block', head, 'now', new Date().toISOString());

// --- 1. Decode the close tx
const rc = await provider.getTransactionReceipt(CLOSE_TX);
const closeBlock = await provider.getBlock(rc.blockNumber);
console.log('\n== Close tx', CLOSE_TX);
console.log('  from (sender):', rc.from, ' to:', rc.to, ' block:', rc.blockNumber, ts(closeBlock.timestamp), ' status:', rc.status);
console.log('  logs:', rc.logs.length);
let channelId = null;
for (const log of rc.logs) {
  const iface = log.address.toLowerCase() === LEDGER.toLowerCase() ? ledger.interface : vault.interface;
  const ev = iface.parseLog(log);
  if (!ev) { console.log('  UNKNOWN LOG from', log.address, log.topics[0]); continue; }
  console.log(`  event ${ev.name} @ ${log.address}`);
  for (const [i, inp] of ev.fragment.inputs.entries()) {
    const v = ev.args[i];
    console.log(`     ${inp.name}: ${typeof v === 'bigint' && /uint256/.test(inp.type) ? f(v) + ' RLUSD' : v}`);
  }
  if (ev.name === 'ChannelClosed') channelId = ev.args.channelId;
}

// --- 2. Ledger state for the closed channel
const ch = await ledger.channels(channelId);
show(`Ledger channels(${channelId})`, ch, ['allocationId', 'merchantId', 'cap', 'redeemed', 'agent', 'status', 'payout', 'validAfter', 'validBefore']);
const allocationId = ch.allocationId;
const alloc = await ledger.agentAllocations(allocationId);
show(`Ledger agentAllocations(${allocationId})`, alloc, ['agent', 'cap', 'reserved', 'spent', 'validAfter', 'validBefore', 'generation', 'status']);
console.log('  availableAgentCapacity:', f(await ledger.availableAgentCapacity(allocationId)), 'RLUSD');

// --- 3. Vault state: payout binding for this channel, reservation, funding account
const payoutId = await vault.payoutIdByChannel(channelId);
console.log('\n== Vault payoutIdByChannel:', payoutId);
if (payoutId !== ethers.ZeroHash) {
  const pb = await vault.payoutBinding(payoutId);
  show(`Vault payoutBinding(${payoutId})`, pb, ['reservationId', 'channelId', 'payout', 'cap', 'available', 'disbursed', 'returned', 'executionCount', 'boundAt', 'status']);
  console.log('  (status: 0 None, 1 Active, 2 Closed)');
}
let reservationId = await vault.reservationIdByAllocation(allocationId);
console.log('\n== Vault reservationIdByAllocation:', reservationId);
if (reservationId === ethers.ZeroHash && payoutId !== ethers.ZeroHash) {
  reservationId = (await vault.payoutBinding(payoutId)).reservationId;
  console.log('   (zero; using reservationId from the payout binding instead:', reservationId, ')');
}
const resv = await vault.reservation(reservationId);
show(`Vault reservation(${reservationId})`, resv, ['accountId', 'amount', 'unassigned', 'activePayoutCapacity', 'disbursed', 'released', 'payoutBindingCount', 'activePayouts', 'validAfter', 'allocationValidBefore', 'bindingValidBefore', 'status']);
console.log('  (status: 0 None, 1 Active, 2 Released)');
const acct = await vault.fundingAccount(resv.accountId);
show(`Vault fundingAccount(${resv.accountId})`, acct, ['agent', 'sourceWallet', 'deposited', 'available', 'activeReserved', 'disbursed', 'withdrawn', 'activeReservations', 'validBefore', 'status']);
console.log('  (status: 0 None, 1 Active, 2 Suspended, 3 Closed)');

// --- 4. Vault limits, token facts
const lim = await vault.vaultLimits();
console.log('\n== Vault vaultLimits()');
for (const k of ['maximumActiveReservationsPerAccount', 'maximumPayoutBindingsPerReservation', 'maximumActivePayoutsPerReservation', 'maximumReservationLifetimeSeconds', 'maximumBindingAdmissionLifetimeSeconds', 'maximumBindingRequestsPerReservation', 'maximumBindingRequestLifetimeSeconds']) console.log(`  ${k}: ${lim[k]}`);
for (const k of ['minimumTransferAmount', 'maximumFundingRoundAmount', 'maximumAccountLiability', 'maximumPayoutCap', 'maximumAccountedLiability']) console.log(`  ${k}: ${f(lim[k])} RLUSD`);
console.log('  payoutPaused:', await vault.payoutPaused(), ' configuredToken:', await vault.configuredToken());
console.log('  RLUSD symbol/decimals:', await erc20.symbol(), await erc20.decimals());
console.log('  RLUSD balance of agent wallet:', f(await erc20.balanceOf(AGENT)));
console.log('  RLUSD balance of vault:', f(await erc20.balanceOf(VAULT)));
console.log('  RLUSD balance of merchant payout 0xc46d99…:', f(await erc20.balanceOf('0xc46d99faae8482f3876f49cae56b9f09057ce2b8')));
console.log('  XRP balance of agent wallet:', ethers.formatEther(await provider.getBalance(AGENT)));

// --- 5. Event history for this allocation / reservation / channels
// Allocation validAfter was 2026-10-24T20:37Z; the close was block 9227465 at 02:29Z. 30k blocks back covers it.
const FROM = Math.max(0, rc.blockNumber - 30000);
async function logs(c, name, filterArgs, from = FROM) {
  const topics = await c.filters[name](...filterArgs).getTopicFilter();
  const out = [];
  const step = 2000;
  for (let b = from; b <= head; b += step) {
    const got = await provider.getLogs({ address: c.target, topics, fromBlock: b, toBlock: Math.min(b + step - 1, head) });
    out.push(...got.map((l) => ({ ...c.interface.parseLog(l), txHash: l.transactionHash, blockNumber: l.blockNumber })));
  }
  return out;
}
console.log('\n== Event history (allocation', allocationId.slice(0, 10) + '…, from block', FROM, ')');
const opened = await logs(ledger, 'ChannelOpened', [null, allocationId]);
for (const e of opened) console.log(`  ChannelOpened  ch=${e.args.channelId} cap=${f(e.args.cap)} validBefore=${ts(e.args.validBefore)} blk=${e.blockNumber} ${explorerTx(e.txHash)}`);
const closed = await logs(ledger, 'ChannelClosed', [null, allocationId]);
for (const e of closed) console.log(`  ChannelClosed  ch=${e.args.channelId} redeemed=${f(e.args.redeemed)} unusedCapacityReleased=${f(e.args.unusedCapacityReleased)} blk=${e.blockNumber} ${explorerTx(e.txHash)}`);
for (const o of opened) {
  const red = await logs(ledger, 'VoucherRedeemed', [o.args.channelId]);
  for (const e of red) console.log(`  VoucherRedeemed ch=${e.args.channelId.slice(0, 10)}… claim=${e.args.claimId} amount=${f(e.args.amount)} cumulative=${f(e.args.cumulativeAmount)} submitter=${e.args.submitter} blk=${e.blockNumber} ${explorerTx(e.txHash)}`);
  const set = await logs(ledger, 'SettlementRecorded', [null, o.args.channelId]);
  for (const e of set) console.log(`  SettlementRecorded ch=${e.args.channelId.slice(0, 10)}… claim=${e.args.claimId} blk=${e.blockNumber} ${explorerTx(e.txHash)}`);
  const paid = await logs(vault, 'ClaimPaid', [null, null, o.args.channelId]);
  for (const e of paid) console.log(`  ClaimPaid (vault) ch=${e.args.channelId.slice(0, 10)}… amount=${f(e.args.amount)} payout=${e.args.payout} blk=${e.blockNumber} ${explorerTx(e.txHash)}`);
  const bound = await logs(vault, 'PayoutBound', [null, null, o.args.channelId]);
  for (const e of bound) console.log(`  PayoutBound (vault) ch=${e.args.channelId.slice(0, 10)}… payoutId=${e.args.payoutId} cap=${f(e.args.cap)} blk=${e.blockNumber} ${explorerTx(e.txHash)}`);
  for (const b of bound) {
    const pc = await logs(vault, 'PayoutClosed', [b.args.payoutId]);
    for (const e of pc) console.log(`  PayoutClosed (vault) payoutId=${e.args.payoutId.slice(0, 10)}… returned=${f(e.args.returned)} blk=${e.blockNumber} ${explorerTx(e.txHash)}`);
    if (pc.length === 0) console.log(`  PayoutClosed (vault) for payoutId ${b.args.payoutId.slice(0, 10)}…: NONE`);
  }
}
const rel = await logs(vault, 'ReservationReleased', [reservationId]);
console.log('  ReservationReleased (vault) count:', rel.length);
for (const e of rel) console.log(`     released=${f(e.args.released)} ${explorerTx(e.txHash)}`);
const dep = await logs(vault, 'DepositReserved', [null, reservationId]);
for (const e of dep) console.log(`  DepositReserved (vault) amount=${f(e.args.amount)} sourceWallet=${e.args.sourceWallet} bindingValidBefore=${ts(e.args.bindingValidBefore)} blk=${e.blockNumber} ${explorerTx(e.txHash)}`);
const wd = await logs(vault, 'AvailableWithdrawn', [resv.accountId]);
console.log('  AvailableWithdrawn (vault) count:', wd.length);
for (const e of wd) console.log(`     amount=${f(e.args.amount)} to=${e.args.sourceWallet} ${explorerTx(e.txHash)}`);
const breq = await logs(vault, 'PayoutBindingRequested', [null, reservationId]);
for (const e of breq) console.log(`  PayoutBindingRequested requester=${e.args.requester} cap=${f(e.args.cap)} blk=${e.blockNumber} ${explorerTx(e.txHash)}`);
