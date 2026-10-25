/**
 * Live AP4M executor for payments.mjs. The only file in the server that holds the agent key,
 * imports the hackathon SDK, and talks to the chain and the AP4M service.
 *
 * One channel per trip. The channel is given (TRIP_CHANNEL_ID); this file never opens one.
 * Outgoing transactions pass a guard: each must decode to redeemVoucher on that channel for
 * exactly the cumulative amount that payments.mjs armed, with zero value, to the ledger.
 * Anything else is refused before it leaves the process. The key is never logged.
 *
 * x402: quote() reads a seller's 402 challenge and signs nothing. buy() refuses a price above
 * the maximum before any signature, then answers the 402 with one cumulative voucher; the
 * seller (merchant) submits the redemption, so no transaction leaves this process for it.
 *
 * Environment (read only by createExecutorFromEnv):
 *   AGENT_PRIVATE_KEY   agent wallet key (required in ap4m mode)
 *   TRIP_CHANNEL_ID     the open channel for this trip (required)
 *   AP4M_API_URL        default https://hackathon.ap4m.build
 *   AP4M_RPC_URL        default: the RPC from /public/config
 *   TEAM_NAME           default Swanavi
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ethers } from 'ethers';
import { decodeX402PaymentRequired } from '@ap4m/sdk';
import { buyResource, loadX402Context } from './ap4m-x402.mjs';

const require = createRequire(import.meta.url);
const sdk = require('./ap4m-hackathon-sdk.js');

const DEPOSIT_BLOCK = 9224767; // our 20 RLUSD DepositReserved; PayoutClosed sums start here
const LOG_STEP = 2000;

const LEDGER_ABI = [
  ...sdk.PAYMENT_LEDGER_ABI,
  'function channels(bytes32) view returns (bytes32 allocationId,bytes32 merchantPspId,bytes32 requestDigest,bytes32 authorityAttestationId,bytes32 merchantAttestationId,bytes32 merchantId,bytes32 latestVoucherDigest,uint256 cap,uint256 redeemed,address agent,uint64 allocationGeneration,uint8 status,address payout,uint64 merchantGeneration,address merchantPspSigner,uint64 merchantPspSignerGeneration,uint64 validAfter,uint64 validBefore)',
  'function agentAllocations(bytes32) view returns (bytes32 agentPspId,bytes32 agentParticipantIdHash,bytes32 authorityCommitment,bytes32 scopeCommitment,bytes32 authorityAttestationId,address agent,uint256 cap,uint256 reserved,uint256 spent,uint64 validAfter,uint64 validBefore,uint64 generation,uint8 status)',
  'function availableAgentCapacity(bytes32) view returns (uint256)',
  'event VoucherRedeemed(bytes32 indexed channelId,bytes32 indexed claimId,bytes32 indexed voucherDigest,bytes32 allocationId,address agent,bytes32 merchantId,address payout,address submitter,uint256 previousCumulativeAmount,uint256 cumulativeAmount,uint256 amount)',
  'event ChannelOpened(bytes32 indexed channelId,bytes32 indexed allocationId,bytes32 indexed merchantPspId,bytes32 requestDigest,bytes32 authorityAttestationId,uint64 allocationGeneration,address agent,bytes32 merchantId,bytes32 merchantAttestationId,uint64 merchantGeneration,address payout,uint256 cap,uint64 validAfter,uint64 validBefore,address merchantPspSigner,uint64 merchantPspSignerGeneration)',
  'event ChannelClosed(bytes32 indexed channelId,bytes32 indexed allocationId,bytes32 indexed finalCheckpointDigest,bytes32 finalVoucherDigest,uint64 merchantPspSignerGeneration,uint256 redeemed,uint256 unusedCapacityReleased)',
];
const VAULT_ABI = [
  'function payoutIdByChannel(bytes32) view returns (bytes32)',
  'function payoutBinding(bytes32) view returns ((bytes32 reservationId,bytes32 channelId,bytes32 merchantPspId,bytes32 merchantId,address payout,uint256 cap,uint256 available,uint256 disbursed,uint256 returned,uint256 executionCount,uint64 boundAt,uint8 status))',
  'function reservation(bytes32) view returns ((bytes32 accountId,bytes32 allocationId,bytes32 authorityCommitment,bytes32 scopeCommitment,bytes32 depositOperationId,uint256 amount,uint256 unassigned,uint256 activePayoutCapacity,uint256 disbursed,uint256 released,uint32 payoutBindingCount,uint32 activePayouts,uint64 validAfter,uint64 allocationValidBefore,uint64 bindingValidBefore,uint8 status))',
  'event PayoutClosed(bytes32 indexed payoutId,bytes32 indexed reservationId,bytes32 indexed operationId,uint256 returned)',
  'event ClaimPaid(bytes32 indexed claimId,bytes32 indexed payoutId,bytes32 indexed channelId,address payout,uint256 amount,uint256 cumulativeDisbursed,uint64 paidAt)',
];

export class ExecutorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExecutorError';
    this.code = code;
  }
}

/** Pure guard, exported for tests. Throws unless the raw tx is the armed redeemVoucher. */
export function checkOutgoingTransaction(rawTransaction, { ledgerAddress, channelId, armedCumulative }) {
  const parsed = ethers.Transaction.from(rawTransaction);
  if ((parsed.to ?? '').toLowerCase() !== ledgerAddress.toLowerCase()) throw new ExecutorError('guard', `Blocked: transaction to ${parsed.to}, not the ledger.`);
  if (parsed.value !== 0n) throw new ExecutorError('guard', 'Blocked: transaction carries value.');
  let call = null;
  try { call = new ethers.Interface(sdk.PAYMENT_LEDGER_ABI).parseTransaction({ data: parsed.data }); } catch { call = null; }
  if (!call || call.name !== 'redeemVoucher') throw new ExecutorError('guard', `Blocked: ${call?.name ?? 'unknown call'} is not redeemVoucher.`);
  const [voucher] = call.args;
  if (voucher.channelId.toLowerCase() !== channelId.toLowerCase()) throw new ExecutorError('guard', 'Blocked: voucher is for another channel.');
  if (armedCumulative === null || voucher.cumulativeAmount !== armedCumulative) {
    throw new ExecutorError('guard', `Blocked: cumulative ${voucher.cumulativeAmount} is not the armed amount ${armedCumulative}.`);
  }
  return { cumulativeAmount: voucher.cumulativeAmount };
}

