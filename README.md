# PancakeSwap Prediction Sniper (BNB market)

A Node.js bot for PancakeSwap's Prediction game
(`https://pancakeswap.finance/prediction?token=BNB`). It watches live BNB
price action and can bet BULL/BEAR right before each 5-minute round locks.

## Files

- `signal.js` - the core decision logic (shared by everything below)
- `priceFeed.js` - live Binance trade stream for one symbol
- `contract.js` - PancakeSwap Prediction contract interface
- `rpcPool.js` - multi-endpoint RPC failover for reads, safe rotation for writes
- `betSizing.js` - pool-imbalance payout math and bet sizing
- `claims.js` - batches and gas-gates auto-claiming of winnings
- `oracleFeed.js` - tracks the Chainlink oracle PancakeSwap actually settles against
- `dashboard.js` - local web UI (live stats, PnL, recent activity)
- `statePersistence.js` - saves/restores stats, PnL, and pending bets across restarts
- `resetStats.js` - resets stats/PnL to zero without touching pending bets
- `walletHistory.js` - looks up any wallet's recent bets and their outcomes
- `bot.js` - the live bot, wires all of the above together
- `backtest.js` - replays `signal.js` against historical price data
- `sweep.js` - grid-searches signal configs using `backtest.js`
- `walkforward.js` - tests whether a swept config survives out-of-sample
- `calibrate.js` - checks whether z-score actually tracks win probability

## Read this before running it live

- **This is a heuristic, not a proven edge.** It nudges the odds at best - it
  does not reliably predict where price will be 5 minutes later at close.
  Expect it to lose to the 3% round fee unless you find and validate a
  genuine edge over a large sample.
- **Every wager is real BNB once `DRY_RUN=false`.** Start with an amount
  you're fully fine losing, and only increase bet size once the backtested
  *and* live numbers back it up.
- **`DRY_RUN=true` is the default.** It logs every decision and tracks
  simulated win rate and PnL without sending any transaction.

## Setup

1. `npm install`
2. `cp .env.example .env` and fill in `RPC_URL` and `PRIVATE_KEY` at minimum.
3. Double-check `CONTRACT_ADDRESS` yourself against the verified source on
   BscScan - never trust a contract address blindly when real funds are
   involved.
4. `npm start`

## Checking any wallet's bet history

`npm run wallet-history [address] [count]` finds a wallet's most recent bets
by walking backward through round epochs and checking `ledger(epoch,
address)` directly for each one, then checks each round's actual outcome
the same way the bot itself does. Read-only, no private key needed.
Defaults to `COPY_WALLET_ADDRESS` from `.env` and the last 10 bets if you
don't pass arguments:

```
npm run wallet-history
npm run wallet-history 0xSomeOtherAddress 20
```

This deliberately does NOT use `eth_getLogs` - block-range limits for log
queries turned out to vary wildly and unpredictably across RPC providers
(one free tier caps it at a 5-block range, making any chunk-based log scan
impractical). `ledger()` is a plain contract read with no such restriction
on any provider, so this walks backward epoch-by-epoch instead, up to
`WALLET_HISTORY_MAX_EPOCHS` back (default ~30 days) before giving up on an
inactive wallet.

**Every individual request gets its own evenly-spaced time slot**
(`WALLET_HISTORY_REQUEST_INTERVAL_MS` apart), rather than firing a burst of
`WALLET_HISTORY_CHUNK_SIZE` requests at once and pausing between bursts - an
earlier version worked that way, and a simultaneous burst turned out to be
exactly what trips a rate limiter even when the *average* rate looks fine.
`WALLET_HISTORY_CHUNK_SIZE` only controls how many epochs get grouped per
progress update; it has no effect on the actual request rate.

**No fixed rate limit is assumed to be correct.** The same free-tier
provider that capped `eth_getLogs` at 5 blocks also turned out to cap plain
requests at 15/second - every provider's real limit is unknown in advance
and inconsistent even within one provider. Any error that looks like a
rate-limit rejection still retries automatically with exponential backoff
(`WALLET_HISTORY_MAX_RETRIES` attempts, doubling from
`WALLET_HISTORY_RETRY_BASE_MS`) as a second line of defense.

