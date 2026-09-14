import 'dotenv/config';
import { ethers } from 'ethers';
import { PriceFeed } from './priceFeed.js';
import { getCurrentRound, PREDICTION_ABI } from './contract.js';
import { decide } from './signal.js';
import { impliedPayoutMultiplier, sizeBetWei } from './betSizing.js';
import { ClaimManager } from './claims.js';
import { RpcPool, isTransientRpcError } from './rpcPool.js';
import { OracleFeed } from './oracleFeed.js';
import { startDashboard } from './dashboard.js';
import { loadState, saveState } from './statePersistence.js';
import { findRecentBets, withRetry, describeOutcome } from './walletHistory.js';
import { notify, notificationChannels, notificationsAreEnabled } from './notify.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const {
  RPC_URL,
  RPC_URLS,
  PRIVATE_KEY,
  CONTRACT_ADDRESS,
  EXPECTED_CHAIN_ID = '56', // BSC mainnet - override only if deliberately targeting a different network (e.g. 97 for BSC testnet)
  DRY_RUN = 'true',
  BET_AMOUNT_BNB = '0.01',
  SNIPE_WINDOW_SECONDS = '10',
  SHORT_LOOKBACK_SECONDS = '10',
  LONG_LOOKBACK_SECONDS = '45',
  VOLATILITY_WINDOW_SECONDS = '300',
  VOLATILITY_BUCKET_SECONDS = '5',
  Z_SCORE_THRESHOLD = '1.0',
  MAX_CONSECUTIVE_LOSSES = '5',
  MAX_DAILY_LOSS_BNB = '0.2',
  POLL_INTERVAL_MS = '2000',

  ENABLE_CROSS_ASSET = 'false',
  CROSS_ASSET_SYMBOL = 'btcusdt',

  ENABLE_POOL_SIZING = 'false',
  TREASURY_FEE_PCT = '3',
  MIN_PAYOUT_MULTIPLIER = '1.05',
  MAX_PAYOUT_MULTIPLIER_FOR_SIZING = '3.0',
  BET_AMOUNT_MIN_BNB = '0.005',
  BET_AMOUNT_MAX_BNB = '0.02',

  ENABLE_AUTO_CLAIM = 'true',
  CLAIM_GAS_BUFFER_MULTIPLIER = '1.5',
  MAX_QUEUED_CLAIMS = '10',
  CLAIM_CHECK_INTERVAL_MS = '30000',

  ENABLE_ORACLE_DIVERGENCE = 'false',
  ORACLE_AGGREGATOR_ADDRESS = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE',
  ORACLE_DIVERGENCE_THRESHOLD_PCT = '0.05',
  ORACLE_POLL_INTERVAL_MS = '3000',

  ENABLE_CROWD_FOLLOWING = 'false',
  CROWD_MIN_MARGIN_PCT = '10',

  ENABLE_WALLET_COPY = 'false',
  COPY_WALLET_ADDRESS = '0xc2fa81eDF00A72dC05AE97Ab1c381856b12e0491',
  COPY_WALLET_MAX_BET_BNB = '0.1',
  WALLET_HISTORY_MAX_EPOCHS = '8640',
  WALLET_HISTORY_CHUNK_SIZE = '20',
  WALLET_HISTORY_REQUEST_INTERVAL_MS = '150',

  ENABLE_ENSEMBLE_VOTING = 'false',
  ENSEMBLE_MIN_AGREEMENT = '2',

  NOTIFY_ON_BET_RESULT = 'false',

  ENABLE_DASHBOARD = 'true',
  DASHBOARD_PORT = '3000',
} = process.env;

const isDryRun = DRY_RUN !== 'false';
const expectedChainId = BigInt(EXPECTED_CHAIN_ID);
const flatBetAmountWei = ethers.parseEther(BET_AMOUNT_BNB);
const snipeWindowMs = Number(SNIPE_WINDOW_SECONDS) * 1000;
const maxConsecutiveLosses = Number(MAX_CONSECUTIVE_LOSSES);
const maxDailyLossBnb = Number(MAX_DAILY_LOSS_BNB);

const signalCfg = {
  shortLookbackSeconds: Number(SHORT_LOOKBACK_SECONDS),
  longLookbackSeconds: Number(LONG_LOOKBACK_SECONDS),
  volatilityWindowSeconds: Number(VOLATILITY_WINDOW_SECONDS),
  volatilityBucketSeconds: Number(VOLATILITY_BUCKET_SECONDS),
  zScoreThreshold: Number(Z_SCORE_THRESHOLD),
};

const crossAssetEnabled = ENABLE_CROSS_ASSET === 'true';

const poolSizingEnabled = ENABLE_POOL_SIZING === 'true';
const sizingCfg = {
  minPayoutMultiplier: Number(MIN_PAYOUT_MULTIPLIER),
  maxPayoutMultiplierForSizing: Number(MAX_PAYOUT_MULTIPLIER_FOR_SIZING),
  betAmountMinBnb: Number(BET_AMOUNT_MIN_BNB),
  betAmountMaxBnb: Number(BET_AMOUNT_MAX_BNB),
};
let treasuryFeePct = Number(TREASURY_FEE_PCT); // overridden below by a live contract read if it succeeds

const autoClaimEnabled = ENABLE_AUTO_CLAIM === 'true';
const oracleDivergenceEnabled = ENABLE_ORACLE_DIVERGENCE === 'true';
const oracleDivergenceThresholdPct = Number(ORACLE_DIVERGENCE_THRESHOLD_PCT);
const crowdFollowingEnabled = ENABLE_CROWD_FOLLOWING === 'true';
const crowdMinMarginPct = Number(CROWD_MIN_MARGIN_PCT);
const walletCopyEnabled = ENABLE_WALLET_COPY === 'true';
const ensembleVotingEnabled = ENABLE_ENSEMBLE_VOTING === 'true';
const ensembleMinAgreement = Number(ENSEMBLE_MIN_AGREEMENT);
const notifyOnBetResult = NOTIFY_ON_BET_RESULT === 'true';

