import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Scripts read keys from the environment only: no home-directory path and no .env file name may appear.
const namesKeyFile = (source) => /~\/[\w.-]+|(?<![\w.])(?!process\b)[\w-]+\.env\b/.test(source);

test('live_channel_open_close reserves 2 RLUSD and does not sign a payment', () => {
  const source = readFileSync(new URL('../scripts/live_channel_open_close.mjs', import.meta.url), 'utf8');
  assert.match(source, /const CAP_RLUSD = '2'/);
  assert.equal(/signVoucher\s*\(/.test(source), false);
  assert.equal(/redeemVoucher\s*\(/.test(source), false);
  assert.equal(/\bsettle\s*\(/.test(source), false);
  assert.equal(namesKeyFile(source), false);
  assert.equal(source.includes('EVM_PRIVATE_KEY'), false);
  assert.match(source, /requestChannel\(/);
  assert.match(source, /closeChannel\(/);
});

test('live_over_cap simulates a control and cap + 1 wei, blocks sends until the simulation reverted, never opens or closes', () => {
  const source = readFileSync(new URL('../scripts/live_over_cap.mjs', import.meta.url), 'utf8');
  assert.match(source, /CONTROL_AMOUNT = ethers\.parseUnits\('0\.01', 18\)/);
  assert.match(source, /before\.cap \+ 1n/);
  assert.match(source, /\/\^eth_send\/\.test\(method\) && !armed/);
  assert.match(source, /process\.exit\(3\)/);
  assert.match(source, /process\.exit\(4\)/);
  assert.match(source, /gasLimit: GAS_LIMIT/);
  // Only signVoucher and the ABI come from the SDK; the names openChannel/closeChannel appear
  // solely inside the printed ledger function list, never as calls.
  assert.match(source, /const \{ signVoucher, PAYMENT_LEDGER_ABI \} = require\('\.\.\/ap4m-hackathon-sdk\.js'\)/);
  assert.equal(/requestChannel\s*\(/.test(source), false);
  assert.equal(/closeChannel\s*\(/.test(source), false);
  assert.equal(/\bsettle\s*\(/.test(source), false);
  assert.equal(namesKeyFile(source), false);
  assert.equal(source.includes('EVM_PRIVATE_KEY'), false);
});

test('live_trip pays at most 0.02 on the fixed channel, never opens a channel, settles before close', () => {
  const source = readFileSync(new URL('../scripts/live_trip.mjs', import.meta.url), 'utf8');
  assert.match(source, /MAX_PAYOUT = ethers\.parseUnits\('0\.02', 18\)/);
  assert.match(source, /checkOutgoingTransaction\(params\[0\]/);
  assert.equal(source.includes('requestChannel'), false);
  assert.ok(source.indexOf('await settle(') < source.indexOf('await closeChannel('), 'settle must come before close');
  assert.equal(namesKeyFile(source), false);
  assert.equal(source.includes('EVM_PRIVATE_KEY'), false);
});

test('close_channel sends no transaction and names no key file', () => {
  const source = readFileSync(new URL('../scripts/close_channel.mjs', import.meta.url), 'utf8');
  assert.match(source, /\/\^eth_send\/\.test\(m\)/);
  assert.equal(source.includes('requestChannel'), false);
  assert.equal(source.includes('redeemVoucher('), false);
  assert.equal(namesKeyFile(source), false);
  assert.equal(source.includes('EVM_PRIVATE_KEY'), false);
});

test('read-only helpers name no key file', () => {
  for (const file of ['../scripts/chain_inspect.mjs']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.equal(namesKeyFile(source), false, file);
    assert.equal(source.includes('EVM_PRIVATE_KEY'), false, file);
  }
});

test('Phase C scripts: merchant registration signs only, channel opening needs CONFIRM_OPEN, no key file names', () => {
  const status = readFileSync(new URL('../scripts/merchant_status.mjs', import.meta.url), 'utf8');
  const register = readFileSync(new URL('../scripts/register_merchant.mjs', import.meta.url), 'utf8');
  const open = readFileSync(new URL('../scripts/live_merchant_channel.mjs', import.meta.url), 'utf8');
  for (const [name, source] of [['merchant_status', status], ['register_merchant', register], ['live_merchant_channel', open]]) {
    assert.equal(namesKeyFile(source), false, name);
    assert.equal(source.includes('EVM_PRIVATE_KEY'), false, name);
    // a key value must never be interpolated into output
    assert.equal(/\$\{[^}]*(PRIVATE_KEY|privateKey|merchantKey|agentKey)[^}]*\}/.test(source), false, name);
    assert.equal(/console\.(log|error)\(\s*(merchantKey|agentKey|key)\s*[,)]/.test(source), false, name);
  }
  assert.match(status, /OUR_MERCHANT_WALLET = '0x4581492018e07F81F055D15BC7EBab4957A1Ce0C'/);
  assert.match(register, /EXPECTED_WALLET = '0x4581492018e07F81F055D15BC7EBab4957A1Ce0C'/);
  assert.match(open, /import \{ OUR_MERCHANT_WALLET, readBalances \} from '\.\/merchant_status\.mjs'/);
  assert.equal(status.includes('requestChannel('), false);
  assert.equal(status.includes('sendTransaction'), false);
  assert.equal(register.includes('sendTransaction'), false);
  assert.equal(register.includes('requestChannel('), false);
  assert.match(register, /wallet-challenge/);
  assert.match(register, /CONFIRM_REGISTER !== 'yes'/);
  assert.match(register, /merchant\.signMessage\(challenge\.message\)/);
  assert.match(open, /CONFIRM_OPEN !== 'yes'/);
  assert.match(open, /merchant_is_pool !== false/);
  assert.match(open, /onChain\.payout\.toLowerCase\(\) !== OUR_MERCHANT_WALLET\.toLowerCase\(\)/);
  assert.match(open, /PAY above 0\.02 is not allowed/);
  assert.equal(open.includes('closeChannel('), false);
});