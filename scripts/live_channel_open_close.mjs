/**
 * Live test, XRPL EVM testnet. You run this. It is not a mock.
 *
 * What it sends:
 *   1. requestChannel — one vault transaction. Reserves a 2 RLUSD cap. Gas is XRP.
 *   2. closeChannel — signs the service's close checkpoint, not a payment voucher.
 *
 * What it does not do: signVoucher, redeem, or a settlement. No payment is signed.
 * The cap is fixed at 2 RLUSD. Environment variables cannot raise it.
 * WAIT_BEFORE_CLOSE=1 pauses after the open so above_cap_call.mjs can run
 * in another terminal. Without that variable, this script closes immediately.
 *
 * The helper has no budget-balance call. This prints sign-in state and every
 * channel before and after. The portal is still the place to read the 19 RLUSD.
 */

import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const { signIn, requestChannel, listChannels, closeChannel, getChannelState } = require('../ap4m-hackathon-sdk.js');

const API_URL = process.env.AP4M_API_URL || 'https://hackathon.ap4m.build';
const TEAM_NAME = process.env.TEAM_NAME || 'Swanavi';
const CAP_RLUSD = '2';
const OPEN_WAIT_MS = 180000;

async function main() {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key || key === 'YOUR_AGENT_PRIVATE_KEY_HERE') {
    console.error('Set AGENT_PRIVATE_KEY in the environment. This file does not read a key file.');
    process.exitCode = 1;
    return;
  }

  let wallet;
  try {
    wallet = new ethers.Wallet(key);
  } catch {
    console.error('AGENT_PRIVATE_KEY could not be read as a wallet.');
    process.exitCode = 1;
    return;
  }

  console.log('Agent address:', wallet.address);
  console.log('Cap reserved by this script:', CAP_RLUSD, 'RLUSD');
  console.log('Payment voucher: none');

  const config = await loadConfig();
  const rpcUrl = process.env.AP4M_RPC_URL || config.network.rpcUrl;
  const ledger = config.contracts.paymentLedger;
  console.log('RPC:', rpcUrl);
  console.log('Ledger:', ledger);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const first = await signIn(API_URL, TEAM_NAME, wallet);
  await printBooks('Before', first);

  let openedId = null;
  let closeDone = false;
  try {
    const started = Date.now();
    console.log('\nSending the vault transaction for a 2 RLUSD channel...');
    const channel = await requestChannel(API_URL, first.token, wallet.connect(provider), {
      capRlusd: CAP_RLUSD,
      rpcUrl,
      timeoutMs: OPEN_WAIT_MS,
    });
    const openMs = Date.now() - started;
    openedId = channel.channel_id;
    console.log('Channel id:', openedId);
    console.log('Service status:', channel.channel_status);
    console.log('Service cap wei:', channel.cap_wei);
    console.log('Open time, including the wait until status is open:', openMs, 'ms');

    const state = await getChannelState(provider, ledger, openedId);
    console.log('On-chain cap RLUSD:', ethers.formatUnits(state.cap, 18));
    console.log('On-chain redeemed RLUSD:', ethers.formatUnits(state.redeemed, 18));
    console.log('On-chain status number:', state.status);
    if (state.redeemed !== 0n) {
      console.error('Redeemed is not zero. No voucher will be signed. Closing next.');
    }
    await waitBeforeClose(openedId);

    const closeStarted = Date.now();
    const closing = await signIn(API_URL, TEAM_NAME, wallet);
    const closed = await closeChannel(API_URL, closing.token, wallet, openedId);
    closeDone = true;
    console.log('Close time:', Date.now() - closeStarted, 'ms');
    console.log('Close tx:', closed.tx_hash ?? null);
    console.log('Close final cumulative amount:', closed.final_cumulative_amount ?? null);

    await printBooks('After', closing);
  } catch (error) {
    console.error(clip(error instanceof Error ? error.message : 'channel test failed'));
    process.exitCode = 1;
  } finally {
    if (openedId && !closeDone) {
      try {
      const closing = await signIn(API_URL, TEAM_NAME, wallet);
      const closed = await closeChannel(API_URL, closing.token, wallet, openedId);
        console.error('Closed after the error. Tx:', closed.tx_hash ?? null);
      } catch (error) {
        console.error('CLOSE FAILED. Channel still open:', openedId);
        console.error(clip(error instanceof Error ? error.message : 'close failed'));
      }
    }
  }
}

async function loadConfig() {
  const response = await fetch(`${API_URL}/public/config`);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`public config failed (${response.status}): ${body.error ?? 'no error field'}`);
  }
  if (!body.network?.rpcUrl || !body.contracts?.paymentLedger) {
    throw new Error('public config did not include network.rpcUrl and contracts.paymentLedger');
  }
  return body;
}

async function printBooks(label, session) {
  console.log(`\n== ${label} ==`);
  printSession(session);
  const channels = await listChannels(API_URL, session.token);
  if (!Array.isArray(channels) || channels.length === 0) {
    console.log('Channels: none');
    console.log('Caps still open, requested, or bound: 0 RLUSD');
    return;
  }
  let reserved = 0n;
  for (const channel of channels) {
    const cap = formatCap(channel.cap_wei);
    console.log(`${channel.channel_status}\t${cap} RLUSD\t${channel.channel_id}`);
    if (channel.channel_status === 'open' || channel.channel_status === 'requested' || channel.channel_status === 'bound') {
      reserved += wei(channel.cap_wei);
    }
  }
  console.log('Caps still open, requested, or bound:', ethers.formatUnits(reserved, 18), 'RLUSD');
  console.log('That sum is channel caps, not the vault balance.');
}

function printSession(session) {
  const view = {};
  for (const [key, value] of Object.entries(session ?? {})) {
    if (/token|signature|private|secret|authorization/i.test(key)) continue;
    view[key] = value;
  }
  console.log('Sign-in, secrets removed:', JSON.stringify(redact(view)));
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = /token|signature|private|secret|authorization/i.test(key) ? '[redacted]' : redact(inner);
    }
    return out;
  }
  const text = String(value ?? '');
  return text.length > 300 ? `${text.slice(0, 300)}…` : value;
}

function formatCap(capWei) {
  const amount = wei(capWei);
  return amount === null ? String(capWei) : ethers.formatUnits(amount, 18);
}

function waitBeforeClose(channelId) {
  if (process.env.WAIT_BEFORE_CLOSE !== '1') return Promise.resolve();
  if (!process.stdin.isTTY) {
    console.log('WAIT_BEFORE_CLOSE=1 but stdin is not a terminal. Closing now.');
    return Promise.resolve();
  }
  console.log(`Channel ${channelId} is open.`);
  console.log('In another terminal, run above_cap_call.mjs. Press Enter here to close.');
  const prompts = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    prompts.once('line', () => {
      prompts.close();
      resolve();
    });
  });
}

function wei(capWei) {
  try {
    return BigInt(capWei);
  } catch {
    return null;
  }
}

function clip(value) {
  const text = String(value ?? '').replace(/0x[0-9a-fA-F]{100,}/g, '0x[redacted]');
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
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
    console.error(clip(error instanceof Error ? error.message : 'channel test failed'));
    process.exitCode = 1;
  });
}