The function signatures this relies on (`currentEpoch()`, `ledger()`,
`rounds()`) have been verified against PancakeSwap's own published contract
source, field-for-field, not just assumed.

## The signal (what decides BULL vs BEAR vs skip)

Four checks, all in `signal.js`, all must pass:

1. **Short and long lookback windows agree on direction** (multi-timeframe
   confirmation) - filters out a lot of single-window noise.
2. **Cross-asset confirmation** (optional, `ENABLE_CROSS_ASSET=true`) - a
   second symbol's (default BTC) recent momentum must also agree, as an
   independent vote.
3. **The agreed move clears a volatility-adjusted threshold** - judged in
   standard deviations of recent volatility, not a fixed %, so the bar
   adapts to calm vs choppy conditions.
4. Every momentum reading is **volume-weighted** (VWAP-based), so trades
   backed by more size count for more.

## Backtesting and tuning

**`npm run validate-strategy` runs the full sequence in one command** -
`backtest` → `calibrate` → `sweep` → `walkforward`, in that order, stopping
immediately if any step fails rather than continuing on bad data. Each
script still does its own historical data fetch (they don't share one
fetch across the chain), so this takes roughly the sum of the four
individual runtimes, not a shortcut - it's convenience, not a faster path.
Run the four separately (below) if you want to inspect each result before
moving to the next.

`npm run backtest` fetches recent price history from Binance (cached under
`historical_data/`), replays your `.env` signal config against it using
simulated 5-minute round boundaries, and prints a win rate. With
`ENABLE_CROSS_ASSET=true` it also fetches and tests the cross-asset check.

