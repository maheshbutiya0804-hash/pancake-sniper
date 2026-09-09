// walkforward.js
//
// The real test of whether sweep.js found an edge or just fit noise: split
// history into sequential folds, pick the best config on fold N using the
// same grid search sweep.js uses, then test that exact config UNTOUCHED on
// fold N+1 (data it never saw). Repeat, rolling forward. If the out-of-sample
// win rate holds up anywhere near the in-sample ("training") win rate, that's
// real evidence of an edge. If it collapses toward 50%, the sweep was fitting
// noise in each window, not finding something that persists.
//
// Usage: node walkforward.js

import 'dotenv/config';
import { simulate, loadHistoricalTicks } from './backtest.js';
import { sweepConfigs } from './sweep.js';

const {
  VOLATILITY_WINDOW_SECONDS = '300',
  VOLATILITY_BUCKET_SECONDS = '5',
  BACKTEST_HOURS = '24',
  BACKTEST_SYMBOL = 'BNBUSDT',
  ENABLE_CROSS_ASSET = 'false',
  CROSS_ASSET_SYMBOL = 'btcusdt',
  WALKFORWARD_FOLDS = '4',
  WALKFORWARD_MIN_SAMPLE = '15',
} = process.env;

const fixed = {
  volatilityWindowSeconds: Number(VOLATILITY_WINDOW_SECONDS),
  volatilityBucketSeconds: Number(VOLATILITY_BUCKET_SECONDS),
};
const backtestHours = Number(BACKTEST_HOURS);
const crossAssetEnabled = ENABLE_CROSS_ASSET === 'true';
const numFolds = Number(WALKFORWARD_FOLDS);
const minSample = Number(WALKFORWARD_MIN_SAMPLE);

function splitIntoFolds(ticks, n) {
  const startTime = ticks[0].time;
  const endTime = ticks[ticks.length - 1].time;
  const foldMs = (endTime - startTime) / n;
  const folds = [];
  for (let i = 0; i < n; i++) {
    const foldStart = startTime + i * foldMs;
    const foldEnd = i === n - 1 ? endTime : startTime + (i + 1) * foldMs;
    folds.push(ticks.filter((t) => t.time >= foldStart && t.time <= foldEnd));
  }
  return folds;
}

async function main() {
  if (numFolds < 2) {
    console.error('[walkforward] WALKFORWARD_FOLDS must be at least 2 (need a train fold and a test fold).');
    process.exit(1);
  }

  const ticks = await loadHistoricalTicks(BACKTEST_SYMBOL, backtestHours);
  const crossAssetTicksFull = crossAssetEnabled
    ? await loadHistoricalTicks(CROSS_ASSET_SYMBOL.toUpperCase(), backtestHours)
    : null;

  const priceFolds = splitIntoFolds(ticks, numFolds);
  const crossFolds = crossAssetTicksFull ? splitIntoFolds(crossAssetTicksFull, numFolds) : null;

  console.log(`\nWalk-forward validation: ${numFolds} folds over ${backtestHours}h of ${BACKTEST_SYMBOL} (~${(backtestHours / numFolds).toFixed(1)}h/fold)\n`);

  const foldResults = [];
  for (let i = 0; i < numFolds - 1; i++) {
    const trainTicks = priceFolds[i];
    const testTicks = priceFolds[i + 1];
    const trainCross = crossFolds ? crossFolds[i] : null;
    const testCross = crossFolds ? crossFolds[i + 1] : null;

    const ranked = sweepConfigs(trainTicks, trainCross, fixed, { minSample });
    if (!ranked.length) {
      console.log(`Fold ${i + 1}->${i + 2}: no config reached ${minSample} decided rounds while training - skipped`);
      continue;
    }

    const best = ranked[0];
    const testCfg = {
      ...fixed,
      shortLookbackSeconds: best.shortLookbackSeconds,
      longLookbackSeconds: best.longLookbackSeconds,
      zScoreThreshold: best.zScoreThreshold,
    };
    const { stats: testStats } = simulate(testTicks, testCfg, testCross);
    const testDecided = testStats.wins + testStats.losses;
    const testWinRate = testDecided ? (testStats.wins / testDecided) * 100 : null;

    console.log(
      `Fold ${i + 1}->${i + 2}: trained short=${best.shortLookbackSeconds} long=${best.longLookbackSeconds} z=${best.zScoreThreshold} ` +
      `(train: ${best.winRate.toFixed(1)}% over ${best.decided} rounds)`
    );
    console.log(`  out-of-sample: ${testDecided ? testWinRate.toFixed(1) + '%' : 'n/a'} over ${testDecided} rounds`);

    if (testWinRate != null) foldResults.push({ trainWinRate: best.winRate, testWinRate, testDecided });
  }

  if (!foldResults.length) {
    console.log('\nNo fold produced a valid out-of-sample test - try more BACKTEST_HOURS or fewer WALKFORWARD_FOLDS.');
    return;
  }

  const avgTrain = foldResults.reduce((s, f) => s + f.trainWinRate, 0) / foldResults.length;
  const avgTest = foldResults.reduce((s, f) => s + f.testWinRate, 0) / foldResults.length;
  const gap = avgTrain - avgTest;

  console.log(`\nAverage in-sample (train) win rate:  ${avgTrain.toFixed(1)}%`);
  console.log(`Average out-of-sample (test) win rate: ${avgTest.toFixed(1)}%`);

  if (gap > 10) {
    console.log(`\nGap of ${gap.toFixed(1)}pp between train and test - a drop this size usually means the sweep is fitting noise in each window, not finding something durable.`);
  } else if (avgTest > 51.5) {
    console.log('\nOut-of-sample win rate holds up above the ~51.5% breakeven line - more encouraging, though still only one historical period. Worth rerunning after more time has passed.');
  } else {
    console.log('\nOut-of-sample win rate sits at or below breakeven - no evidence yet of an edge that survives outside the window it was picked on.');
  }
}

main().catch((err) => {
  console.error('[walkforward] fatal error:', err);
  process.exit(1);
});
