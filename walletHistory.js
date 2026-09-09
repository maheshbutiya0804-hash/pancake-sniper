// walletHistory.js
//
// Finds a wallet's most recent bets on PancakeSwap Prediction by walking
// backward through epoch numbers and checking ledger(epoch, address)
// directly - NOT via eth_getLogs. Log queries turned out to be unreliable
// across RPC providers in a way block-range tuning can't fix (one free-tier
// provider caps eth_getLogs at a 5-block range - scanning a month of
// history that way would take hundreds of thousands of calls). ledger() is
// a plain contract read with no such restriction on any provider.
//
// findRecentBets/withRetry/describeOutcome are pure, side-effect-free
// exports - bot.js imports these directly for the dashboard's "target
// wallet history" table. All CLI-specific setup (reading argv/env, building
// a provider, validating an address, calling process.exit) lives inside
// main() and only runs when this file is executed directly, never on import.
//
// Usage: node walletHistory.js [address] [count]
// Defaults to COPY_WALLET_ADDRESS from .env and 10 bets if not given.

import 'dotenv/config';
import { ethers } from 'ethers';
import { pathToFileURL } from 'url';

export const CONTRACT_ABI = [
  'function currentEpoch() view returns (uint256)',
  'function ledger(uint256 epoch, address user) view returns (uint8 position, uint256 amount, bool claimed)',
  'function rounds(uint256) view returns (uint256 epoch, uint256 startTimestamp, uint256 lockTimestamp, uint256 closeTimestamp, int256 lockPrice, int256 closePrice, uint256 lockOracleId, uint256 closeOracleId, uint256 totalAmount, uint256 bullAmount, uint256 bearAmount, uint256 rewardBaseCalAmount, uint256 rewardAmount, bool oracleCalled)',
];

/**
 * Every RPC provider's actual rate limit is unknown in advance and varies
 * wildly (we've now hit both a 5-block eth_getLogs cap and a 15-req/second
 * flat cap from the same provider's free tier) - rather than guess another
 * fixed number that might still be wrong, this retries with exponential
 * backoff whenever a response looks like a rate-limit rejection, adapting
 * to whatever the real limit turns out to be instead of assuming one.
 */
export async function withRetry(fn, label, maxRetries = 5, baseDelayMs = 1000) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = `${err?.message ?? ''} ${err?.error?.message ?? ''} ${err?.shortMessage ?? ''}`;
      const isRateLimit = /rate.?limit|limit reached|too many requests|\b429\b/i.test(msg);
      if (!isRateLimit || attempt === maxRetries) throw err;
      const delay = baseDelayMs * 2 ** attempt;
      if (process.env.WALLET_HISTORY_QUIET !== 'true') {
        process.stdout.write(`\n[wallet-history] rate limited on ${label}, waiting ${delay}ms (retry ${attempt + 1}/${maxRetries})...\n`);
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}

/**
 * Pure control-flow logic, separated from the live contract calls so it can
 * be unit-tested against a mock. `getLedger(epoch)` should resolve to
 * {position, amount}. Walks backward from `currentEpoch`, grouping epochs
 * into chunks of `chunkSize` purely for progress-reporting granularity - the
 * actual request RATE is controlled independently by `minRequestIntervalMs`,
 * which staggers every individual request to its own time slot rather than
 * firing `chunkSize` requests in one burst and pausing. Firing N requests
 * simultaneously is what actually trips most rate limiters, even with a
 * pause between groups - a steady, evenly-spaced rate is far less likely to.
 * Stops once `needed` bets are found or `maxEpochsToScan` have been scanned.
 * A single epoch's failed read is skipped, not fatal - there are plenty of
 * other epochs to check. Rate-limit retries are the caller's responsibility
 * (via a wrapped `getLedger`), not this function's. `onProgress(scanned,
 * foundCount)`, if given, is called after each chunk.
 */
export async function findRecentBets(getLedger, currentEpoch, needed, maxEpochsToScan, chunkSize, minRequestIntervalMs = 0, onProgress) {
  const found = [];
  let epoch = currentEpoch;
  let scanned = 0;
  let nextSlotTime = 0; // shared, updated synchronously so concurrent calls each get a distinct, increasing slot

  async function paced(e) {
    const myTime = Math.max(Date.now(), nextSlotTime);
    nextSlotTime = myTime + minRequestIntervalMs; // reserved immediately, before this call's own await
    const wait = myTime - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return getLedger(e);
  }

  while (found.length < needed && scanned < maxEpochsToScan && epoch > 0n) {
    const chunkEpochs = [];
    for (let i = 0; i < chunkSize && epoch > 0n && scanned < maxEpochsToScan; i++) {
      chunkEpochs.push(epoch);
      epoch -= 1n;
      scanned++;
    }
    if (!chunkEpochs.length) break;

    const results = await Promise.allSettled(chunkEpochs.map((e) => paced(e)));

    for (let i = 0; i < chunkEpochs.length; i++) {
      const r = results[i];
      if (r.status === 'fulfilled' && r.value.amount > 0n) {
        found.push({
          epoch: chunkEpochs[i],
          direction: Number(r.value.position) === 0 ? 'BULL' : 'BEAR',
          amount: r.value.amount,
        });
      }
      // A rejected read just means we skip that one epoch - not fatal.
    }

    if (onProgress) {
      onProgress(scanned, found.length);
    } else if (process.env.WALLET_HISTORY_QUIET !== 'true') {
      process.stdout.write(`\rScanned ${scanned} epoch(s) back, found ${found.length} bet(s) so far...`);
    }
  }

  // Already in descending-epoch order since we scanned backward - no sort needed.
  return found.slice(0, needed);
}