`npm run sweep` does the same thing across a grid of
`SHORT_LOOKBACK_SECONDS` / `LONG_LOOKBACK_SECONDS` / `Z_SCORE_THRESHOLD`
combinations and ranks them by backtested win rate (requiring at least 20
decided rounds to qualify, so a lucky tiny sample doesn't win by accident).

**Overfitting warning:** the sweep's "best" config is the best fit to the
specific historical window you tested it on. That is not the same as a
future edge. `npm run walkforward` is the real check for this (see below) -
at minimum, re-run the sweep after time has passed and see if the same
config still ranks well before trusting it live.

**What backtesting does NOT cover:** it approximates trades with 1-second
kline data rather than the raw tick stream, simulates its own round
boundaries rather than PancakeSwap's actual on-chain timestamps, and does
not model pool-imbalance bet sizing at all (see below).

## Walk-forward validation and z-score calibration

`npm run walkforward` splits `BACKTEST_HOURS` into `WALKFORWARD_FOLDS`
sequential chunks. For each pair of consecutive folds, it runs the same grid
search as `sweep.js` on fold N ("training"), then tests that exact,
untouched config on fold N+1 ("out-of-sample"). It reports both win rates
and flags a large gap between them as the signature of overfitting - a
config that only looked good because it fit that specific window's noise.
A small gap, or an out-of-sample rate that holds above the ~51.5% breakeven
line, is real (if still limited) evidence of a persistent edge.

`npm run calibrate` buckets every historical decision by `|z-score|` and
reports the win rate per bucket, with the threshold temporarily forced to 0
so the full range gets captured regardless of your live `Z_SCORE_THRESHOLD`.
If win rate climbs as z-score rises, the confidence measure the whole
threshold/sizing system rests on is real. If it's flat, treat z-score as a
pass/fail filter only, not something to size more finely against.

## Ensemble voting (`ENABLE_ENSEMBLE_VOTING`) - highest priority of all

Instead of picking one mode exclusively, this combines whichever ones are
enabled as independent votes and only bets when enough of them agree.
Momentum always participates; crowd-following and wallet-copy participate
too if their own `ENABLE_` flags are also on. Each still uses its own
existing logic and thresholds unchanged (crowd-following still needs
`CROWD_MIN_MARGIN_PCT` to vote at all, momentum still needs its z-score
threshold cleared, etc.) - the only new thing is combining their verdicts.
If at least `ENSEMBLE_MIN_AGREEMENT` agree on the same direction, that's the
bet; otherwise the round is skipped.

Example: with wallet-copy and momentum both enabled and
`ENSEMBLE_MIN_AGREEMENT=2`, a bet only happens when the wallet you're
following and your own momentum signal agree - if wallet-copy says BEAR and
momentum also says BEAR, that's a bet; if they disagree, it's skipped.

A few things worth knowing:

- **Sizing is independent of voting.** The winning direction is bet using
  flat `BET_AMOUNT_BNB` (or pool-sizing, if you'd rather enable that) -
  never wallet-copy's exact amount, even when its vote is part of the
  winning majority. Mixing "copy their direction" with "copy their size"
  only when they happen to agree with others felt more likely to confuse
  than help.
- **Wallet-copy's timing changes here.** Standalone, it watches the whole
  round since the target could bet any time. In a vote, everything has to
  be compared at the same moment, so wallet-copy's vote only counts if the
  target has *already* bet by the time the snipe window arrives - a late
  bettor may frequently show up as "no vote" rather than contributing.
- **Startup refuses an impossible config.** If `ENSEMBLE_MIN_AGREEMENT`
  exceeds the number of voters that could ever participate (e.g. requiring
  2 agreements with only momentum enabled), the bot won't start - that
  config would skip every round forever, so it's better to catch it
  immediately than have the bot quietly do nothing.
- **Still can't be backtested** whenever crowd-following or wallet-copy are
  among the voters, for the same reasons those modes can't be individually.
  Dry run remains the way to evaluate this.

## Wallet-copy (`ENABLE_WALLET_COPY`) - alternative mode

Watches one specific wallet (`COPY_WALLET_ADDRESS`) and copies its bets
directly: same direction, same amount (up to `COPY_WALLET_MAX_BET_BNB`, a
safety ceiling - if they bet more than this, the copy is capped rather than
matching exactly). This replaces momentum, cross-asset, oracle-divergence,
crowd-following, and pool-sizing entirely - if this is on, none of those run.

Unlike the momentum/crowd-following modes, this checks **every tick**, not
just near lock - the target could bet at any point during the round's
5-minute betting window, so it watches continuously via
`ledger(currentEpoch, theirAddress)` and acts the moment their bet appears.

**Timing risk worth knowing:** if the target bets late in the round (the
same last-second style this bot itself uses), there may not be enough time
left to detect it and get your own transaction confirmed before lock. This
works best against wallets that tend to bet earlier in the round.

If both `ENABLE_WALLET_COPY` and `ENABLE_CROWD_FOLLOWING` are on, wallet-copy
wins (crowd-following is never evaluated) - logged clearly at startup.

**Also cannot be backtested** - historical per-wallet bet data isn't
available from Binance's price data, only from on-chain history. Dry run is
free validation here too: it watches the real wallet's real bets regardless
of `DRY_RUN`, so you see exactly what it would have copied with zero funds
at risk.

When this is on, the dashboard also shows the target wallet's own last 10
bets and outcomes as a separate reference table - not what we copied, what
*they* actually did. A background scan populates this at startup - can take
several minutes depending on how active the wallet is and your RPC's actual
rate limit, since this now paces requests deliberately rather than assuming
a fast scan is safe (see the wallet-history section above for why). The
dashboard shows "loading" and the console logs progress roughly every 15
seconds while this runs, so it never looks stuck even when it's slow.
Afterward it's kept current from the same polling the live copying already
does, so it costs no extra ongoing RPC calls once loaded.

## Crowd-following (`ENABLE_CROWD_FOLLOWING`) - alternative mode

This is a different mode entirely, not an add-on: instead of the momentum/
cross-asset/oracle-divergence signal, it bets whichever side (BULL or BEAR)
currently has more money in the round's pool - "the crowd is probably
right" - provided the margin between the two sides clears
`CROWD_MIN_MARGIN_PCT` (in percentage points; a 55/45 split is a 10pp
margin). Below that margin, or with no bets in the pool yet, it skips the
round. Same timing as everything else - it checks at `SNIPE_WINDOW_SECONDS`
before lock, since the pool split can still shift until then.

**This directly contradicts `ENABLE_POOL_SIZING`.** Pool sizing exists to
bet *against* the crowd, because the less-crowded side pays a better
multiplier if it wins - the opposite premise from "the crowd is right."
Enabling both doesn't fail, but pool sizing is ignored while crowd-following
is active (with a warning logged at startup), because applying it would
mean routinely skipping or shrinking the exact bets crowd-following wants
to place.

**Also cannot be backtested**, for the same reason as pool sizing and
oracle divergence: historical pool splits per round aren't in Binance's
price data. Evaluate it in dry run.

## Pool-imbalance bet sizing (`ENABLE_POOL_SIZING`)

This is a different kind of lever from everything above - it doesn't
improve prediction accuracy, it changes what a correct prediction earns.
Every round's BULL/BEAR pool implies a payout multiplier if a given side
wins (crowded side = poor payout, less-crowded side = better payout).
When enabled:

- Below `MIN_PAYOUT_MULTIPLIER`, the bot skips the round entirely even if
  the direction signal fired - not worth the risk for a poor payout.
- Above that, bet size scales linearly up to `BET_AMOUNT_MAX_BNB` as the
  payout multiplier improves toward `MAX_PAYOUT_MULTIPLIER_FOR_SIZING`.
- The fee used in this math is read live from the contract's own
  `treasuryFee()` at startup (confirmed against the actual verified source -
  it's a real, admin-adjustable value, not fixed) - `TREASURY_FEE_PCT` in
  `.env` is only a fallback if that read fails.

**This cannot be backtested** - historical BULL/BEAR pool splits per round
aren't available from Binance price data, only from PancakeSwap's own
on-chain history, which nothing here fetches. As a partial substitute, dry
run computes a *simulated* PnL using the round's real, observed reward
ratio even though no real bet was placed - so running this in dry run for a
while against live rounds is the closest thing to validation available.

## Auto-claiming winnings (`ENABLE_AUTO_CLAIM`)

Live wins are tracked in a queue rather than claimed one at a time. Every
`CLAIM_CHECK_INTERVAL_MS`, the bot re-verifies each queued epoch is still
claimable, sums the estimated reward, and only sends a batched `claim()`
transaction once that total clears `CLAIM_GAS_BUFFER_MULTIPLIER` times the
estimated gas cost - so a single small win doesn't get claimed at a net
loss. `MAX_QUEUED_CLAIMS` forces a claim once that many epochs are queued
regardless, so rewards don't sit unclaimed indefinitely if they're
individually always small. Only relevant once `DRY_RUN=false`.

## Safety limits (live mode only)

`MAX_CONSECUTIVE_LOSSES` and `MAX_DAILY_LOSS_BNB` halt further live betting
once hit. Disabled in dry run so it can keep gathering stats indefinitely.

## Multiple RPC endpoints

Set `RPC_URLS` to a comma-separated list instead of a single URL - useful if
you're combining free-tier accounts from more than one provider (or more
than one account on the same provider) so hitting one's rate limit or credit
cap doesn't stall the bot:

```
RPC_URLS=https://endpoint-a.example/rpc,https://endpoint-b.example/rpc
```

**Reads** (round state, prices, claimable checks) automatically retry across
the whole list on a rate-limit/timeout/connection-style error, up to one
full pass, before giving up. **Writes** (placing a bet, claiming) do NOT
auto-retry with a fresh call - if a transaction actually landed but the
response timed out, resending an independently-built transaction (fresh
nonce) could double-bet or double-claim. A write failure still rotates the
pointer so the *next* attempt uses a different endpoint, but that's the
bot's own next round or claim check, not this module silently resending.
A single `RPC_URLS` value (or the old `RPC_URL`) works exactly as before.

## Notifications (Discord/Telegram)

Set `ENABLE_NOTIFICATIONS=true` plus at least one of `DISCORD_WEBHOOK_URL` or
`TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` to get alerts for the things you'd
otherwise only learn by checking the dashboard yourself:

- **The bot halts** (consecutive-loss or daily-loss limit reached) - the
  exact "something's going wrong and nobody's watching" scenario that
  matters most once this runs unattended (e.g. deployed on Railway).
- **Startup succeeds** - confirms a redeploy or restart actually came back
  up, and states which mode is active and whether it's DRY RUN or LIVE.
- **A fatal crash** - both an uncaught exception/rejection and a startup
  failure trigger this. The process waits up to 5 seconds for the
  notification to actually send before exiting, so a real crash isn't
  silent even if nothing's watching the logs - but it never waits longer
  than that, so a broken or slow notification endpoint can't hang the
  process either.

Optionally, `NOTIFY_ON_BET_RESULT=true` adds a notification for every
resolved bet (win/loss/tie). This is off by default since a bet resolves
roughly every 5 minutes - hundreds of notifications a day if left on
continuously. Each is tagged `[DRY RUN]` or `[LIVE]`, so it's safe to turn
on temporarily during dry-run testing specifically to confirm your
notification setup works, before relying on it once live.

Both channels are plain HTTP calls (a Discord webhook POST, a Telegram Bot
API call) - no SDK, no new dependency. A failed or slow notification is
logged and never affects the actual trading logic; delivery is always
best-effort, never something the bot's own operation depends on.

## Telegram remote control (`ENABLE_TELEGRAM_CONTROL`)

Adds three commands to the same Telegram bot notifications already use -
no separate setup beyond turning this on:

- **`/stats`** - current mode, dry-run/live status, win rate, PnL, pending
  bet count, and whether it's paused or halted.
- **`/stop`** - pauses new betting decisions. The price feed, dashboard,
  and this command listener all keep running, and any bet already placed
  still resolves and claims normally - only new decisions stop.
- **`/start`** - resumes after `/stop`.

Only messages from `TELEGRAM_CHAT_ID` are ever acted on - a message from
anyone else who happens to message your bot is silently ignored, not
replied to, since this can pause and resume live betting.

**`/start` will not clear a safety halt** from `MAX_CONSECUTIVE_LOSSES` or
`MAX_DAILY_LOSS_BNB` - it replies explaining that and pointing at
`npm run reset-stats` instead, the same deliberate step required today.
Pausing the bot is meant to be easy and reversible; overriding a loss limit
you configured for yourself with a single quick text message is not
something worth making equally easy.

This is Telegram-only - Discord doesn't have an equivalent lightweight way
to receive messages back. A real command listener there needs a persistent
gateway connection via a much heavier library, not the plain HTTP polling
this uses.

**A `409` in the logs during a redeploy is expected, not a bug.** Telegram
only allows one active connection per bot token. Platforms with zero-
downtime deploys (Render and Railway both work this way) briefly run the
old and new instances of your service side by side - sometimes up to 60
seconds - before shutting the old one down, and Telegram's 409 is just
surfacing that overlap. It clears itself once the old instance is
terminated; this logs as a plain message, not an error, specifically so a
brief spell of these during a deploy doesn't read as something wrong.
Worth knowing this same overlap briefly affects the whole bot process, not
just this feature - two price feeds and two decision loops run for that
window too. This isn't a real double-betting risk (the on-chain check
before placing any bet, plus the contract's own one-bet-per-address-per-
round rule, both stop an actual duplicate from landing), but it's the
reason to keep an eye on the logs right after a redeploy while running
live, rather than assuming everything came back up in exactly one place.

## Dashboard

With `ENABLE_DASHBOARD=true` (the default), a local web UI is available at
`http://localhost:DASHBOARD_PORT` (default 3000). The badge next to
DRY RUN/LIVE always names which mode is actually deciding bets right now -
**ENSEMBLE**, **WALLET-COPY**, **CROWD-FOLLOWING**, or **MOMENTUM** -
matching the exact priority the bot itself uses (ensemble beats wallet-copy
beats crowd-following beats momentum). If more than one is configured in
`.env`, only the highest-priority one is doing anything; the badge tells you
which that is without needing to reason through the config yourself. In
ensemble mode, the line underneath also names which signals are actually
voting and the agreement threshold required.

The rest of the dashboard: win rate, W-L-T record,
PnL (in BNB and, using the live Binance price, its approximate USD
equivalent), the currently open round's total pool and BULL/BEAR split, a
live per-second countdown to when each pending bet resolves along with that
round's pool and an estimated payout in USD if it wins, claim queue size,
and a feed of recent decisions/outcomes/claims. The countdown ticks smoothly
between polls (client-side, from each bet's actual close time) rather than
jumping every 2 seconds. The payout estimate uses the round's *current*
pool split, so it's exact once a round has locked (no more bets can change
it) but still a moving estimate before that. Nothing leaves your machine.
Console logging is unchanged - the dashboard mirrors it, it doesn't replace
it.

## Surviving a restart

Stats, PnL, the halted flag, and any still-pending bets are written to
`bot-state.json` after every change and restored on startup - a restart no
longer resets your win rate or PnL to zero, and a bet that was still
awaiting resolution when the process went down is picked back up rather
than silently dropped (which also means it won't be missed by auto-claim if
it turns out to be a win). This file is local bookkeeping, not on-chain
truth - if you delete it, the bot starts counting from zero again, but no
real funds are affected either way.

**To reset stats/PnL back to zero:** stop the bot, then `npm run
reset-stats`. This clears win/loss counts, PnL, consecutive-loss tracking,
and the halted flag, but - unlike just deleting `bot-state.json` - leaves
any still-pending bet untouched, so a bet awaiting resolution keeps being
tracked normally (and still gets queued for auto-claim if it wins). Deleting
the file directly works too, but only do that when "Pending bets" shows 0 on
the dashboard - otherwise you lose track of that bet's outcome entirely.

## Oracle divergence (`ENABLE_ORACLE_DIVERGENCE`)

PancakeSwap's contract doesn't settle rounds against Binance - it settles
against a Chainlink oracle, and Chainlink updates only on a deviation-
threshold-or-heartbeat basis (this feed moves on a 0.1% swing, and
PancakeSwap's own docs note it can take up to ~20 seconds to update), not
tick-by-tick like Binance. That's too sparse to compute momentum from the
way `priceFeed.js` does - which is why this isn't a replacement for the
Binance feed.

What it's good for instead: the oracle lags Binance, so when live Binance
price has drifted meaningfully from the oracle's last posted value, the
oracle tends to catch up toward it (this is a documented pattern other
PancakeSwap prediction bots have built around, not a novel idea here). When
enabled, this becomes a further required check on top of the momentum
signal: the live Binance-vs-oracle gap must clear
`ORACLE_DIVERGENCE_THRESHOLD_PCT` *and* point the same direction the
momentum signal already picked, or the round is skipped.

`ORACLE_AGGREGATOR_ADDRESS` is the Chainlink BNB/USD feed on BSC mainnet,
cross-checked against BscScan, Chainlink's own feed directory, and BNB
Chain's official docs before shipping - verify it yourself too before
trusting it with real funds.

**This cannot be backtested** - the same limitation as pool sizing, for the
same reason: reconstructing historical Chainlink rounds needs on-chain data
Binance's API doesn't have, and would cost an impractical number of extra
RPC calls per backtest run. Evaluate it in dry run, where every confirm/
reject decision is logged exactly as it would be live.

## Deploying somewhere other than your own machine (Railway, etc.)

This runs fine on Railway or similar platforms - it's a normal long-running
Node.js process. One thing to set explicitly, and two things it needs that
aren't automatic but are already built in:

- **Set the build command to nothing (or just leave it blank) in your
  service's settings.** Railway's auto-detection sometimes picks a script
  from `package.json` to run as a "build" step, and this project doesn't
  have or need one - everything here is plain Node.js with no compilation.
  If left on a wrong auto-detected guess, this can run scripts that expect
  live market data (`backtest`, `sweep`, etc.) during the *build* phase
  instead of when you actually run them, in a build environment that may
  not even have working network access to the services they call. Clearing
  the build command override in your service's Settings avoids this
  entirely - `npm install` followed by `npm start` is all this needs.
- **Port**: platforms like Railway assign a port dynamically via a `PORT`
  environment variable and expect the app to listen on it. `bot.js` already
  prefers `PORT` over `DASHBOARD_PORT` when present, so the dashboard just
  works once deployed - nothing to configure.
- **Persistent state**: Railway's default filesystem is ephemeral - anything
  written to disk is wiped on every redeploy or restart, unless you
  explicitly attach a Volume (in the service's Volumes tab) and mount it at
  a path. Set `STATE_FILE_PATH` to somewhere inside that mounted path (e.g.
  `/data/bot-state.json`) so stats/PnL/pending-bet recovery actually
  survives redeploys. Skip this and it still runs correctly - `bot-state.json`
  just resets to zero on every redeploy, the same as deleting it manually.
  **No funds are ever at risk from this either way** - the on-chain
  restart-safety check (`ledger()`) is a completely separate mechanism that
  doesn't depend on this file at all.

Everything else - `.env` variables, `RPC_URLS`, `PRIVATE_KEY` - just becomes
environment variables set through the platform's dashboard instead of a
local `.env` file; the code reads `process.env` either way.

Two things worth deciding with eyes open, not code fixes:

- **You're trusting that platform with `PRIVATE_KEY`.** This is a real
  private key with signing authority over your wallet's funds, going into a
  third party's environment variable store rather than staying on a machine
  you control. That's a standard thing to do for automated trading
  bots generally, and Railway's env vars aren't exposed in logs or builds,
  but it's a different trust boundary than running this locally, and worth
  being deliberate about - e.g., using a wallet funded only with what
  this bot is actively risking, not a wallet holding anything else.
- **Continuous 24/7 operation isn't free indefinitely.** Railway bills
  running services by resource usage after an initial trial credit - a
  lightweight Node.js process like this should be cheap, but budget for an
  ongoing small cost, not a permanently free deployment.

## Reliability hardening

Four things worth knowing if the dashboard or bot ever seems to misbehave:

- **The bot verifies it's on the right network before making any contract
  call.** A wrong-network RPC (e.g. accidentally pointing at a testnet, or a
  different chain's endpoint) means `CONTRACT_ADDRESS` simply doesn't exist
  there - every single call then fails with a cryptic `missing revert data`
  error (`CALL_EXCEPTION`, empty data) rather than anything obviously
  network-related. Startup now checks the connected chain ID against
  `EXPECTED_CHAIN_ID` (56, BSC mainnet, by default) and exits with a clear
  message immediately if they don't match, instead of that error repeating
  on every loop tick forever.
- **`backtest.js`, `sweep.js`, and `walletHistory.js` now detect direct
  execution correctly on Windows.** They previously compared
  `import.meta.url` against a manually-built `file://` string, which never
  matches on Windows (different slash direction, drive-letter encoding) -
  meaning `npm run backtest`, `npm run sweep`, and `npm run wallet-history`
  could silently do nothing at all (no output, no error, clean exit) on
  Windows specifically. Fixed using Node's own `pathToFileURL()`, which
  handles this correctly on every OS. If you're on Windows and any of these
  commands were mysteriously silent before, this was why. That check also
  now guards against `process.argv[1]` being unset (some invocation
  contexts don't set it) before calling `pathToFileURL()` on it, rather than
  crashing - relevant now that `bot.js` itself imports functions from
  `walletHistory.js`.

- **A dashboard bug can't take down the bot.** The HTTP handler for
  `/api/status` catches any error building the snapshot and returns a 500
  instead of letting it propagate - a rendering issue in the dashboard layer
  should never be able to crash the process that's placing real bets. The
  page itself distinguishes three cases with different messages: can't reach
  the bot at all ("lost connection"), the bot responded but with an error
  ("bot responded with an error... bot itself may still be running"), and a
  client-side rendering bug ("dashboard display error... bot itself is still
  running") - check the browser console for the last one.
- **Startup RPC checks retry before giving up.** The one-time checks at boot
  (is the market paused, what's the minimum bet, the first oracle read) each
  retry up to 3 times with a short delay before the bot exits - a transient
  hiccup on a single free RPC endpoint (no `RPC_URLS` fallback to fail over
  to) no longer takes the whole process down immediately. The ongoing main
  loop already had its own per-tick error handling and didn't need this.

## Restart safety

In-memory decision tracking resets on a crash or restart, but the bot checks
your on-chain position (`ledger()`) before betting on any round it hasn't
decided on yet this session - so restarting mid-snipe-window on a round you
already hold a position in won't cause a duplicate bet. If that check itself
fails (RPC hiccup), it skips betting that tick rather than risk one, and
retries on the next tick. Only active in live mode; dry run has nothing to
protect against. This is separate from (and doesn't depend on) the
`bot-state.json` persistence described above - the on-chain check protects
against double-betting even if that file is deleted or corrupted.

## What's still not included

- Support for the zkSync Era / Arbitrum One prediction markets - this
  targets the original BNB Chain BNB/USDT market only.
- Alerting beyond the dashboard/console (e.g. push notifications).
