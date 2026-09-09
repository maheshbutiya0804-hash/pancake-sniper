// signal.js
//
// The core decision logic, shared by bot.js (live) and backtest.js
// (historical replay) so a backtest result actually reflects what the live
// bot would do with the same config. Combines three things:
//
//   1. Volume-weighted momentum - moves backed by bigger trades count more
//      than the same price change on thin volume.
//   2. Multi-timeframe confirmation - a short and a long lookback must agree
//      on direction, which filters out a lot of single-window noise.
//   3. Volatility-adjusted threshold - the momentum is judged in standard
//      deviations of *recent* volatility, not a fixed % cutoff, so the bar
//      adapts to calm vs choppy conditions instead of being one-size-fits-all.

// Volume-weighted average price for a list of {price, qty} ticks.
export function vwap(ticks) {
  if (!ticks.length) return null;
  let sumPQ = 0;
  let sumQ = 0;
  for (const t of ticks) {
    sumPQ += t.price * t.qty;
    sumQ += t.qty;
  }
  if (sumQ === 0) return ticks.reduce((s, t) => s + t.price, 0) / ticks.length;
  return sumPQ / sumQ;
}

// Volume-weighted momentum over a window: VWAP of the window's earlier half
// vs VWAP of its later half. More robust to single-trade noise than a plain
// first-tick-vs-last-tick comparison, and naturally weights bigger trades.
export function windowMomentum(ticks, windowSeconds, now) {
  const cutoff = now - windowSeconds * 1000;
  const inWindow = ticks.filter((t) => t.time >= cutoff && t.time <= now);
  if (inWindow.length < 4) return null; // not enough data for a stable read

  const midTime = (inWindow[0].time + inWindow[inWindow.length - 1].time) / 2;
  const early = inWindow.filter((t) => t.time <= midTime);
  const late = inWindow.filter((t) => t.time > midTime);
  if (!early.length || !late.length) return null;

  const earlyVwap = vwap(early);
  const lateVwap = vwap(late);
  if (!earlyVwap) return null;

  const pctChange = ((lateVwap - earlyVwap) / earlyVwap) * 100;
  return { pctChange, earlyVwap, lateVwap, sampleCount: inWindow.length };
}

// Recent volatility: standard deviation of % returns between VWAP buckets of
// `bucketSeconds` width, across the last `windowSeconds`. This is the
// "typical move size" baseline the momentum gets judged against.
export function recentVolatilityPct(ticks, windowSeconds, bucketSeconds, now) {
  const cutoff = now - windowSeconds * 1000;
  const inWindow = ticks.filter((t) => t.time >= cutoff && t.time <= now);
  if (inWindow.length < 4) return null;

  const buckets = new Map();
  for (const t of inWindow) {
    const key = Math.floor(t.time / (bucketSeconds * 1000));
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(t);
  }
  const bucketVwaps = [...buckets.keys()].sort((a, b) => a - b).map((k) => vwap(buckets.get(k)));
  if (bucketVwaps.length < 3) return null;

  const returns = [];
  for (let i = 1; i < bucketVwaps.length; i++) {
    returns.push(((bucketVwaps[i] - bucketVwaps[i - 1]) / bucketVwaps[i - 1]) * 100);
  }
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

/**
 * The composite decision. `ticks` should be {price, qty, time}[], `now` a ms
 * timestamp, `cfg` = { shortLookbackSeconds, longLookbackSeconds,
 * volatilityWindowSeconds, volatilityBucketSeconds, zScoreThreshold }.
 * `crossAssetTicks` is optional - when provided (e.g. BTC ticks), its long-
 * window momentum must agree in direction too, as a fourth, independent vote
 * alongside the short/long timeframe agreement. Pass null/undefined to skip
 * this check entirely (the original 3-part signal, unchanged).
 * Returns { action: 'BULL' | 'BEAR' | 'SKIP', reason, short, long, crossAsset?, vol?, zScore? }.
 */
export function decide(ticks, now, cfg, crossAssetTicks = null) {
  const short = windowMomentum(ticks, cfg.shortLookbackSeconds, now);
  const long = windowMomentum(ticks, cfg.longLookbackSeconds, now);
  if (!short || !long) {
    return { action: 'SKIP', reason: 'insufficient data', short, long };
  }

  const agree = Math.sign(short.pctChange) === Math.sign(long.pctChange) && long.pctChange !== 0;
  if (!agree) {
    return { action: 'SKIP', reason: 'timeframes disagree', short, long };
  }

  let crossAsset = null;
  if (crossAssetTicks) {
    crossAsset = windowMomentum(crossAssetTicks, cfg.longLookbackSeconds, now);
    if (!crossAsset) {
      return { action: 'SKIP', reason: 'insufficient cross-asset data', short, long };
    }
    const crossAgrees = Math.sign(crossAsset.pctChange) === Math.sign(long.pctChange) && crossAsset.pctChange !== 0;
    if (!crossAgrees) {
      return { action: 'SKIP', reason: 'cross-asset disagrees', short, long, crossAsset };
    }
  }

  const vol = recentVolatilityPct(ticks, cfg.volatilityWindowSeconds, cfg.volatilityBucketSeconds, now);
  if (!vol) {
    return { action: 'SKIP', reason: 'insufficient volatility data', short, long, crossAsset };
  }

  const safeVol = Math.max(vol, 0.001); // floor so near-zero volatility can't blow up the z-score
  const zScore = long.pctChange / safeVol;
  if (Math.abs(zScore) < cfg.zScoreThreshold) {
    return { action: 'SKIP', reason: 'below volatility-adjusted threshold', short, long, crossAsset, vol, zScore };
  }

  const direction = long.pctChange > 0 ? 'BULL' : 'BEAR';
  return { action: direction, reason: 'signal confirmed', short, long, crossAsset, vol, zScore };
}