// Matches the EXACT priority order the decision logic itself uses - see the
// if/else-if/else chain in the main loop. Whichever mode this names is
// what's actually deciding bets; the other config blocks are inert.
const activeMode = ensembleVotingEnabled ? 'ensemble' : walletCopyEnabled ? 'wallet-copy' : crowdFollowingEnabled ? 'crowd-following' : 'momentum';
const copyWalletMaxBetWei = ethers.parseEther(COPY_WALLET_MAX_BET_BNB);
const dashboardEnabled = ENABLE_DASHBOARD === 'true';

// RPC_URLS (comma-separated) takes priority; falls back to single RPC_URL so
// existing .env files with just RPC_URL keep working unchanged.
const rpcUrls = (RPC_URLS ? RPC_URLS.split(',') : [RPC_URL])
  .map((u) => u && u.trim())
  .filter(Boolean);

if (!rpcUrls.length || !PRIVATE_KEY || !CONTRACT_ADDRESS) {
  console.error('Missing RPC_URL(S), PRIVATE_KEY, or CONTRACT_ADDRESS - copy .env.example to .env and fill it in.');
  process.exit(1);
}

if (walletCopyEnabled && !ethers.isAddress(COPY_WALLET_ADDRESS)) {
  console.error(`[bot] COPY_WALLET_ADDRESS ("${COPY_WALLET_ADDRESS}") is not a valid address.`);
  process.exit(1);
}

