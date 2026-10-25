/**
 * Register our own merchant payout wallet with the AP4M service from the terminal, doing exactly
 * what the portal's "Add my wallet" button does (read from /participant.js):
 *
 *   1. POST /public/participant/wallet-challenge { role: 'merchant', wallet }   (team session)
 *   2. personal_sign of the returned challenge message BY THE MERCHANT WALLET
 *   3. POST /public/participant/merchant { challenge_id, signature }
 *
 * The portal needs the merchant key inside a browser wallet extension for step 2. This script
 * signs the same message with ethers (signMessage == personal_sign, EIP-191) so the key can stay
 * in your environment. No transaction is sent. No key is printed or sent; only two signatures
 * leave this process: the agent's sign-in message and the merchant's challenge message.
 *
 * The challenge message is printed before it is signed so you can see what you sign. It is issued
 * by the service, so its exact wording comes from them; it names the role and the wallet.
 *
 *   AGENT_PRIVATE_KEY=0x...  MERCHANT_PRIVATE_KEY=0x...  CONFIRM_REGISTER=yes  node register_merchant.mjs
 *
 * This is a one-way choice: once the team has its own merchant, the portal hides the pool option.
 */

import { createRequire } from 'node:module';
import { ethers } from 'ethers';

const require = createRequire(import.meta.url);
const sdk = require('../ap4m-hackathon-sdk.js');

const API = process.env.AP4M_API_URL || 'https://hackathon.ap4m.build';
const EXPECTED_WALLET = '0x4581492018e07F81F055D15BC7EBab4957A1Ce0C';

async function main() {
  const agentKey = process.env.AGENT_PRIVATE_KEY;
  const merchantKey = process.env.MERCHANT_PRIVATE_KEY;
  if (!agentKey || !merchantKey) throw new Error('Set AGENT_PRIVATE_KEY (team sign-in) and MERCHANT_PRIVATE_KEY (signs the merchant challenge).');
  const merchant = new ethers.Wallet(merchantKey);
  if (merchant.address.toLowerCase() !== EXPECTED_WALLET.toLowerCase()) {
    throw new Error(`MERCHANT_PRIVATE_KEY controls ${merchant.address}, not the expected ${EXPECTED_WALLET}. Stopping.`);
  }
  const agent = new ethers.Wallet(agentKey);
  const session = await sdk.signIn(API, process.env.TEAM_NAME || 'Swanavi', agent);
  const headers = { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' };

  const me = await (await fetch(`${API}/public/participant/me`, { headers })).json();
  const team = me.team ?? me;
  console.log(`team ${team.team_name ?? '?'}; current merchant payout ${team.merchant_wallet ?? '(none)'} (pool: ${team.merchant_is_pool})`);
  if (team.merchant_id && team.merchant_is_pool === false) {
    console.log(`The team already has its own merchant payout ${team.merchant_wallet}. Nothing to do.`);
    return;
  }

  const challengeResp = await fetch(`${API}/public/participant/wallet-challenge`, {
    method: 'POST', headers, body: JSON.stringify({ role: 'merchant', wallet: merchant.address }),
  });
  const challenge = await challengeResp.json();
  if (!challengeResp.ok) throw new Error(`wallet-challenge failed (${challengeResp.status}): ${challenge.error ?? JSON.stringify(challenge)}`);
  console.log('\nThe service asks the merchant wallet to sign this message (personal_sign, nothing on chain):');
  console.log('-----');
  console.log(challenge.message);
  console.log('-----');
  if (process.env.CONFIRM_REGISTER !== 'yes') {
    console.log('\nNot signed. Re-run with CONFIRM_REGISTER=yes to sign it and register the wallet.');
    return;
  }
  const signature = await merchant.signMessage(challenge.message);
  const registerResp = await fetch(`${API}/public/participant/merchant`, {
    method: 'POST', headers, body: JSON.stringify({ challenge_id: challenge.challenge_id, signature }),
  });
  const result = await registerResp.json();
  if (!registerResp.ok) throw new Error(`merchant registration failed (${registerResp.status}): ${result.error ?? JSON.stringify(result)}`);
  console.log('\nregistered:', JSON.stringify(result, null, 1));
  const after = await (await fetch(`${API}/public/participant/me`, { headers })).json();
  const t = after.team ?? after;
  console.log(`\nnow: merchant id ${t.merchant_id}  payout ${t.merchant_wallet}  pool: ${t.merchant_is_pool}`);
  console.log('Use that merchant id as MERCHANT_ID for x402_sellers.mjs on the new channel.');
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
