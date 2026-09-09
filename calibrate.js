// calibrate.js
//
// Checks whether z-score actually tracks confidence: buckets every historical
// decision by |z-score| and reports the win rate per bucket. If win rate
// climbs with z-score, the threshold/sizing system rests on a real signal.
// If it's flat or noisy, z-score is just a pass/fail filter, not a graded
// confidence measure - worth knowing before building anything (like
// confidence-weighted sizing) that assumes otherwise.
//
// Deliberately runs with zScoreThreshold=0 regardless of your .env, so every
// decision the timeframe/cross-asset checks would allow gets bucketed - not
// just the ones that would have cleared your live Z_SCORE_THRESHOLD.
//
// Usage: node calibrate.js

import 'dotenv/config';
import { simulate, loadHistoricalTicks } from './backtest.js';

const {
  SHORT_LOOKBACK_SECONDS = '10',
  LONG_LOOKBACK_SECONDS = '45',
  VOLATILITY_WINDOW_SECONDS = '300',
  VOLATILITY_BUCKET_SECONDS = '5',
  BACKTEST_HOURS = '24',
  BACKTEST_SYMBOL = 'BNBUSDT',
  ENABLE_CROSS_ASSET = 'false',
  CROSS_ASSET_SYMBOL = 'btcusdt',
} = process.env;

const cfg = {
  shortLookbackSeconds: Number(SHORT_LOOKBACK_SECONDS),
  longLookbackSeconds: Number(LONG_LOOKBACK_SECONDS),
  volatilityWindowSeconds: Number(VOLATILITY_WINDOW_SECONDS),
  volatilityBucketSeconds: Number(VOLATILITY_BUCKET_SECONDS),
  zScoreThreshold: 0, // capture the full range of z-scores, not just what your live threshold would pass
};

const BUCKETS = [
  { label: '0.0-0.5', min: 0, max: 0.5 },
  { label: '0.5-1.0', min: 0.5, max: 1.0 },
  { label: '1.0-1.5', min: 1.0, max: 1.5 },
  { label: '1.5-2.0', min: 1.5, max: 2.0 },
  { label: '2.0-3.0', min: 2.0, max: 3.0 },
  { label: '3.0+', min: 3.0, max: Infinity },
];

async function main() {
  const backtestHours = Number(BACKTEST_HOURS);
  const ticks = await loadHistoricalTicks(BACKTEST_SYMBOL, backtestHours);
  const crossAssetTicks = ENABLE_CROSS_ASSET === 'true'
    ? await loadHistoricalTicks(CROSS_ASSET_SYMBOL.toUpperCase(), backtestHours)
    : null;

  const { decisions } = simulate(ticks, cfg, crossAssetTicks);
  const resolved = decisions.filter((d) => d.outcome === 'BULL' || d.outcome === 'BEAR');

  console.log(`\n=== Z-score calibration: ${resolved.length} resolved decisions over ${backtestHours}h ===\n`);
  console.log('zScore range  count   wins   winRate');
  for (const bucket of BUCKETS) {
    const inBucket = resolved.filter((d) => Math.abs(d.zScore) >= bucket.min && Math.abs(d.zScore) < bucket.max);
    if (!inBucket.length) {
      console.log(`${bucket.label.padEnd(12)}  ${'0'.padStart(5)}   ${'-'.padStart(4)}   n/a`);
      continue;
    }
    const wins = inBucket.filter((d) => d.action === d.outcome).length;
    const winRate = (wins / inBucket.length) * 100;
    console.log(`${bucket.label.padEnd(12)}  ${String(inBucket.length).padStart(5)}   ${String(wins).padStart(4)}   ${winRate.toFixed(1)}%`);
  }

  console.log(
    '\nIf win rate climbs as the z-score range rises, z-score is tracking real\n' +
    'confidence - worth leaning on for graded position sizing later. If it\'s\n' +
    'flat or bounces around with no clear trend (common with a small sample),\n' +
    'treat z-score as a pass/fail filter only, not a dial you can size more\n' +
    'finely against. A longer BACKTEST_HOURS gives sturdier per-bucket counts.'
  );
}

main().catch((err) => {
  console.error('[calibrate] fatal error:', err);
  process.exit(1);
});