export async function createExecutorFromEnv(env = process.env, log = console) {
  const key = env.AGENT_PRIVATE_KEY;
  const channelId = (env.TRIP_CHANNEL_ID || '').toLowerCase();
  if (!key) throw new ExecutorError('config', 'PAYMENTS_MODE=ap4m needs AGENT_PRIVATE_KEY in the environment (never in a file in this repo).');
  if (!/^0x[0-9a-f]{64}$/.test(channelId)) throw new ExecutorError('config', 'PAYMENTS_MODE=ap4m needs TRIP_CHANNEL_ID (an open channel id). This server never opens one.');
  const apiUrl = env.AP4M_API_URL || 'https://hackathon.ap4m.build';
  const configResp = await fetch(`${apiUrl}/public/config`);
  const config = await configResp.json();
  if (!configResp.ok) throw new ExecutorError('config', `public config failed (${configResp.status})`);
  return createExecutor({
    key,
    channelId,
    apiUrl,
    teamName: env.TEAM_NAME || 'Swanavi',
    rpcUrl: env.AP4M_RPC_URL || config.network.rpcUrl,
    explorerUrl: config.network.explorerUrl || 'https://explorer.testnet.xrplevm.org',
    ledgerAddress: config.contracts.paymentLedger,
    vaultAddress: config.contracts.pooledEscrowVault,
    tokenAddress: config.contracts.rlusdToken,
    chainId: Number(config.network.chainId || 1449000),
    log,
  });
}

