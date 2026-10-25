// Offline test of the outgoing-transaction guard in live_trip.mjs.
// No network. The key below is a throwaway test vector, not a real wallet.
//   node --test test/trip-guard.test.mjs

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ethers } from 'ethers';

// The guard lives in scripts/live_trip.mjs, which needs the hackathon helper ap4m-hackathon-sdk.js
// (downloaded separately, see README). Without it these tests are skipped, not failed.
const sdkPresent = existsSync(new URL('../ap4m-hackathon-sdk.js', import.meta.url));
const run = (name, fn) => (sdkPresent ? test(name, fn) : test(name, { skip: 'ap4m-hackathon-sdk.js not downloaded (see README)' }, fn));
const require = createRequire(import.meta.url);
const { PAYMENT_LEDGER_ABI } = sdkPresent ? require('../ap4m-hackathon-sdk.js') : { PAYMENT_LEDGER_ABI: [] };
const { checkOutgoingTransaction } = sdkPresent ? await import('../scripts/live_trip.mjs') : { checkOutgoingTransaction: null };

const LEDGER = '0xcAB42800A5ECF0D253Fa2581Bb3334B4DAEfaE91';
const VAULT = '0x83DD9cD010eb46e96eceF8F7eB0a18f7845AaBC0';
const CHANNEL = '0x14dc20af40d782b2a80ccb4bfa5cdecd6faf6c441c26d63d1fbe0af7980762c0';
const OTHER_CHANNEL = '0x7ef9b2e76b7a2b784af8703a992bdbfeb8d9582203b685fa1fdadacd3820c5cb';
const MAX = ethers.parseUnits('0.02', 18);
const limits = { ledgerAddress: LEDGER, channelId: CHANNEL, maxPayout: MAX };

const iface = new ethers.Interface(PAYMENT_LEDGER_ABI);
const throwaway = new ethers.Wallet(`0x${'11'.repeat(32)}`);
const fakeSignature = `0x${'ab'.repeat(65)}`;

async function rawRedeem({ to = LEDGER, channelId = CHANNEL, amount, value = 0n, data } = {}) {
  return throwaway.signTransaction({
    to,
    data: data ?? iface.encodeFunctionData('redeemVoucher', [{ channelId, cumulativeAmount: amount }, fakeSignature]),
    value,
    chainId: 1449000,
    nonce: 0,
    gasLimit: 200000,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    type: 2,
  });
}

run('allows redeemVoucher on the channel for 0.01 and 0.02', async () => {
  const one = checkOutgoingTransaction(await rawRedeem({ amount: ethers.parseUnits('0.01', 18) }), limits);
  assert.equal(one.cumulativeAmount, ethers.parseUnits('0.01', 18));
  const two = checkOutgoingTransaction(await rawRedeem({ amount: ethers.parseUnits('0.02', 18) }), limits);
  assert.equal(two.cumulativeAmount, MAX);
});

run('blocks one wei above MAX_PAYOUT', async () => {
  assert.throws(() => checkOutgoingTransaction(undefined, limits));
  await assert.rejects(async () => checkOutgoingTransaction(await rawRedeem({ amount: MAX + 1n }), limits), /above MAX_PAYOUT/);
});

run('blocks 0.03 and 2 RLUSD', async () => {
  await assert.rejects(async () => checkOutgoingTransaction(await rawRedeem({ amount: ethers.parseUnits('0.03', 18) }), limits), /above MAX_PAYOUT/);
  await assert.rejects(async () => checkOutgoingTransaction(await rawRedeem({ amount: ethers.parseUnits('2', 18) }), limits), /above MAX_PAYOUT/);
});

run('blocks another channel', async () => {
  await assert.rejects(async () => checkOutgoingTransaction(await rawRedeem({ channelId: OTHER_CHANNEL, amount: 1n }), limits), /another channel/);
});

run('blocks a transaction to another contract', async () => {
  await assert.rejects(async () => checkOutgoingTransaction(await rawRedeem({ to: VAULT, amount: 1n }), limits), /not the ledger/);
});

run('blocks a transaction that carries value', async () => {
  await assert.rejects(async () => checkOutgoingTransaction(await rawRedeem({ amount: 1n, value: 5n }), limits), /carries value/);
});

run('blocks a different function and unknown calldata', async () => {
  const recordSettlement = new ethers.Interface(['function recordSettlement(bytes32 claimId,bytes32 settlementDigest)'])
    .encodeFunctionData('recordSettlement', [CHANNEL, ethers.ZeroHash]);
  await assert.rejects(async () => checkOutgoingTransaction(await rawRedeem({ data: recordSettlement }), limits), /is not redeemVoucher/);
  await assert.rejects(async () => checkOutgoingTransaction(await rawRedeem({ data: '0xdeadbeef' }), limits), /is not redeemVoucher/);
});

run('importing the script does not run it', () => {
  // If main() had run on import, it would have exited the process for the missing key.
  assert.ok(true);
});
