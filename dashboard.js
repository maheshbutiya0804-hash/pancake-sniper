import http from 'http';

// dashboard.js
//
// A tiny local web dashboard so you don't have to tail console logs. Serves
// one HTML page (self-contained, no build step) that polls a JSON endpoint
// every 2s. bot.js owns the actual state; this module just renders whatever
// snapshot() returns.

const PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Pancake Sniper Dashboard</title>
<style>
  body { font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #0f1115; color: #e5e7eb; margin: 0; padding: 24px; }
  h1 { font-size: 18px; color: #f4b73f; margin: 0 0 4px; }
  .sub { color: #9ca3af; font-size: 13px; margin-bottom: 16px; }
  .badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; margin-bottom: 20px; }
  .badge.dry { background: #1e3a5f; color: #7dd3fc; }
  .badge.live { background: #4c1d1d; color: #fca5a5; }
  .badge.halted { background: #4c1d1d; color: #fca5a5; margin-left: 8px; }
  .badge.mode { background: #3730a3; color: #c7d2fe; margin-left: 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #1a1d24; border: 1px solid #2a2e37; border-radius: 10px; padding: 14px; }
  .card .label { font-size: 11px; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.05em; }
  .card .value { font-size: 22px; font-weight: 600; margin-top: 4px; }
  .value.pos { color: #4ade80; }
  .value.neg { color: #f87171; }
  .result-won { color: #4ade80; font-weight: 600; }
  .result-lost { color: #f87171; font-weight: 600; }
  h3 { font-size: 13px; text-transform: uppercase; color: #9ca3af; letter-spacing: 0.05em; margin-bottom: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #2a2e37; }
  th { color: #9ca3af; font-weight: 500; font-size: 11px; text-transform: uppercase; }
  tr:last-child td { border-bottom: none; }
  #conn-warning { display: none; color: #f87171; font-size: 12px; margin-bottom: 12px; }
</style>
</head>
<body>
  <h1>Pancake Prediction Sniper</h1>
  <div class="sub" id="config-line">loading…</div>
  <div id="status-line"></div>
  <div id="conn-warning">Lost connection to the bot process - is it still running?</div>
  <div class="grid" id="cards"></div>
  <div class="sub" id="round-line"></div>
  <div id="target-wallet-section" style="display:none">
    <h3 style="margin-top:20px">Target wallet's recent bets</h3>
    <div class="sub" id="target-wallet-address"></div>
    <table><thead><tr><th>Epoch</th><th>Direction</th><th>Amount</th><th>Result</th></tr></thead><tbody id="target-wallet-bets"></tbody></table>
  </div>
  <h3>Pending bets</h3>
  <table><thead><tr><th>Epoch</th><th>Direction</th><th>Amount</th><th>Round pool</th><th>Est. payout if win</th><th>Resolves in</th></tr></thead><tbody id="pending-bets"></tbody></table>
  <h3 style="margin-top:20px">Recent activity</h3>
  <table><thead><tr><th style="width:90px">Time</th><th>Event</th></tr></thead><tbody id="events"></tbody></table>

<script>
let currentPendingBets = [];

function formatCountdown(ms) {
  if (ms <= 0) return 'resolving…';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + 'm ' + String(s).padStart(2, '0') + 's';
}

function renderPendingBets() {
  const rows = currentPendingBets.map(function(b) {
    const remaining = b.closeTimestamp - Date.now();
    const pool = b.poolTotalBnb != null ? b.poolTotalBnb + ' BNB' : '—';
    const payout = b.potentialPayoutUsd != null
      ? '~$' + b.potentialPayoutUsd + (b.potentialPayoutBnb != null ? ' (' + b.potentialPayoutBnb + ' BNB)' : '')
      : '—';
    return '<tr><td>' + b.epoch + '</td><td>' + b.direction + (b.simulated ? ' (sim)' : '') + '</td><td>' + b.amountBnb + ' BNB</td><td>' + pool + '</td><td>' + payout + '</td><td>' + formatCountdown(remaining) + '</td></tr>';
  }).join('');
  document.getElementById('pending-bets').innerHTML = rows || '<tr><td colspan="6" style="color:#9ca3af">none</td></tr>';
}
setInterval(renderPendingBets, 1000); // ticks every second independent of the 2s poll below

async function refresh() {
  const warningEl = document.getElementById('conn-warning');

  let res;
  try {
    res = await fetch('/api/status');
  } catch (err) {
    // Genuine network failure - the bot process really isn't reachable.
    warningEl.textContent = 'Lost connection to the bot process - is it still running?';
    warningEl.style.display = 'block';
    return;
  }

  if (!res.ok) {
    // Server responded but with an error (e.g. a snapshot bug on the bot's
    // side) - the bot process itself may well still be running and trading.
    warningEl.textContent = 'Bot responded with an error (status ' + res.status + ') - check its console output. The bot itself may still be running fine.';
    warningEl.style.display = 'block';
    return;
  }

  try {
    const s = await res.json();
    warningEl.style.display = 'none';

    const modeBadgeText = s.activeMode === 'ensemble' ? 'ENSEMBLE'
      : s.activeMode === 'wallet-copy' ? 'WALLET-COPY'
      : s.activeMode === 'crowd-following' ? 'CROWD-FOLLOWING'
      : 'MOMENTUM';

    document.getElementById('status-line').innerHTML =
      '<span class="badge ' + (s.isDryRun ? 'dry' : 'live') + '">' + (s.isDryRun ? 'DRY RUN' : 'LIVE') + '</span>' +
      '<span class="badge mode">' + modeBadgeText + '</span>' +
      (s.halted ? '<span class="badge halted">HALTED</span>' : '');

    let configLine;
    if (s.activeMode === 'ensemble') {
      configLine = 'Combining ' + s.ensembleVoters.join(' + ') + ' - needs ' + s.ensembleMinAgreement + '/' + s.ensembleVoters.length + ' agreement to bet, otherwise skips.';
    } else if (s.activeMode === 'wallet-copy') {
      configLine = 'Following ' + s.copyWalletAddress + ' - every other signal (momentum, cross-asset, oracle, crowd-following, pool-sizing) is bypassed while this is active.';
    } else if (s.activeMode === 'crowd-following') {
      configLine = 'Betting whichever side has more money in the pool (min margin ' + s.crowdMinMarginPct + '%) - momentum/cross-asset/oracle/pool-sizing are bypassed while this is active.';
    } else {
      configLine = 'short=' + s.signalConfig.shortLookbackSeconds + 's long=' + s.signalConfig.longLookbackSeconds + 's zThreshold=' + s.signalConfig.zScoreThreshold +
        (s.crossAssetEnabled ? ' + ' + s.crossAssetSymbol + ' cross-check' : '') +
        (s.poolSizingEnabled ? ' + pool sizing' : '') +
        (s.oracleDivergenceEnabled && s.oraclePrice != null ? ' + oracle $' + s.oraclePrice.toFixed(2) + ' (' + s.oracleAgeSeconds.toFixed(0) + 's stale)' : '');
    }
    configLine += s.autoClaimEnabled ? ' + auto-claim' : '';
    document.getElementById('config-line').textContent = configLine;

    if (s.currentRound) {
      const cr = s.currentRound;
      const bullNum = parseFloat(cr.bullBnb), bearNum = parseFloat(cr.bearBnb);
      const poolTotal = bullNum + bearNum;
      const bullPct = poolTotal > 0 ? ((bullNum / poolTotal) * 100).toFixed(0) : '—';
      const bearPct = poolTotal > 0 ? ((bearNum / poolTotal) * 100).toFixed(0) : '—';
      document.getElementById('round-line').textContent =
        'Current round #' + cr.epoch + ': pool ' + cr.totalBnb + ' BNB' + (cr.totalUsd != null ? ' (~$' + cr.totalUsd + ')' : '') +
        ' — BULL ' + bullPct + '% / BEAR ' + bearPct + '%';
    } else {
      document.getElementById('round-line').textContent = '';
    }

    const totalDecided = s.stats.wins + s.stats.losses;
    const winRate = totalDecided ? ((s.stats.wins / totalDecided) * 100).toFixed(1) : '0.0';
    const pnl = s.isDryRun ? s.simulatedPnlBnb : s.netPnlBnb;
    const pnlUsd = s.isDryRun ? s.simulatedPnlUsd : s.netPnlUsd;
    const pnlClass = parseFloat(pnl) > 0 ? 'pos' : (parseFloat(pnl) < 0 ? 'neg' : '');
    const pnlUsdBit = pnlUsd != null ? '<br><span style="font-size:13px;font-weight:400;opacity:0.75">~$' + pnlUsd + '</span>' : '';

    document.getElementById('cards').innerHTML =
      '<div class="card"><div class="label">Win rate</div><div class="value">' + winRate + '%</div></div>' +
      '<div class="card"><div class="label">Record (W-L-T)</div><div class="value">' + s.stats.wins + '-' + s.stats.losses + '-' + s.stats.ties + '</div></div>' +
      '<div class="card"><div class="label">Skipped</div><div class="value">' + s.stats.skipped + '</div></div>' +
      '<div class="card"><div class="label">' + (s.isDryRun ? 'Simulated' : 'Net') + ' PnL</div><div class="value ' + pnlClass + '">' + pnl + ' BNB' + pnlUsdBit + '</div></div>' +
      '<div class="card"><div class="label">Pending bets</div><div class="value">' + s.pendingBets.length + '</div></div>' +
      '<div class="card"><div class="label">Claim queue</div><div class="value">' + s.claimQueueSize + '</div></div>';

    currentPendingBets = s.pendingBets;
    renderPendingBets();

    const targetSection = document.getElementById('target-wallet-section');
    if (s.walletCopyEnabled) {
      targetSection.style.display = 'block';
      document.getElementById('target-wallet-address').textContent = s.copyWalletAddress;
      if (s.targetWalletHistoryLoading) {
        document.getElementById('target-wallet-bets').innerHTML = '<tr><td colspan="4" style="color:#9ca3af">loading recent history…</td></tr>';
      } else if (!s.targetWalletHistory.length) {
        document.getElementById('target-wallet-bets').innerHTML = '<tr><td colspan="4" style="color:#9ca3af">no bets found</td></tr>';
      } else {
        document.getElementById('target-wallet-bets').innerHTML = s.targetWalletHistory.map(function(b) {
          const cls = b.outcome.startsWith('WON') ? 'result-won' : (b.outcome.startsWith('LOST') ? 'result-lost' : '');
          return '<tr><td>' + b.epoch + '</td><td>' + b.direction + '</td><td>' + b.amountBnb + ' BNB</td><td class="' + cls + '">' + escapeHtml(b.outcome) + '</td></tr>';
        }).join('');
      }
    } else {
      targetSection.style.display = 'none';
    }

    document.getElementById('events').innerHTML = s.recentEvents.map(function(e) {
      return '<tr><td>' + new Date(e.time).toLocaleTimeString() + '</td><td>' + escapeHtml(e.msg) + '</td></tr>';
    }).join('');
  } catch (err) {
    // The bot IS reachable and responded fine - this is a client-side
    // rendering bug, not a connection problem. Say so, and log the real
    // error for anyone debugging it.
    console.error('[dashboard] render error:', err);
    warningEl.textContent = 'Dashboard display error (' + err.message + ') - the bot itself is still running. Check the browser console for details.';
    warningEl.style.display = 'block';
  }
}
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, function(c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;

/**
 * Starts the dashboard HTTP server. `getSnapshot` is a zero-arg function
 * returning a plain JSON-serializable object - called fresh on every
 * request, so it always reflects bot.js's current in-memory state.
 */
export function startDashboard(getSnapshot, port) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/status') {
      try {
        const snapshot = getSnapshot();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(snapshot));
      } catch (err) {
        // A bug here must never crash the bot process that's placing real
        // bets - isolate it to a 500 response instead.
        console.error('[dashboard] snapshot/serialize error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PAGE_HTML);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  server.on('error', (err) => {
    console.error(`[dashboard] failed to start on port ${port}:`, err.message);
  });

  server.listen(port, () => {
    console.log(`[dashboard] running at http://localhost:${port}`);
  });

  return server;
}