export function createExecutor({ key, channelId, apiUrl, teamName, rpcUrl, explorerUrl, ledgerAddress, vaultAddress, tokenAddress, chainId = 1449000, log = console }) {
  const wallet = new ethers.Wallet(key);
  const provider = new ethers.JsonRpcProvider(rpcUrl, chainId, { staticNetwork: true });
  let armedCumulative = null;
  const rawSend = provider.send.bind(provider);
  provider.send = async (method, params) => {
    if (method === 'eth_sendTransaction') throw new ExecutorError('guard', 'Blocked eth_sendTransaction.');
    if (method === 'eth_sendRawTransaction') checkOutgoingTransaction(params[0], { ledgerAddress, channelId, armedCumulative });
    return rawSend(method, params);
  };
  const signer = wallet.connect(provider);
  const ledger = new ethers.Contract(ledgerAddress, LEDGER_ABI, signer);
  const vault = new ethers.Contract(vaultAddress, VAULT_ABI, provider);
  const token = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
  const links = {
    tx: (hash) => (hash ? `${explorerUrl}/tx/${hash}` : null),
    address: (address) => `${explorerUrl}/address/${address}`,
  };

  let session = null;
  let sessionAt = 0;
  let x402Context = null;
  async function teamToken(force = false) {
    const ttl = (session?.expiresInSeconds ?? 600) * 1000;
    if (force || !session || Date.now() - sessionAt > ttl - 60_000) {
      session = await sdk.signIn(apiUrl, teamName, wallet);
      sessionAt = Date.now();
    }
    return session.token;
  }

  let payoutInfo = null;
  async function payoutIds() {
    if (payoutInfo) return payoutInfo;
    const payoutId = await vault.payoutIdByChannel(channelId);
    const binding = await vault.payoutBinding(payoutId);
    payoutInfo = { payoutId, reservationId: binding.reservationId };
    return payoutInfo;
  }

  async function getLogs(contract, topics, fromBlock, toBlock) {
    const out = [];
    for (let b = fromBlock; b <= toBlock; b += LOG_STEP) {
      const logs = await provider.getLogs({ address: contract.target, topics, fromBlock: b, toBlock: Math.min(b + LOG_STEP - 1, toBlock) });
      for (const entry of logs) out.push({ ...contract.interface.parseLog(entry), txHash: entry.transactionHash, blockNumber: entry.blockNumber });
    }
    return out;
  }

  let openedTx = null;
  async function channelOpenedTx() {
    if (openedTx) return openedTx;
    const head = await provider.getBlockNumber();
    const topics = await ledger.filters.ChannelOpened(channelId).getTopicFilter();
    const found = await getLogs(ledger, topics, DEPOSIT_BLOCK, head);
    openedTx = found[0]?.txHash ?? null;
    return openedTx;
  }

  async function describePurchase(purchase, { price, previous }) {
    const receipt = await provider.getTransactionReceipt(purchase.transactionHash);
    const event = (receipt?.logs ?? []).map((entry) => { try { return ledger.interface.parseLog(entry); } catch { return null; } }).find((e) => e?.name === 'VoucherRedeemed');
    const amount = event?.args.amount ?? price;
    return {
      txHash: purchase.transactionHash,
      blockNumber: receipt?.blockNumber ?? null,
      claimId: event?.args.claimId ?? purchase.claimId,
      amount,
      previous: event?.args.previousCumulativeAmount ?? previous,
      cumulativeAmount: event?.args.cumulativeAmount ?? (amount != null ? previous + amount : null),
      submitter: event?.args.submitter ?? null,
      resource: purchase.resource,
    };
  }

  const refundedCache = { block: 0, sum: 0n, scannedTo: DEPOSIT_BLOCK - 1 };
  async function refundedSum(head) {
    if (head <= refundedCache.scannedTo) return refundedCache.sum;
    const { reservationId } = await payoutIds();
    const topics = await vault.filters.PayoutClosed(null, reservationId).getTopicFilter();
    const logs = await getLogs(vault, topics, refundedCache.scannedTo + 1, head);
    for (const entry of logs) refundedCache.sum += entry.args.returned;
    refundedCache.scannedTo = head;
    return refundedCache.sum;
  }

  return {
    kind: 'live',
    channelId,
    agent: wallet.address,
    links,
    addresses: { ledger: ledgerAddress, vault: vaultAddress, token: tokenAddress },

    async readChannel() {
      const c = await ledger.channels(channelId);
      return {
        channelId,
        cap: c.cap,
        redeemed: c.redeemed,
        status: Number(c.status) === 1 ? 'open' : Number(c.status) === 2 ? 'closed' : 'none',
        agent: c.agent,
        payout: c.payout,
        allocationId: c.allocationId,
        validBefore: Number(c.validBefore),
        openedTx: await channelOpenedTx(),
      };
    },

    /** The 20 RLUSD deposit as the contracts hold it. */
    async readFund(allocationId) {
      const head = await provider.getBlockNumber();
      const { reservationId, payoutId } = await payoutIds();
      const [alloc, available, resv, binding, block] = await Promise.all([
        ledger.agentAllocations(allocationId), ledger.availableAgentCapacity(allocationId),
        vault.reservation(reservationId), vault.payoutBinding(payoutId), provider.getBlock(head),
      ]);
      return {
        block: head,
        asOf: new Date(Number(block.timestamp) * 1000).toISOString(),
        allocation: { cap: alloc.cap, reserved: alloc.reserved, spent: alloc.spent, available },
        reservation: { amount: resv.amount, locked: resv.activePayoutCapacity, settled: resv.disbursed, unassigned: resv.unassigned },
        thisChannel: { settled: binding.disbursed, returned: binding.returned, status: Number(binding.status) === 2 ? 'closed' : 'active' },
        refunded: await refundedSum(head),
        links: { ledger: links.address(ledgerAddress), vault: links.address(vaultAddress) },
      };
    },

    async merchantBalance(address) {
      return token.balanceOf(address);
    },

    /** Sign and submit one cumulative voucher. Serialized by payments.mjs. */
    async redeem({ cumulativeAmount, expectedPrevious }) {
      const before = await ledger.channels(channelId);
      if (Number(before.status) !== 1) throw new ExecutorError('channel_closed', 'The trip channel is not open.');
      if (before.redeemed !== expectedPrevious) throw new ExecutorError('drift', `Chain shows redeemed ${ethers.formatUnits(before.redeemed, 18)}, expected ${ethers.formatUnits(expectedPrevious, 18)}.`);
      if (cumulativeAmount > before.cap) throw new ExecutorError('over_cap', 'Cumulative amount is above the channel cap. Not signed.');
      const signature = await sdk.signVoucher(signer, ledgerAddress, channelId, cumulativeAmount);
      armedCumulative = cumulativeAmount;
      try {
        const tx = await ledger.redeemVoucher({ channelId, cumulativeAmount }, signature);
        const receipt = await tx.wait();
        const event = receipt.logs.map((entry) => { try { return ledger.interface.parseLog(entry); } catch { return null; } }).find((e) => e?.name === 'VoucherRedeemed');
        return {
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          claimId: event?.args.claimId ?? null,
          amount: event?.args.amount ?? (cumulativeAmount - expectedPrevious),
          previous: event?.args.previousCumulativeAmount ?? expectedPrevious,
        };
      } finally {
        armedCumulative = null;
      }
    },

    /** Read a seller's 402 challenge. Signs nothing. */
    async quote(resourceUrl) {
      const response = await fetch(resourceUrl, { headers: { 'X-AP4M-CHANNEL-ID': channelId }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
      const body = await response.json().catch(() => ({}));
      if (response.status !== 402) {
        throw new ExecutorError('no_402', `Seller at ${resourceUrl} answered HTTP ${response.status} ${body?.error ?? ''}, not a 402 payment requirement.`);
      }
      const required = decodeX402PaymentRequired(response.headers.get('PAYMENT-REQUIRED') ?? '');
      const accepted = required.accepts[0];
      return {
        resourceUrl,
        price: BigInt(accepted.amount),
        payTo: accepted.payTo,
        asset: accepted.asset,
        network: accepted.network,
        channelId: accepted.extra?.channelId ?? null,
        previousCumulativeAmount: accepted.extra?.acceptedCumulativeAmount != null ? BigInt(accepted.extra.acceptedCumulativeAmount) : null,
        validBefore: accepted.extra?.validBefore ?? null,
      };
    },

    /**
     * Buy one resource over x402. Refuses before signing when the 402 price is above
     * maximumAmount. Returns the same shape as redeem() plus the resource.
     */
    async buy({ resourceUrl, maximumAmount, operation, stateDirectory = join(process.cwd(), 'agent-state') }) {
      const q = await this.quote(resourceUrl);
      if (q.price > maximumAmount) {
        throw new ExecutorError('price_above_max', `Seller asks ${ethers.formatUnits(q.price, 18)} RLUSD, above the maximum ${ethers.formatUnits(maximumAmount, 18)}. Refused before signing.`);
      }
      const before = await ledger.channels(channelId);
      if (Number(before.status) !== 1) throw new ExecutorError('channel_closed', 'The trip channel is not open.');
      if (before.redeemed + q.price > before.cap) throw new ExecutorError('over_cap', 'This price would put the channel above its cap. Not signed.');
      x402Context ??= await loadX402Context(apiUrl);
      const purchase = await buyResource({
        context: x402Context,
        provider,
        wallet: signer,
        stateDirectory: join(stateDirectory, operation),
        resourceUrl,
        channelId,
        maximumAmount: maximumAmount.toString(),
        operation,
      });
      return describePurchase(purchase, { price: q.price, previous: before.redeemed });
    },

    /**
     * Finish a purchase whose signed payment is already on disk (the seller answered 503
     * "payment_pending_or_unavailable" or the process died). Re-sends the SAME signed header;
     * the helper does not sign when a retained purchase exists, and the wallet passed here
     * cannot sign at all, so a resume can never create a new payment.
     */
    async resume({ operation, stateDirectory = join(process.cwd(), 'agent-state') }) {
      const file = join(stateDirectory, operation, 'purchase.json');
      const retained = JSON.parse(readFileSync(file, 'utf8'));
      const intent = retained.intent;
      if (intent.channelId.toLowerCase() !== channelId.toLowerCase()) throw new ExecutorError('guard', `${file} belongs to channel ${intent.channelId}, not ${channelId}.`);
      if (intent.agent.toLowerCase() !== wallet.address.toLowerCase()) throw new ExecutorError('guard', `${file} was signed by ${intent.agent}, not this agent.`);
      if (retained.complete) throw new ExecutorError('already_complete', `${operation} is already complete; nothing to resume.`);
      const noSign = {
        address: wallet.address,
        signTypedData() { throw new ExecutorError('guard', 'resume must not sign anything'); },
        signMessage() { throw new ExecutorError('guard', 'resume must not sign anything'); },
      };
      x402Context ??= await loadX402Context(apiUrl);
      const purchase = await buyResource({
        context: x402Context,
        provider,
        wallet: noSign,
        stateDirectory: join(stateDirectory, operation),
        resourceUrl: intent.resourceUrl,
        channelId,
        maximumAmount: intent.maximumAmount,
        operation,
      });
      return describePurchase(purchase, { price: null, previous: BigInt(retained.previousCumulativeAmount) });
    },

    /** Unresolved purchases on disk: operations whose purchase.json has complete: false. */
    pendingPurchases(stateDirectory = join(process.cwd(), 'agent-state')) {
      if (!existsSync(stateDirectory)) return [];
      const out = [];
      for (const name of readdirSync(stateDirectory)) {
        const file = join(stateDirectory, name, 'purchase.json');
        if (!existsSync(file)) continue;
        try {
          const retained = JSON.parse(readFileSync(file, 'utf8'));
          if (retained.complete === false && retained.intent?.channelId?.toLowerCase() === channelId.toLowerCase()) {
            out.push({ operation: retained.intent.operation, resourceUrl: retained.intent.resourceUrl, maximumAmount: BigInt(retained.intent.maximumAmount), previousCumulativeAmount: BigInt(retained.previousCumulativeAmount) });
          }
        } catch { /* not a purchase file */ }
      }
      return out;
    },

    async recordRedemption(txHash) {
      const resp = await fetch(`${apiUrl}/public/participant/record-redemption`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await teamToken()}` },
        body: JSON.stringify({ tx_hash: txHash }),
      });
      const body = await resp.json().catch(() => ({}));
      return { ok: resp.ok, status: resp.status, claimId: body.claim_id ?? null, error: body.error ?? null };
    },

    /** Settle now and return every receipt on the channel. */
    async settle() {
      const settled = await sdk.settle(apiUrl, await teamToken(), channelId);
      return {
        payoutTx: settled.payout_tx ?? null,
        settlementTx: settled.settlement_tx ?? null,
        claimsSettled: settled.claims_settled ?? null,
        receipts: (settled.receipts ?? []).map((r) => ({
          claimId: r.claim_id,
          amountRlusd: r.amount_rlusd,
          receiptUrl: r.receipt_url ? (r.receipt_url.startsWith('http') ? r.receipt_url : apiUrl + r.receipt_url) : null,
        })),
        latestReceiptUrl: settled.receipt_url ? (settled.receipt_url.startsWith('http') ? settled.receipt_url : apiUrl + settled.receipt_url) : null,
      };
    },

    /** Find the VoucherRedeemed event for a cumulative amount (used after a crash). */
    async findRedemption(cumulativeAmount) {
      const head = await provider.getBlockNumber();
      const topics = await ledger.filters.VoucherRedeemed(channelId).getTopicFilter();
      const logs = await getLogs(ledger, topics, DEPOSIT_BLOCK, head);
      const hit = logs.find((e) => e.args.cumulativeAmount === cumulativeAmount);
      return hit ? { txHash: hit.txHash, blockNumber: hit.blockNumber, claimId: hit.args.claimId, amount: hit.args.amount } : null;
    },

    async verifyTx(txHash) {
      const receipt = await provider.getTransactionReceipt(txHash);
      if (!receipt) return 'missing';
      return receipt.status === 1 ? 'confirmed' : 'failed';
    },

    /** Close the trip channel; the service returns the unused cap (vault PayoutClosed). */
    async closeTrip() {
      const before = await ledger.channels(channelId);
      if (Number(before.status) !== 1) throw new ExecutorError('channel_closed', 'The trip channel is already closed.');
      const { payoutId } = await payoutIds();
      const binding = await vault.payoutBinding(payoutId);
      let settlement = null;
      if (before.redeemed > binding.disbursed) settlement = await this.settle();
      let closed;
      try {
        closed = await sdk.closeChannel(apiUrl, await teamToken(), wallet, channelId);
      } catch (error) {
        log.warn?.(`close attempt failed (${String(error.message).slice(0, 120)}); signing in again`);
        closed = await sdk.closeChannel(apiUrl, await teamToken(true), wallet, channelId);
      }
      const fromBlock = (await provider.getBlockNumber()) - 10;
      const topics = await vault.filters.PayoutClosed(payoutId).getTopicFilter();
      let payoutClosed = null;
      for (let attempt = 0; attempt < 36 && !payoutClosed; attempt++) {
        const logs = await getLogs(vault, topics, fromBlock, await provider.getBlockNumber());
        if (logs.length) payoutClosed = { txHash: logs[0].txHash, returned: logs[0].args.returned, blockNumber: logs[0].blockNumber };
        else await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      refundedCache.scannedTo = DEPOSIT_BLOCK - 1;
      refundedCache.sum = 0n;
      return {
        closeTx: closed.tx_hash ?? null,
        finalCumulativeAmount: closed.final_cumulative_amount ?? null,
        payoutClosedTx: payoutClosed?.txHash ?? null,
        returned: payoutClosed?.returned ?? null,
        settlement,
      };
    },
  };
}
