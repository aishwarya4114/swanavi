/**
 * Read-only check of our merchant payout wallet and the team's merchant registration.
 *
 *   node merchant_status.mjs                       balances only (no key)
 *   AGENT_PRIVATE_KEY=0x... node merchant_status.mjs   also the service's view of the team
 *                                                   (sign-in only: one signed message, no transaction)
 *
 * Prints: the wallet's RLUSD and XRP balances, the team's merchant id / payout wallet / pool flag
 * from /public/participant/me, and the list of our channels with the merchant each one pays.
 * The key is never printed; the session token is redacted.
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const sdk = require('../ap4m-hackathon-sdk.js');

export const OUR_MERCHANT_WALLET = '0x4581492018e07F81F055D15BC7EBab4957A1Ce0C';
const POOL_WALLET = '0xC46D99FAaE8482F3876f49cAE56B9F09057CE2B8';
const API = process.env.AP4M_API_URL || 'https://hackathon.ap4m.build';

export async function readBalances(provider, tokenAddress, address) {
  const token = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
  const [rlusd, xrp] = await Promise.all([token.balanceOf(address), provider.getBalance(address)]);
  return { rlusd, xrp };
}

async function main() {
  const config = await (await fetch(`${API}/public/config`)).json();
  const provider = new ethers.JsonRpcProvider(process.env.AP4M_RPC_URL || config.network.rpcUrl, Number(config.network.chainId || 1449000), { staticNetwork: true });
  const wallet = process.env.MERCHANT_WALLET || OUR_MERCHANT_WALLET;
  for (const [label, address] of [['our merchant wallet', wallet], ['hackathon pool wallet', POOL_WALLET]]) {
    const b = await readBalances(provider, config.contracts.rlusdToken, address);
    console.log(`${label.padEnd(22)} ${address}  ${ethers.formatUnits(b.rlusd, 18)} RLUSD  ${ethers.formatEther(b.xrp)} XRP${address === wallet && b.xrp === 0n ? '  <- no gas: fund it from https://faucet.testevm.ripple.com before using it as the x402 submitter' : ''}`);
  }
  console.log(`explorer ${config.network.explorerUrl || 'https://explorer.testnet.xrplevm.org'}/address/${wallet}`);

  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key) {
    console.log('\n(no AGENT_PRIVATE_KEY: skipping the service view; balances above need no key)');
    return;
  }
  const agent = new ethers.Wallet(key);
  const session = await sdk.signIn(API, process.env.TEAM_NAME || 'Swanavi', agent);
  const headers = { Authorization: `Bearer ${session.token}` };
  const me = await (await fetch(`${API}/public/participant/me`, { headers })).json();
  const team = me.team ?? me;
  console.log('\nservice view (/public/participant/me):');
  console.log(`  team            ${team.team_name ?? team.name ?? '?'}`);
  console.log(`  agent wallet    ${team.agent_wallet ?? '?'}`);
  console.log(`  merchant id     ${team.merchant_id ?? '(none)'}`);
  console.log(`  merchant payout ${team.merchant_wallet ?? '(none)'}  pool: ${team.merchant_is_pool === undefined ? '?' : team.merchant_is_pool}`);
  const ours = (team.merchant_wallet ?? '').toLowerCase() === wallet.toLowerCase() && team.merchant_is_pool === false;
  console.log(`  => ${ours ? 'OUR wallet is the registered merchant payout. New channels pay it.' : 'our wallet is NOT the registered merchant payout yet.'}`);
  const channels = await sdk.listChannels(API, session.token).catch(() => []);
  console.log('\nchannels (service view):');
  for (const c of channels) {
    console.log(`  ${c.channel_id}  ${String(c.channel_status).padEnd(7)} cap ${ethers.formatUnits(BigInt(c.cap_wei), 18).padStart(5)}  pays ${c.payout}${c.payout?.toLowerCase() === wallet.toLowerCase() ? '  (OURS)' : c.payout?.toLowerCase() === POOL_WALLET.toLowerCase() ? '  (pool)' : ''}  merchant ${c.merchant_id}`);
  }
  const other = Object.fromEntries(Object.entries(me).filter(([k]) => !['team', 'token'].includes(k)));
  if (Object.keys(other).length) console.log('\nother fields:', JSON.stringify(other, null, 1).slice(0, 1500));
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
