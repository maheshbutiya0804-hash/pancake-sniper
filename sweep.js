// sweep.js
//
// Runs the backtester across a grid of signal configs and ranks the results,
// so tuning is "read a table" instead of "manually edit .env and rerun".
// Respects ENABLE_CROSS_ASSET/CROSS_ASSET_SYMBOL from .env - if set, every
// grid point is tested WITH cross-asset confirmation on.
//
// sweepConfigs() is exported so walkforward.js can reuse the exact same grid
// search as a "train on this chunk" step, rather than duplicating it.
//
// IMPORTANT: this ranks configs against the SAME historical window they're
// tested on. Picking "the best" from that ranking and trusting it blindly is
// classic overfitting to noise - see walkforward.js for a real out-of-sample
// check, or at minimum re-run this after time has passed.
//
// Usage: node sweep.js

import 'dotenv/config';
import { pathToFileURL } from 'url';
import { simulate, loadHistoricalTicks } from './backtest.js';

const {
  VOLATILITY_WINDOW_SECONDS = '300',
  VOLATILITY_BUCKET_SECONDS = '5',
  BACKTEST_HOURS = '24',
  BACKTEST_SYMBOL = 'BNBUSDT',
  ENABLE_CROSS_ASSET = 'false',
  CROSS_ASSET_SYMBOL = 'btcusdt',
} = process.env;

const fixed = {
  volatilityWindowSeconds: Number(VOLATILITY_WINDOW_SECONDS),
  volatilityBucketSeconds: Number(VOLATILITY_BUCKET_SECONDS),
};
const backtestHours = Number(BACKTEST_HOURS);
const crossAssetEnabled = ENABLE_CROSS_ASSET === 'true';

export const SHORT_GRID = [5, 10, 15];
export const LONG_GRID = [30, 45, 60];
export const Z_GRID = [0.5, 1.0, 1.5, 2.0];
export const DEFAULT_MIN_SAMPLE = 20;

/**
 * Grid-searches SHORT_GRID x LONG_GRID x Z_GRID against `ticks` (+ optional
 * `crossAssetTicks`), merging in `fixedCfg` (volatilityWindowSeconds etc.).
 * Returns configs with >= minSample decided rounds, ranked by win rate
 * descending. Pure function - no I/O, no logging - so it can be called
 * repeatedly per fold in walkforward.js.
 */
export function sweepConfigs(ticks, crossAssetTicks, fixedCfg, { minSample = DEFAULT_MIN_SAMPLE } = {}) {
  const results = [];
  for (const shortLookbackSeconds of SHORT_GRID) {
    for (const longLookbackSeconds of LONG_GRID) {
      if (longLookbackSeconds <= shortLookbackSeconds) continue;
      for (const zScoreThreshold of Z_GRID) {
        const cfg = { ...fixedCfg, shortLookbackSeconds, longLookbackSeconds, zScoreThreshold };
        const { stats } = simulate(ticks, cfg, crossAssetTicks);
        const decided = stats.wins + stats.losses;
        const winRate = decided ? (stats.wins / decided) * 100 : 0;
        results.push({ shortLookbackSeconds, longLookbackSeconds, zScoreThreshold, decided, winRate, stats });
      }
    }
  }
  return results.filter((r) => r.decided >= minSample).sort((a, b) => b.winRate - a.winRate);
}

async function main() {
  const ticks = await loadHistoricalTicks(BACKTEST_SYMBOL, backtestHours);
  const crossAssetTicks = crossAssetEnabled
    ? await loadHistoricalTicks(CROSS_ASSET_SYMBOL.toUpperCase(), backtestHours)
    : null;

  const totalConfigs = SHORT_GRID.length * LONG_GRID.length * Z_GRID.length;
  console.log(`\nSweeping up to ${totalConfigs} configs over ${ticks.length}s of ${BACKTEST_SYMBOL} data${crossAssetEnabled ? ` (+ ${CROSS_ASSET_SYMBOL.toUpperCase()} cross-check)` : ''}...\n`);

  const ranked = sweepConfigs(ticks, crossAssetTicks, fixed);

  console.log(`Configs with at least ${DEFAULT_MIN_SAMPLE} decided rounds, ranked by win rate:\n`);
  console.log('short  long   zThresh  decided  wins  losses  winRate');
  for (const r of ranked.slice(0, 15)) {
    console.log(
      `${String(r.shortLookbackSeconds).padStart(5)}  ${String(r.longLookbackSeconds).padStart(4)}   ${r.zScoreThreshold.toFixed(1).padStart(7)}  ${String(r.decided).padStart(7)}  ${String(r.stats.wins).padStart(4)}  ${String(r.stats.losses).padStart(6)}  ${r.winRate.toFixed(1)}%`
    );
  }

  if (!ranked.length) {
    console.log(`No config reached ${DEFAULT_MIN_SAMPLE} decided rounds in this window - try a longer BACKTEST_HOURS.`);
    return;
  }

  const best = ranked[0];
  console.log(`\nTop by win rate (min ${DEFAULT_MIN_SAMPLE}-round sample): SHORT_LOOKBACK_SECONDS=${best.shortLookbackSeconds} LONG_LOOKBACK_SECONDS=${best.longLookbackSeconds} Z_SCORE_THRESHOLD=${best.zScoreThreshold}`);
  console.log('This is the best fit to THIS historical window, not a guaranteed future edge - run walkforward.js for an out-of-sample check before trusting it live.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[sweep] fatal error:', err);
    process.exit(1);
  });
}
