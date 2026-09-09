// backtest.js
//
// Replays the exact same decide() logic bot.js uses live against historical
// price data, so you can evaluate a config's win rate in minutes instead of
// days of live dry-running. Supports the same cross-asset confirmation the
// live bot does, so a backtest with ENABLE_CROSS_ASSET=true actually tests
// that behavior rather than a simplified version of it.
//
// IMPORTANT CAVEATS - this is a useful guide, not a live-performance guarantee:
// - Uses Binance 1-second klines (close price + volume per second) as a
//   stand-in for the raw trade-by-trade stream the live bot consumes.
// - Simulates its own 5-minute round boundaries starting from whenever the
//   fetched window begins, rather than replaying PancakeSwap's actual
//   on-chain round timestamps or Chainlink oracle prices.
// - Does NOT model pool-imbalance bet sizing (ENABLE_POOL_SIZING) - historical
//   BULL/BEAR pool splits aren't available from Binance price data, only from
//   the PancakeSwap contract's on-chain history, which this doesn't fetch.
//   Evaluate that feature in dry run against live pool data instead.
//
// Usage: node backtest.js  (reads the same .env as bot.js, plus BACKTEST_HOURS)

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { decide } from './signal.js';

const {
  SHORT_LOOKBACK_SECONDS = '10',
  LONG_LOOKBACK_SECONDS = '45',
  VOLATILITY_WINDOW_SECONDS = '300',
  VOLATILITY_BUCKET_SECONDS = '5',
  Z_SCORE_THRESHOLD = '1.0',
  SNIPE_WINDOW_SECONDS = '10',
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
  zScoreThreshold: Number(Z_SCORE_THRESHOLD),
};
const snipeWindowMs = Number(SNIPE_WINDOW_SECONDS) * 1000;
const backtestHours = Number(BACKTEST_HOURS);
const crossAssetEnabled = ENABLE_CROSS_ASSET === 'true';
const ROUND_SECONDS = 300; // matches PancakeSwap's 5-minute round length

const CACHE_DIR = path.join(process.cwd(), 'historical_data');

async function fetchKlines(symbol, startTime, endTime) {
  const all = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&startTime=${cursor}&endTime=${endTime}&limit=1000`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Binance klines request failed: ${res.status} ${await res.text()}`);
    }
    const batch = await res.json();
    if (!batch.length) break;
    all.push(...batch);
    cursor = batch[batch.length - 1][0] + 1000;
    if (batch.length < 1000) break;
    process.stdout.write(`\r[backtest] fetched ${all.length} seconds so far...`);
  }
  if (all.length) process.stdout.write('\n');
  return all;
}

export async function loadHistoricalTicks(symbol, hours) {
  const endTime = Date.now();
  const startTime = endTime - hours * 60 * 60 * 1000;
  const cacheFile = path.join(CACHE_DIR, `${symbol}_1s_${startTime}_${endTime}.json`);

  if (fs.existsSync(cacheFile)) {
    console.log(`[backtest] using cached data: ${cacheFile}`);
    return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  }

  console.log(`[backtest] fetching ${hours}h of 1s klines for ${symbol} from Binance...`);
  const klines = await fetchKlines(symbol, startTime, endTime);
  const ticks = klines.map((k) => ({ time: k[0], price: parseFloat(k[4]), qty: parseFloat(k[5]) }));

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(ticks));
  console.log(`[backtest] fetched ${ticks.length}s of data, cached to ${cacheFile}`);
  return ticks;
}

function priceAt(ticks, targetTime, fromIndex = 0) {
  for (let i = fromIndex; i < ticks.length; i++) {
    if (ticks[i].time >= targetTime) return { price: ticks[i].price, index: i };
  }
  return { price: null, index: ticks.length };
}