/**
 * Given a round's on-chain data and a bet's direction, returns the outcome
 * exactly as PancakeSwap's contract determines it (confirmed against the
 * actual source): PENDING if not yet resolved, LOST on a tie (the "house
 * wins" branch - stake goes to treasury, not a push), otherwise WON/LOST.
 */
export function describeOutcome(round, direction) {
  if (!round.oracleCalled) return 'PENDING (round not resolved yet)';
  if (round.closePrice === round.lockPrice) return 'LOST (tie - house wins)';
  const outcome = round.closePrice > round.lockPrice ? 'BULL' : 'BEAR';
  return outcome === direction ? 'WON' : 'LOST';
}

// ---------------------------------------------------------------------------
// CLI entry point - everything below only runs when this file is executed
// directly (`node walletHistory.js`), never as a side effect of importing
// the functions above from another module (e.g. bot.js).
// ---------------------------------------------------------------------------
async function main() {
  const {
    RPC_URLS,
    RPC_URL,
    CONTRACT_ADDRESS = '0x18b2a687610328590bc8f2e5fedde3b582a49cda',
    COPY_WALLET_ADDRESS,
    WALLET_HISTORY_MAX_EPOCHS = '8640',           // ~30 days at ~288 rounds/day
    WALLET_HISTORY_CHUNK_SIZE = '20',             // epochs grouped per progress update - does NOT affect request rate
    WALLET_HISTORY_REQUEST_INTERVAL_MS = '150',   // minimum gap between EACH individual request (~6.7/sec, safe even if run alongside the bot)
    WALLET_HISTORY_MAX_RETRIES = '5',
    WALLET_HISTORY_RETRY_BASE_MS = '1000',
  } = process.env;

  const targetAddress = process.argv[2] || COPY_WALLET_ADDRESS;
  const count = Number(process.argv[3]) || 10;
  const rpcUrl = (RPC_URLS ? RPC_URLS.split(',')[0] : RPC_URL)?.trim();
  const maxEpochs = Number(WALLET_HISTORY_MAX_EPOCHS);
  const chunkSize = Number(WALLET_HISTORY_CHUNK_SIZE);
  const requestIntervalMs = Number(WALLET_HISTORY_REQUEST_INTERVAL_MS);
  const maxRetries = Number(WALLET_HISTORY_MAX_RETRIES);
  const retryBaseMs = Number(WALLET_HISTORY_RETRY_BASE_MS);

  if (!targetAddress || !ethers.isAddress(targetAddress)) {
    console.error('Usage: node walletHistory.js <address> [count]  (or set COPY_WALLET_ADDRESS in .env)');
    process.exit(1);
  }
  if (!rpcUrl) {
    console.error('No RPC_URL(S) found in .env');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, provider);

  console.log(`Searching for ${targetAddress}'s last ${count} bet(s) on the Prediction contract...\n`);

  const currentEpoch = await withRetry(() => contract.currentEpoch(), 'currentEpoch()', maxRetries, retryBaseMs);
  const bets = await findRecentBets(
    (epoch) => withRetry(() => contract.ledger(epoch, targetAddress), `ledger(${epoch})`, maxRetries, retryBaseMs),
    currentEpoch,
    count,
    maxEpochs,
    chunkSize,
    requestIntervalMs
  );
  console.log('');

  if (!bets.length) {
    const days = ((maxEpochs * 5) / 60 / 24).toFixed(1);
    console.log(`No bets found for this address in the last ${maxEpochs} epochs (~${days} days). Try a larger WALLET_HISTORY_MAX_EPOCHS if this wallet bets infrequently.`);
    return;
  }

  console.log('epoch      direction  amount         result');
  for (const bet of bets) {
    const round = await withRetry(() => contract.rounds(bet.epoch), `rounds(${bet.epoch})`, maxRetries, retryBaseMs);
    const result = describeOutcome(round, bet.direction);
    console.log(
      `${bet.epoch.toString().padEnd(10)} ${bet.direction.padEnd(9)}  ${ethers.formatEther(bet.amount).padEnd(13)}  ${result}`
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('fatal error:', err);
    process.exit(1);
  });
}
