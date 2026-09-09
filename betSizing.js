import { ethers } from 'ethers';

// betSizing.js
//
// Uses the current round's BULL/BEAR pool split to decide (a) whether a bet
// is even worth making, and (b) how much to stake if so. This does NOT
// improve prediction accuracy - it changes what you earn from a given
// accuracy, by favoring the side the crowd is under-betting (which pays
// more if it wins) and skipping/shrinking bets on an overcrowded side.
//
// CAVEAT: this can't be meaningfully backtested with backtest.js, because
// historical pool splits (bullAmount/bearAmount per round) aren't available
// from Binance price data - they're PancakeSwap-specific on-chain state.
// Evaluate this in DRY_RUN first and watch the simulated stakes/logs.

/**
 * Implied payout multiplier if `direction` wins this round, estimated from
 * the pool BEFORE our own bet is added (a fine approximation since our
 * stake is normally small relative to the pool).
 */
export function impliedPayoutMultiplier({ bullAmount, bearAmount, direction, treasuryFeePct }) {
  const total = bullAmount + bearAmount;
  const winningSide = direction === 'BULL' ? bullAmount : bearAmount;
  if (winningSide === 0n) return null; // no bets yet on that side - can't estimate, but multiplier would be enormous
  const feeMultiplierBps = BigInt(Math.round((100 - treasuryFeePct) * 100)); // e.g. 3% fee -> 9700
  // (total * (1 - fee)) / winningSide, done in fixed point to stay in BigInt math
  const numerator = total * feeMultiplierBps;
  const denominator = winningSide * 10000n;
  return Number(numerator) / Number(denominator);
}

/**
 * Decide whether to bet and how much, given the implied payout multiplier.
 * Returns 0n if the multiplier doesn't clear `minPayoutMultiplier`. Otherwise
 * scales linearly between betAmountMinBnb and betAmountMaxBnb as the
 * multiplier ranges from minPayoutMultiplier to maxPayoutMultiplierForSizing
 * (clamped beyond that, so one lopsided round can't blow past your max).
 */
export function sizeBetWei(payoutMultiplier, cfg) {
  if (payoutMultiplier == null || payoutMultiplier < cfg.minPayoutMultiplier) return 0n;

  const clamped = Math.min(payoutMultiplier, cfg.maxPayoutMultiplierForSizing);
  const range = cfg.maxPayoutMultiplierForSizing - cfg.minPayoutMultiplier;
  const t = range > 0 ? (clamped - cfg.minPayoutMultiplier) / range : 1;
  const betBnb = cfg.betAmountMinBnb + t * (cfg.betAmountMaxBnb - cfg.betAmountMinBnb);
  return ethers.parseEther(betBnb.toFixed(6));
}