export function simulate(ticks, simCfg, crossAssetTicks = null) {
  const stats = { wins: 0, losses: 0, ties: 0, skipped: 0 };
  const skipReasons = {};
  const decisions = []; // { zScore, action, outcome } for every non-skip round - used by calibrate.js
  if (ticks.length < 10) return { stats, skipReasons, decisions };

  const startTime = ticks[0].time;
  const endTime = ticks[ticks.length - 1].time;
  let priceScanIndex = 0;

  for (let roundStart = startTime; roundStart + ROUND_SECONDS * 1000 <= endTime; roundStart += ROUND_SECONDS * 1000) {
    const lockTime = roundStart + ROUND_SECONDS * 1000;
    const decisionTime = lockTime - snipeWindowMs;
    if (decisionTime < startTime) continue;

    const windowStart = decisionTime - simCfg.volatilityWindowSeconds * 1000;
    const bufferForDecision = ticks.filter((t) => t.time >= windowStart && t.time <= decisionTime);

    let crossBuffer = null;
    if (crossAssetTicks) {
      crossBuffer = crossAssetTicks.filter((t) => t.time >= windowStart && t.time <= decisionTime);
    }

    const result = decide(bufferForDecision, decisionTime, simCfg, crossBuffer);

    if (result.action === 'SKIP') {
      if (result.reason !== 'insufficient data' && result.reason !== 'insufficient cross-asset data') {
        stats.skipped += 1;
        skipReasons[result.reason] = (skipReasons[result.reason] || 0) + 1;
      }
      continue;
    }

    const lockPriceInfo = priceAt(ticks, lockTime, priceScanIndex);
    const closePriceInfo = priceAt(ticks, lockTime + ROUND_SECONDS * 1000, lockPriceInfo.index);
    priceScanIndex = lockPriceInfo.index;
    if (lockPriceInfo.price == null || closePriceInfo.price == null) continue;

    let outcome;
    if (closePriceInfo.price > lockPriceInfo.price) outcome = 'BULL';
    else if (closePriceInfo.price < lockPriceInfo.price) outcome = 'BEAR';
    else outcome = 'TIE';

    if (outcome === 'TIE') stats.ties += 1;
    else if (outcome === result.action) stats.wins += 1;
    else stats.losses += 1;

    decisions.push({ zScore: result.zScore, action: result.action, outcome });
  }

  return { stats, skipReasons, decisions };
}

async function main() {
  const ticks = await loadHistoricalTicks(BACKTEST_SYMBOL, backtestHours);
  const crossAssetTicks = crossAssetEnabled
    ? await loadHistoricalTicks(CROSS_ASSET_SYMBOL.toUpperCase(), backtestHours)
    : null;

  const { stats, skipReasons } = simulate(ticks, cfg, crossAssetTicks);

  const decided = stats.wins + stats.losses;
  const winRate = decided ? ((stats.wins / decided) * 100).toFixed(1) : '0.0';

  console.log('\n=== Backtest results ===');
  console.log(`Period: last ${backtestHours}h of ${BACKTEST_SYMBOL}${crossAssetEnabled ? ` (+ ${CROSS_ASSET_SYMBOL.toUpperCase()} cross-check)` : ''} (simulated 5-min round boundaries)`);
  console.log(`Config: short=${cfg.shortLookbackSeconds}s long=${cfg.longLookbackSeconds}s zThreshold=${cfg.zScoreThreshold} snipeWindow=${SNIPE_WINDOW_SECONDS}s`);
  console.log(`Rounds decided: ${decided} | Wins: ${stats.wins} | Losses: ${stats.losses} | Ties: ${stats.ties} | Skipped: ${stats.skipped}`);
  console.log(`Win rate: ${winRate}% (rough breakeven vs the 3% round fee is ~51.5%)`);
  console.log('Skip reasons:', skipReasons);
  if (!crossAssetEnabled) {
    console.log('\n(pool-imbalance bet sizing is not modeled here - see the README caveat)');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[backtest] fatal error:', err);
    process.exit(1);
  });
}