if (ensembleVotingEnabled) {
  // Momentum always participates; crowd/wallet-copy participate only if
  // ALSO individually enabled. If the required agreement exceeds the number
  // of voters that could ever show up, no round could ever win - catch that
  // now rather than have the bot silently skip every round forever.
  const maxPossibleVoters = 1 + (crowdFollowingEnabled ? 1 : 0) + (walletCopyEnabled ? 1 : 0);
  if (ensembleMinAgreement > maxPossibleVoters) {
    console.error(
      `[bot] ENSEMBLE_MIN_AGREEMENT=${ensembleMinAgreement} but at most ${maxPossibleVoters} voter(s) can participate ` +
      `(momentum always votes; crowd-following/wallet-copy only if their own ENABLE_ flags are also true). ` +
      `This would skip every round forever - lower ENSEMBLE_MIN_AGREEMENT or enable more voters.`
    );
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const pendingBets = new Map();   // epoch(string) -> { direction, amountWei, simulated }
const decidedEpochs = new Set(); // epochs we've already decided on (bet or skip)

let consecutiveLosses = 0;
let dailyLossBnb = 0;
let dayStart = Date.now();
let halted = false;
const stats = { wins: 0, losses: 0, ties: 0, skipped: 0 };
let netPnlWei = 0n;       // real money - only moves for live (non-simulated) bets
let simulatedPnlWei = 0n; // dry-run paper PnL, computed from the REAL pool's reward ratio

// Recent human-readable events, newest first - console output stays as-is;
// this just also mirrors the meaningful ones for the dashboard to display.
const recentEvents = [];
function logEvent(msg, isError = false) {
  if (isError) console.error(msg);
  else console.log(msg);
  recentEvents.unshift({ time: Date.now(), msg });
  if (recentEvents.length > 50) recentEvents.length = 50;
}

// The copied wallet's own recent bet history, shown on the dashboard for
// reference - separate from OUR bets/stats above. Most recent first, capped
// at 10. Populated by an initial background scan at startup (can take a
// while - see walletHistory.js), then kept current incrementally from the
// wallet-copy polling in the main loop below, which already reads this same
// wallet's ledger() every tick and would otherwise just discard that data.
let targetWalletHistory = [];
let targetWalletHistoryLoading = walletCopyEnabled;

// Persists stats/PnL/halt state and any still-pending bets, so a restart
// doesn't reset counters to zero or silently drop a bet that's still
// awaiting resolution (the bet itself is fine on-chain either way - this is
// about OUR tracking of it, including queuing it for auto-claim if it wins).
function persist() {
  saveState({
    stats,
    netPnlWei: netPnlWei.toString(),
    simulatedPnlWei: simulatedPnlWei.toString(),
    dailyLossBnb,
    dayStart,
    consecutiveLosses,
    halted,
    // Explicit field list (not a spread) - the in-memory bet objects also
    // carry transient display-cache fields (current pool amounts, as
    // BigInt) that must never reach JSON.stringify unconverted.
    pendingBets: [...pendingBets.entries()].map(([epoch, bet]) => [
      epoch,
      { direction: bet.direction, amountWei: bet.amountWei.toString(), simulated: bet.simulated, closeTimestamp: bet.closeTimestamp },
    ]),
  });
}

function restoreState() {
  const loaded = loadState();
  if (!loaded) return;
  stats.wins = loaded.stats?.wins ?? 0;
  stats.losses = loaded.stats?.losses ?? 0;
  stats.ties = loaded.stats?.ties ?? 0;
  stats.skipped = loaded.stats?.skipped ?? 0;
  netPnlWei = loaded.netPnlWei ? BigInt(loaded.netPnlWei) : 0n;
  simulatedPnlWei = loaded.simulatedPnlWei ? BigInt(loaded.simulatedPnlWei) : 0n;
  dailyLossBnb = loaded.dailyLossBnb ?? 0;
  dayStart = loaded.dayStart ?? Date.now();
  consecutiveLosses = loaded.consecutiveLosses ?? 0;
  halted = loaded.halted ?? false;
  for (const [epoch, bet] of loaded.pendingBets ?? []) {
    pendingBets.set(epoch, { ...bet, amountWei: BigInt(bet.amountWei) });
    decidedEpochs.add(epoch); // we already have a position on this round, don't re-decide it
  }
  const pendingNote = pendingBets.size ? `, ${pendingBets.size} pending bet(s) recovered` : '';
  console.log(`[bot] restored persisted state: ${stats.wins}W/${stats.losses}L/${stats.ties}T${pendingNote}${halted ? ' (was HALTED)' : ''}`);
}

function resetDailyCounterIfNeeded() {
  if (Date.now() - dayStart > 24 * 60 * 60 * 1000) {
    dailyLossBnb = 0;
    dayStart = Date.now();
  }
}

function liveHaltConditionMet() {
  if (isDryRun) return false;
  if (halted) return true;
  if (consecutiveLosses >= maxConsecutiveLosses) {
    logEvent(`[bot] HALTED: ${consecutiveLosses} consecutive losses (limit ${maxConsecutiveLosses})`, true);
    halted = true;
    persist();
    notify(`🛑 Bot HALTED: ${consecutiveLosses} consecutive losses (limit ${maxConsecutiveLosses}). It will not place further bets until restarted.`);
    return true;
  }
  if (dailyLossBnb >= maxDailyLossBnb) {
    logEvent(`[bot] HALTED: daily loss ${dailyLossBnb.toFixed(4)} BNB reached the ${maxDailyLossBnb} BNB cap`, true);
    halted = true;
    persist();
    notify(`🛑 Bot HALTED: daily loss ${dailyLossBnb.toFixed(4)} BNB reached the ${maxDailyLossBnb} BNB cap. It will not place further bets until restarted.`);
    return true;
  }
  return false;
}

// Full wei precision (18 decimals) is overkill for a PnL display - round to
// 6 decimal places for readability. The underlying *Wei BigInt values used
// for tracking and persistence are untouched; this only affects display.
function formatBnbPnl(wei) {
  return parseFloat(ethers.formatEther(wei)).toFixed(6);
}

function printStats(bnbUsdPrice) {
  const total = stats.wins + stats.losses;
  const rate = total ? ((stats.wins / total) * 100).toFixed(1) : '0.0';
  const pnlWei = isDryRun ? simulatedPnlWei : netPnlWei;
  const pnlBnb = formatBnbPnl(pnlWei);
  const pnlUsdBit = bnbUsdPrice != null ? ` (~$${(parseFloat(pnlBnb) * bnbUsdPrice).toFixed(2)})` : '';
  const pnlLabel = isDryRun ? 'simulated PnL' : 'live net PnL';
  console.log(`[stats] ${stats.wins}W / ${stats.losses}L / ${stats.ties} ties (${rate}% win rate) - ${stats.skipped} skipped - ${pnlLabel} ${pnlBnb} BNB${pnlUsdBit}`);
}

// ---------------------------------------------------------------------------
// Outcome checking
// ---------------------------------------------------------------------------
async function checkOutcomes(rpcPool, claimManager, priceFeed) {
  const nowSec = Math.floor(Date.now() / 1000);
  const bnbUsdPrice = priceFeed.getTicks().at(-1)?.price ?? null;
  for (const [epochKey, bet] of pendingBets.entries()) {
    let round;
    try {
      round = await rpcPool.withReadFailover((c) => c.rounds(BigInt(epochKey)));
    } catch (err) {
      console.error(`[bot] failed to read round ${epochKey}:`, err.message);
      continue;
    }

    // Cache current pool state on the bet object (mutating it in place, so
    // this doesn't need its own Map.set) so the dashboard can show an
    // estimated payout without any RPC calls of its own - it just reads
    // in-memory state synchronously. Not persisted (see persist() above) -
    // it's a display cache, refreshed every tick, not something worth saving.
    bet.poolTotalWei = round.totalAmount;
    bet.poolBullWei = round.bullAmount;
    bet.poolBearWei = round.bearAmount;

    const closeTimestamp = Number(round.closeTimestamp);
    if (!round.oracleCalled || nowSec < closeTimestamp) continue; // not resolved yet

    let outcome;
    if (round.closePrice > round.lockPrice) outcome = 'BULL';
    else if (round.closePrice < round.lockPrice) outcome = 'BEAR';
    else outcome = 'TIE';

    const tag = bet.simulated ? ' (simulated)' : '';
    const notifyTag = bet.simulated ? '[DRY RUN] ' : '[LIVE] ';
    if (outcome === 'TIE') {
      // Confirmed against the actual contract source: a tie (closePrice ==
      // lockPrice) is the "house wins" branch - rewardAmount is set to 0 for
      // everyone and the entire pool goes to treasury. This is NOT a push;
      // the full stake is lost, same as a directional loss. (refundable()
      // is a separate, unrelated mechanism - only for when the oracle never
      // reports at all, not for a genuine tie.)
      stats.ties += 1;
      if (bet.simulated) {
        simulatedPnlWei -= bet.amountWei;
      } else {
        consecutiveLosses += 1;
        dailyLossBnb += Number(ethers.formatEther(bet.amountWei));
        netPnlWei -= bet.amountWei;
      }
      logEvent(`[bot] epoch ${epochKey}: TIE (close == lock price) - stake lost to treasury, same as a loss${tag}`);
      if (notifyOnBetResult) notify(`${notifyTag}Epoch ${epochKey}: TIE (house wins) - lost ${ethers.formatEther(bet.amountWei)} BNB stake`);
    } else if (outcome === bet.direction) {
      stats.wins += 1;
      // Reward ratio comes from the REAL pool either way (dry run just never
      // added our stake to it), so this is a fair estimate even in dry run.
      const reward = round.rewardBaseCalAmount > 0n
        ? (bet.amountWei * round.rewardAmount) / round.rewardBaseCalAmount
        : 0n;
      const profit = reward - bet.amountWei;
      if (bet.simulated) {
        simulatedPnlWei += profit;
      } else {
        consecutiveLosses = 0;
        netPnlWei += profit;
        if (autoClaimEnabled && claimManager) claimManager.enqueue(epochKey);
      }
      logEvent(`[bot] epoch ${epochKey}: WON - bet ${bet.direction}, result ${outcome}${tag}`);
      if (notifyOnBetResult) notify(`${notifyTag}Epoch ${epochKey}: WON - bet ${bet.direction}, profit ${ethers.formatEther(profit)} BNB`);
    } else {
      stats.losses += 1;
      if (bet.simulated) {
        simulatedPnlWei -= bet.amountWei;
      } else {
        consecutiveLosses += 1;
        dailyLossBnb += Number(ethers.formatEther(bet.amountWei));
        netPnlWei -= bet.amountWei;
      }
      logEvent(`[bot] epoch ${epochKey}: LOST - bet ${bet.direction}, result ${outcome}${tag}`);
      if (notifyOnBetResult) notify(`${notifyTag}Epoch ${epochKey}: LOST - bet ${bet.direction}, result ${outcome}, lost ${ethers.formatEther(bet.amountWei)} BNB`);
    }

    pendingBets.delete(epochKey);
    persist();
    printStats(bnbUsdPrice);
  }
}

// A transient RPC hiccup during startup (rate limit, brief network blip)
// shouldn't be immediately fatal, especially with only one RPC_URLS entry
// configured (nothing for withReadFailover to fall back to). Retry a few
// times with a short delay before actually giving up. Only used for the
// one-time startup checks below - the ongoing main loop already has its own
// try/catch per tick and doesn't need this.
async function retryStartup(fn, label, attempts = 3, delayMs = 2000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.error(`[bot] startup check '${label}' failed (attempt ${i + 1}/${attempts}): ${err.message}`);
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Target wallet history (dashboard reference only, wallet-copy mode)
// ---------------------------------------------------------------------------

// One-time background scan at startup to populate the initial list. Runs
// fire-and-forget - the main loop starts immediately without waiting for
// this, since a full scan can take a while (see walletHistory.js).
async function backfillTargetWalletHistory(rpcPool) {
  const currentEpoch = await withRetry(() => rpcPool.withReadFailover((c) => c.currentEpoch()), 'currentEpoch()');
  let lastReportedAt = Date.now();
  const bets = await findRecentBets(
    (epoch) => withRetry(() => rpcPool.withReadFailover((c) => c.ledger(epoch, COPY_WALLET_ADDRESS)), `ledger(${epoch})`),
    currentEpoch,
    10,
    Number(WALLET_HISTORY_MAX_EPOCHS),
    Number(WALLET_HISTORY_CHUNK_SIZE),
    Number(WALLET_HISTORY_REQUEST_INTERVAL_MS),
    (scanned, foundCount) => {
      // Sparse, periodic visibility instead of the CLI's rapid \r progress
      // (which wouldn't read well mixed into the bot's own log lines) or
      // total silence (which looks identical to "stuck"). Every ~15s.
      const now = Date.now();
      if (now - lastReportedAt >= 15000) {
        logEvent(`[bot] target wallet history scan: ${scanned} epoch(s) checked, ${foundCount}/10 found so far...`);
        lastReportedAt = now;
      }
    }
  );
  const entries = [];
  for (const bet of bets) {
    const round = await withRetry(() => rpcPool.withReadFailover((c) => c.rounds(bet.epoch)), `rounds(${bet.epoch})`);
    entries.push({ epoch: bet.epoch.toString(), direction: bet.direction, amountBnb: ethers.formatEther(bet.amount), outcome: describeOutcome(round, bet.direction) });
  }

  // This runs fire-and-forget and can take a while - the live loop may have
  // already added a newer entry to targetWalletHistory in the meantime.
  // Merge rather than overwrite, so that entry isn't silently lost.
  const existingEpochs = new Set(targetWalletHistory.map((e) => e.epoch));
  const merged = [...targetWalletHistory, ...entries.filter((e) => !existingEpochs.has(e.epoch))];
  merged.sort((a, b) => (BigInt(b.epoch) > BigInt(a.epoch) ? 1 : BigInt(b.epoch) < BigInt(a.epoch) ? -1 : 0));
  targetWalletHistory = merged.slice(0, 10);

  targetWalletHistoryLoading = false;
  logEvent(`[bot] loaded ${entries.length} historical bet(s) for the copied wallet`);
}

// Re-checks any PENDING entry in targetWalletHistory to see if its round has
// resolved yet. Cheap - the list is capped at 10, and most entries settle
// within one call once their round actually closes.
async function refreshTargetWalletHistoryOutcomes(rpcPool) {
  for (const entry of targetWalletHistory) {
    if (!entry.outcome.startsWith('PENDING')) continue;
    try {
      const round = await rpcPool.withReadFailover((c) => c.rounds(BigInt(entry.epoch)));
      entry.outcome = describeOutcome(round, entry.direction);
    } catch (err) {
      console.error(`[bot] failed refreshing target wallet history for epoch ${entry.epoch}:`, err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  restoreState();
  console.log(`[bot] starting in ${isDryRun ? 'DRY RUN (simulated only, no funds at risk)' : 'LIVE (real BNB will be wagered)'} mode`);
  console.log(`[bot] RPC endpoints: ${rpcUrls.length} configured (failover on reads, rotate-on-failure for writes)`);
  console.log(`[bot] signal: short=${signalCfg.shortLookbackSeconds}s long=${signalCfg.longLookbackSeconds}s zThreshold=${signalCfg.zScoreThreshold} crossAsset=${crossAssetEnabled ? CROSS_ASSET_SYMBOL : 'off'}`);
  console.log(`[bot] pool sizing: ${poolSizingEnabled ? `on (min payout x${sizingCfg.minPayoutMultiplier}, ${sizingCfg.betAmountMinBnb}-${sizingCfg.betAmountMaxBnb} BNB)` : `off (flat ${BET_AMOUNT_BNB} BNB)`} | auto-claim: ${autoClaimEnabled ? `on (>=${CLAIM_GAS_BUFFER_MULTIPLIER}x gas)` : 'off'}`);
  if (ensembleVotingEnabled) {
    const voters = ['momentum', ...(crowdFollowingEnabled ? ['crowd-following'] : []), ...(walletCopyEnabled ? ['wallet-copy'] : [])];
    console.log(`[bot] ensemble voting: ON, need ${ensembleMinAgreement}/${voters.length} agreement among [${voters.join(', ')}] - this REPLACES the exclusive priority below (pool-sizing is bypassed while this is active)`);
  } else if (walletCopyEnabled) {
    console.log(`[bot] wallet-copy: ON, following ${COPY_WALLET_ADDRESS} (max copy ${COPY_WALLET_MAX_BET_BNB} BNB) - this REPLACES every other signal (momentum, cross-asset, oracle-divergence, crowd-following, pool-sizing all bypassed)`);
    if (crowdFollowingEnabled) console.warn('[bot] WARNING: ENABLE_WALLET_COPY and ENABLE_CROWD_FOLLOWING are both on - wallet-copy takes priority, crowd-following is ignored.');
    if (poolSizingEnabled) console.warn('[bot] WARNING: ENABLE_WALLET_COPY and ENABLE_POOL_SIZING are both on - wallet-copy bets the target\'s exact amount, so pool sizing is ignored.');
  } else if (crowdFollowingEnabled) {
    console.log(`[bot] crowd-following: ON (min margin ${crowdMinMarginPct}%) - this REPLACES the momentum signal above; cross-asset/oracle-divergence/pool-sizing are all bypassed while this is active`);
    if (poolSizingEnabled) {
      console.warn('[bot] WARNING: ENABLE_CROWD_FOLLOWING and ENABLE_POOL_SIZING are both on - these contradict each other (crowd-following bets the majority side; pool sizing favors betting AGAINST the majority for a better payout). Pool sizing will be ignored while crowd-following is active.');
    }
  }

  const rpcPool = new RpcPool({ urls: rpcUrls, privateKey: PRIVATE_KEY, contractAddress: CONTRACT_ADDRESS, abi: PREDICTION_ABI });

  const network = await retryStartup(() => rpcPool.withReadFailover((_c, p) => p.getNetwork()), 'network check');
  if (network.chainId !== expectedChainId) {
    console.error(
      `[bot] connected RPC reports chain ID ${network.chainId}, but this bot targets chain ID ${expectedChainId} (BSC mainnet by default). ` +
      `CONTRACT_ADDRESS won't exist on the wrong network, which shows up as a cryptic "missing revert data" error on every call, not a clear one. ` +
      `Check RPC_URL(S) - it's very likely pointing at the wrong network (e.g. a testnet, or a different chain's endpoint).`
    );
    process.exit(1);
  }

  const paused = await retryStartup(() => rpcPool.withReadFailover((c) => c.paused()), 'paused check');
  if (paused) {
    console.error('[bot] the prediction market is currently paused on-chain. Exiting.');
    process.exit(1);
  }

  try {
    const liveFeeRaw = await retryStartup(() => rpcPool.withReadFailover((c) => c.treasuryFee()), 'treasuryFee check');
    const liveFeePct = Number(liveFeeRaw) / 100; // contract stores this as basis-points-of-10000 (e.g. 300 = 3%)
    if (liveFeePct !== treasuryFeePct) {
      console.log(`[bot] live treasuryFee() reads ${liveFeePct}% - overriding the configured TREASURY_FEE_PCT=${treasuryFeePct}%`);
    }
    treasuryFeePct = liveFeePct;
  } catch (err) {
    console.warn(`[bot] could not read live treasuryFee(), falling back to configured TREASURY_FEE_PCT=${treasuryFeePct}%:`, err.message);
  }

  if (!isDryRun) {
    const minBet = await retryStartup(() => rpcPool.withReadFailover((c) => c.minBetAmount()), 'minBetAmount check');
    const floorBnb = poolSizingEnabled ? sizingCfg.betAmountMinBnb : Number(BET_AMOUNT_BNB);
    if (ethers.parseEther(floorBnb.toString()) < minBet) {
      console.error(`[bot] smallest possible bet (${floorBnb} BNB) is below the contract minimum (${ethers.formatEther(minBet)} BNB).`);
      process.exit(1);
    }
  }

  const priceFeed = new PriceFeed({ symbol: 'bnbusdt', maxBufferSeconds: signalCfg.volatilityWindowSeconds + 30 });
  priceFeed.connect();
  let latestRound = null; // updated every tick below, read by the dashboard snapshot for the current pool display

  const crossAssetFeed = crossAssetEnabled
    ? new PriceFeed({ symbol: CROSS_ASSET_SYMBOL, maxBufferSeconds: signalCfg.longLookbackSeconds + 30 })
    : null;
  if (crossAssetFeed) crossAssetFeed.connect();

  const oracleFeed = oracleDivergenceEnabled
    ? new OracleFeed({ rpcPool, aggregatorAddress: ORACLE_AGGREGATOR_ADDRESS, pollIntervalMs: Number(ORACLE_POLL_INTERVAL_MS) })
    : null;
  if (oracleFeed) {
    await retryStartup(() => oracleFeed.start(), 'oracle feed startup');
    console.log(`[bot] oracle divergence: on (threshold ${oracleDivergenceThresholdPct}%, polling every ${ORACLE_POLL_INTERVAL_MS}ms)`);
  }

  if (walletCopyEnabled) {
    console.log('[bot] loading target wallet\'s recent bet history in the background (dashboard will show "loading" until this completes)...');
    backfillTargetWalletHistory(rpcPool).catch((err) => {
      console.error('[bot] target wallet history backfill failed:', err.message);
      targetWalletHistoryLoading = false;
    });
  }

  const claimManager = (!isDryRun && autoClaimEnabled)
    ? new ClaimManager({
        rpcPool,
        gasBufferMultiplier: Number(CLAIM_GAS_BUFFER_MULTIPLIER),
        maxQueueSize: Number(MAX_QUEUED_CLAIMS),
        onEvent: (msg) => logEvent(`[claims] ${msg}`),
      })
    : null;
  if (claimManager) {
    setInterval(
      () => claimManager.tryClaim().catch((err) => console.error('[claims] loop error:', err.message)),
      Number(CLAIM_CHECK_INTERVAL_MS)
    );
  }

  if (notificationsAreEnabled()) {
    const channels = notificationChannels();
    if (channels.length) {
      console.log(`[bot] notifications: ON via ${channels.join(' + ')}`);
      notify(`✅ Bot started. Mode: ${activeMode}. ${isDryRun ? 'DRY RUN (no real funds at risk)' : 'LIVE (real funds at risk)'}.`);
    } else {
      console.warn('[bot] ENABLE_NOTIFICATIONS is true, but no DISCORD_WEBHOOK_URL or TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID are set - nothing will actually be sent.');
    }
  }

  if (dashboardEnabled) {
    // Platforms like Railway assign a port dynamically via PORT and expect
    // the app to listen on it for their networking/proxy to work - prefer
    // that over our own DASHBOARD_PORT when it's set, so this works
    // unmodified both locally and deployed.
    const dashboardPort = process.env.PORT ? Number(process.env.PORT) : Number(DASHBOARD_PORT);
    startDashboard(() => {
      const bnbUsdPrice = priceFeed.getTicks().at(-1)?.price ?? null;
      const netPnlBnb = formatBnbPnl(netPnlWei);
      const simulatedPnlBnb = formatBnbPnl(simulatedPnlWei);

      const currentRound = latestRound ? {
        epoch: latestRound.epoch.toString(),
        totalBnb: ethers.formatEther(latestRound.totalAmount),
        totalUsd: bnbUsdPrice != null ? (parseFloat(ethers.formatEther(latestRound.totalAmount)) * bnbUsdPrice).toFixed(2) : null,
        bullBnb: ethers.formatEther(latestRound.bullAmount),
        bearBnb: ethers.formatEther(latestRound.bearAmount),
        lockTimestamp: latestRound.lockTimestamp * 1000,
      } : null;

      return {
        isDryRun,
        halted,
        activeMode,
        ensembleVotingEnabled,
        ensembleMinAgreement,
        ensembleVoters: ensembleVotingEnabled
          ? ['momentum', ...(crowdFollowingEnabled ? ['crowd-following'] : []), ...(walletCopyEnabled ? ['wallet-copy'] : [])]
          : [],
        signalConfig: signalCfg,
        crossAssetEnabled,
        crossAssetSymbol: CROSS_ASSET_SYMBOL,
        crowdFollowingEnabled,
        crowdMinMarginPct,
        poolSizingEnabled,
        autoClaimEnabled,
        oracleDivergenceEnabled,
        oraclePrice: oracleFeed ? oracleFeed.latestPrice : null,
        oracleAgeSeconds: oracleFeed ? oracleFeed.secondsSinceUpdate() : null,
        stats,
        netPnlBnb,
        netPnlUsd: bnbUsdPrice != null ? (parseFloat(netPnlBnb) * bnbUsdPrice).toFixed(2) : null,
        simulatedPnlBnb,
        simulatedPnlUsd: bnbUsdPrice != null ? (parseFloat(simulatedPnlBnb) * bnbUsdPrice).toFixed(2) : null,
        bnbUsdPrice,
        currentRound,
        pendingBets: [...pendingBets.entries()].map(([epoch, bet]) => {
          let potentialPayoutUsd = null;
          let potentialPayoutBnb = null;
          if (bet.poolBullWei != null && bet.poolBearWei != null) {
            const multiplier = impliedPayoutMultiplier({
              bullAmount: bet.poolBullWei,
              bearAmount: bet.poolBearWei,
              direction: bet.direction,
              treasuryFeePct,
            });
            if (multiplier != null) {
              potentialPayoutBnb = parseFloat(ethers.formatEther(bet.amountWei)) * multiplier;
              potentialPayoutUsd = bnbUsdPrice != null ? (potentialPayoutBnb * bnbUsdPrice).toFixed(2) : null;
            }
          }
          return {
            epoch,
            direction: bet.direction,
            amountBnb: ethers.formatEther(bet.amountWei),
            simulated: bet.simulated,
            closeTimestamp: bet.closeTimestamp,
            poolTotalBnb: bet.poolTotalWei != null ? ethers.formatEther(bet.poolTotalWei) : null,
            potentialPayoutBnb: potentialPayoutBnb != null ? potentialPayoutBnb.toFixed(4) : null,
            potentialPayoutUsd,
          };
        }),
        claimQueueSize: claimManager ? claimManager.queueSize : 0,
        walletCopyEnabled,
        copyWalletAddress: walletCopyEnabled ? COPY_WALLET_ADDRESS : null,
        targetWalletHistoryLoading,
        targetWalletHistory,
        recentEvents,
      };
    }, dashboardPort);
  }

  // ---------------------------------------------------------------------
  // Vote getters - one per signal source. Each returns { vote: 'BULL'|
  // 'BEAR'|null, ...details }, null meaning "no opinion this round". Used
  // both by the exclusive standalone modes below (which use exactly one)
  // and by ensemble mode (which combines whichever are enabled). Defined
  // here as closures so they can reach priceFeed/crossAssetFeed/oracleFeed/
  // rpcPool without threading them through every call.
  // ---------------------------------------------------------------------

  async function getMomentumVote() {
    const result = decide(
      priceFeed.getTicks(),
      Date.now(),
      signalCfg,
      crossAssetFeed ? crossAssetFeed.getTicks() : null
    );

    if (result.action === 'SKIP') {
      return { vote: null, reason: result.reason, result };
    }

    if (oracleDivergenceEnabled) {
      const latestTick = priceFeed.getTicks().at(-1);
      const divergence = oracleFeed.divergencePct(latestTick?.price);
      if (divergence == null) {
        return { vote: null, reason: 'oracle not ready', result };
      }
      const expectedSign = result.action === 'BULL' ? 1 : -1;
      const divergenceConfirms = Math.sign(divergence) === expectedSign && Math.abs(divergence) >= oracleDivergenceThresholdPct;
      const staleness = oracleFeed.secondsSinceUpdate();
      if (!divergenceConfirms) {
        return { vote: null, reason: 'oracle does not confirm', result, divergence, staleness };
      }
      return { vote: result.action, result, divergence, staleness };
    }

    return { vote: result.action, result };
  }

  function getCrowdVote(round) {
    const totalAmount = round.bullAmount + round.bearAmount;
    if (totalAmount === 0n) {
      return { vote: null, reason: 'no bets yet' };
    }
    // Basis-point BigInt division first, then scale down - avoids float
    // precision loss converting large wei amounts before dividing.
    const bullPct = Number((round.bullAmount * 10000n) / totalAmount) / 100;
    const bearPct = 100 - bullPct;
    if (Math.abs(bullPct - bearPct) < crowdMinMarginPct) {
      return { vote: null, reason: 'margin too thin', bullPct, bearPct };
    }
    return { vote: bullPct > bearPct ? 'BULL' : 'BEAR', bullPct, bearPct };
  }

  async function getWalletCopyVote(round) {
    let targetLedger;
    try {
      targetLedger = await rpcPool.withReadFailover((c) => c.ledger(round.epoch, COPY_WALLET_ADDRESS));
    } catch (err) {
      return { vote: null, reason: 'check failed', error: err };
    }
    if (targetLedger.amount === 0n) {
      return { vote: null, reason: 'no bet yet' };
    }
    const vote = Number(targetLedger.position) === 0 ? 'BULL' : 'BEAR';

    // Record what the target ACTUALLY did in the dashboard's reference
    // table, independent of whether this vote ends up winning (standalone
    // mode) or being outvoted (ensemble mode) - reflects their real
    // behavior, not our decision.
    targetWalletHistory.unshift({
      epoch: round.epoch.toString(),
      direction: vote,
      amountBnb: ethers.formatEther(targetLedger.amount),
      outcome: 'PENDING (round not resolved yet)',
    });
    if (targetWalletHistory.length > 10) targetWalletHistory.length = 10;

    return { vote, targetLedger };
  }

  setInterval(async () => {
    try {
      resetDailyCounterIfNeeded();
      await checkOutcomes(rpcPool, claimManager, priceFeed);
      if (walletCopyEnabled && !targetWalletHistoryLoading) {
        await refreshTargetWalletHistoryOutcomes(rpcPool);
      }

      if (liveHaltConditionMet()) return;

      const round = await rpcPool.withReadFailover(getCurrentRound);
      latestRound = round;
      const epochKey = round.epoch.toString();
      const nowSec = Math.floor(Date.now() / 1000);
      const secondsToLock = round.lockTimestamp - nowSec;
      const withinSnipeWindow = secondsToLock > 0 && secondsToLock * 1000 <= snipeWindowMs;

      if (decidedEpochs.has(epochKey)) return;

      if (!isDryRun) {
        // decidedEpochs is in-memory and resets on a crash/restart. If we
        // restart on a round we already bet before going down, in-memory
        // state won't know that - but the chain will. Check before deciding,
        // rather than risk a duplicate bet. Checked unconditionally (not
        // gated by snipe-window timing) since wallet-copy watches every tick
        // of the round, not just its final seconds.
        try {
          const existing = await rpcPool.withReadFailover((c) => c.ledger(round.epoch, rpcPool.address));
          if (existing.amount > 0n) {
            logEvent(`[bot] epoch ${epochKey}: already hold a position on-chain (restart recovery) - not betting again`);
            decidedEpochs.add(epochKey);
            return;
          }
        } catch (err) {
          console.error(`[bot] failed checking existing position for epoch ${epochKey}, skipping this tick to be safe:`, err.message);
          return;
        }
      }

      let direction;
      let amountWei;

      if (ensembleVotingEnabled) {
        if (!withinSnipeWindow) return;

        const momentumVote = await getMomentumVote();
        // Transient startup conditions (not enough price history yet) - not
        // a genuine "momentum has no opinion" verdict, so retry next tick
        // rather than burning this round's one decision slot.
        if (momentumVote.reason === 'insufficient data' || momentumVote.reason === 'insufficient cross-asset data') return;

        const votes = [{ source: 'momentum', ...momentumVote }];
        if (crowdFollowingEnabled) votes.push({ source: 'crowd', ...getCrowdVote(round) });
        if (walletCopyEnabled) votes.push({ source: 'wallet-copy', ...(await getWalletCopyVote(round)) });

        const describeVote = (v) => v.vote ? `${v.source}=${v.vote}` : `${v.source}=skip(${v.reason})`;
        const summary = votes.map(describeVote).join(', ');
        const bullCount = votes.filter((v) => v.vote === 'BULL').length;
        const bearCount = votes.filter((v) => v.vote === 'BEAR').length;

        decidedEpochs.add(epochKey);

        if (bullCount >= ensembleMinAgreement) {
          direction = 'BULL';
          logEvent(`[bot] epoch ${epochKey}: ensemble -> BULL (${bullCount}/${votes.length} agree) - ${summary}`);
        } else if (bearCount >= ensembleMinAgreement) {
          direction = 'BEAR';
          logEvent(`[bot] epoch ${epochKey}: ensemble -> BEAR (${bearCount}/${votes.length} agree) - ${summary}`);
        } else {
          logEvent(`[bot] epoch ${epochKey}: ensemble - no agreement (need ${ensembleMinAgreement}/${votes.length}) - ${summary}`);
          stats.skipped += 1;
          return;
        }
      } else if (walletCopyEnabled) {
        if (secondsToLock <= 0) return; // already locked, nothing left to copy into
        const voteResult = await getWalletCopyVote(round);
        if (voteResult.reason === 'check failed') {
          console.error(`[bot] failed checking target wallet for epoch ${epochKey}:`, voteResult.error.message);
          return; // retry next tick
        }
        if (voteResult.vote == null) return; // hasn't bet yet this round - keep watching
        decidedEpochs.add(epochKey);
        direction = voteResult.vote;
        const targetLedger = voteResult.targetLedger;

        if (targetLedger.amount > copyWalletMaxBetWei) {
          logEvent(`[bot] epoch ${epochKey}: target wallet bet ${direction} for ${ethers.formatEther(targetLedger.amount)} BNB - capping our copy at ${COPY_WALLET_MAX_BET_BNB} BNB`);
          amountWei = copyWalletMaxBetWei;
        } else {
          amountWei = targetLedger.amount;
          logEvent(`[bot] epoch ${epochKey}: target wallet bet ${direction} for ${ethers.formatEther(amountWei)} BNB -> copying`);
        }
      } else if (crowdFollowingEnabled) {
        if (!withinSnipeWindow) return;
        const voteResult = getCrowdVote(round);
        decidedEpochs.add(epochKey);
        if (voteResult.vote == null) {
          const msg = voteResult.reason === 'no bets yet'
            ? `[bot] epoch ${epochKey}: no bets in the pool yet - skipping (crowd-following)`
            : `[bot] epoch ${epochKey}: pool split ${voteResult.bullPct.toFixed(1)}% / ${voteResult.bearPct.toFixed(1)}% - margin below ${crowdMinMarginPct}% minimum, skipping`;
          logEvent(msg);
          stats.skipped += 1;
          return;
        }
        direction = voteResult.vote;
        logEvent(`[bot] epoch ${epochKey}: pool split ${voteResult.bullPct.toFixed(1)}% / ${voteResult.bearPct.toFixed(1)}% -> following the crowd into ${direction}`);
      } else {
        if (!withinSnipeWindow) return;
        const voteResult = await getMomentumVote();
        const result = voteResult.result;

        if (voteResult.vote == null) {
          // Transient startup conditions - don't burn the round's decision slot, just wait for data.
          if (voteResult.reason === 'insufficient data' || voteResult.reason === 'insufficient cross-asset data') return;
          decidedEpochs.add(epochKey);
          stats.skipped += 1;
          if (voteResult.reason === 'oracle not ready') {
            logEvent(`[bot] epoch ${epochKey}: oracle reading not available yet, skipping`);
          } else if (voteResult.reason === 'oracle does not confirm') {
            logEvent(`[bot] epoch ${epochKey}: ${result.action} from momentum, but oracle divergence (${voteResult.divergence.toFixed(4)}%, oracle ${voteResult.staleness.toFixed(1)}s stale) doesn't confirm - skipping`);
          } else {
            logEvent(`[bot] epoch ${epochKey}: skip (${voteResult.reason}) - short ${result.short?.pctChange.toFixed(4)}% / long ${result.long?.pctChange.toFixed(4)}%`);
          }
          return;
        }

        decidedEpochs.add(epochKey);
        direction = voteResult.vote;

        if (oracleDivergenceEnabled) {
          logEvent(`[bot] epoch ${epochKey}: oracle divergence ${voteResult.divergence.toFixed(4)}% confirms ${direction} (oracle ${voteResult.staleness.toFixed(1)}s stale)`);
        }
        logEvent(`[bot] epoch ${epochKey}: locks in ${secondsToLock}s -> ${direction} (short ${result.short.pctChange.toFixed(4)}%, long ${result.long.pctChange.toFixed(4)}%, z=${result.zScore.toFixed(2)})`);
      }

      if (amountWei === undefined) amountWei = flatBetAmountWei; // wallet-copy already set its own amount above
      if (poolSizingEnabled && !crowdFollowingEnabled && !walletCopyEnabled && !ensembleVotingEnabled) {
        const multiplier = impliedPayoutMultiplier({
          bullAmount: round.bullAmount,
          bearAmount: round.bearAmount,
          direction,
          treasuryFeePct,
        });
        amountWei = sizeBetWei(multiplier, sizingCfg);
        if (amountWei === 0n) {
          logEvent(`[bot] epoch ${epochKey}: ${direction} confirmed but pool payout (${multiplier?.toFixed(3) ?? 'n/a'}x) is below the ${sizingCfg.minPayoutMultiplier}x minimum - skipping`);
          stats.skipped += 1;
          return;
        }
        logEvent(`[bot] epoch ${epochKey}: pool multiplier ${multiplier.toFixed(3)}x -> sizing bet at ${ethers.formatEther(amountWei)} BNB`);
      }

      if (isDryRun) {
        pendingBets.set(epochKey, { direction, amountWei, simulated: true, closeTimestamp: round.closeTimestamp * 1000 });
        persist();
        logEvent(`[DRY RUN] would wager ${ethers.formatEther(amountWei)} BNB on ${direction}`);
        return;
      }

      // Writes do NOT go through withReadFailover - see rpcPool.js for why.
      // On a transient failure we rotate for NEXT time but don't resend.
      const { contract } = rpcPool.current;
      try {
        const tx = direction === 'BULL'
          ? await contract.betBull(round.epoch, { value: amountWei, gasLimit: 300000n })
          : await contract.betBear(round.epoch, { value: amountWei, gasLimit: 300000n });
        logEvent(`[bot] tx sent: ${tx.hash}`);
        pendingBets.set(epochKey, { direction, amountWei, simulated: false, closeTimestamp: round.closeTimestamp * 1000 });
        persist();
        await tx.wait();
        logEvent('[bot] tx confirmed');
      } catch (err) {
        logEvent(`[bot] bet tx failed for epoch ${epochKey}: ${err.message}`, true);
        if (isTransientRpcError(err)) rpcPool.rotate();
      }
    } catch (err) {
      console.error('[bot] loop error:', err.message);
    }
  }, Number(POLL_INTERVAL_MS));
}

main().catch(async (err) => {
  console.error('[bot] fatal error:', err);
  await notify(`🔴 Bot CRASHED during startup: ${err.message}`);
  process.exit(1);
});

// Safety net for anything that escapes the main loop's own try/catch (which
// already handles ordinary operational errors without crashing) - a bug in
// error-handling itself, or a synchronous throw from a library outside any
// try/catch. Without these, such a crash would be completely silent to
// anyone not actively watching logs.
process.on('uncaughtException', async (err) => {
  console.error('[bot] FATAL uncaught exception:', err);
  await notify(`🔴 Bot CRASHED (uncaught exception): ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', async (reason) => {
  console.error('[bot] FATAL unhandled rejection:', reason);
  await notify(`🔴 Bot CRASHED (unhandled rejection): ${reason?.message || reason}`);
  process.exit(1);
});
