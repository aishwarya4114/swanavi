/**
 * Bind a decoded x402 PAYMENT-REQUIRED challenge (@ap4m/sdk X402PaymentRequired, x402Version 2,
 * scheme batch-settlement) to this trip before anything is signed. A price-only check would let a
 * seller redirect payment to another channel, token, ledger, chain or payout wallet.
 * Pure: no SDK, no key, no network. ap4m_executor.mjs calls it from quote().
 */

export class ChallengeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChallengeError';
    this.code = 'challenge_mismatch';
  }
}

const same = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();

/**
 * @param {object} required decoded PAYMENT-REQUIRED body
 * @param {{ resourceUrl: string, chainId: number|bigint, asset: string, ledger: string, channelId: string, payTo: string }} expected
 * @returns the accepted payment requirement the executor will answer
 */
export function checkPaymentRequired(required, expected) {
  if (!required || required.x402Version !== 2) throw new ChallengeError('Challenge is not x402 version 2.');
  if (!Array.isArray(required.accepts) || required.accepts.length !== 1) {
    throw new ChallengeError('Challenge must offer exactly one payment requirement.');
  }
  const accepted = required.accepts[0];
  if (accepted.scheme !== 'batch-settlement') throw new ChallengeError(`Unexpected scheme ${accepted.scheme}.`);
  if (accepted.network !== `eip155:${expected.chainId}`) throw new ChallengeError(`Challenge network ${accepted.network} is not eip155:${expected.chainId}.`);
  if (!same(accepted.asset, expected.asset)) throw new ChallengeError('Challenge asset is not the configured RLUSD token.');
  if (!same(accepted.payTo, expected.payTo)) throw new ChallengeError('Challenge payTo is not the channel payout.');
  if (!same(accepted.extra?.ledger, expected.ledger)) throw new ChallengeError('Challenge ledger is not the configured payment ledger.');
  if (!same(accepted.extra?.channelId, expected.channelId)) throw new ChallengeError('Challenge is for another channel.');
  if (typeof accepted.amount !== 'string' || !/^[1-9]\d*$/.test(accepted.amount)) throw new ChallengeError('Challenge amount is not a positive integer.');
  // The seller names its own host (loopback or a proxy), so only the path is bound.
  let path = null;
  try { path = new URL(required.resource?.url).pathname; } catch { path = null; }
  if (path !== new URL(expected.resourceUrl).pathname) throw new ChallengeError('Challenge is for another resource.');
  return accepted;
}
