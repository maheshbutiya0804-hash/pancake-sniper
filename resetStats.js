// resetStats.js
//
// Resets win/loss/PnL tracking to zero without touching any bet still
// awaiting resolution. Deleting bot-state.json entirely would forget those
// too - and a win among them would then never get queued for auto-claim,
// since that queue lives in the same file. Run this while the bot is
// STOPPED (it doesn't coordinate with a running process).
//
// Usage: node resetStats.js

import { loadState, saveState } from './statePersistence.js';

const current = loadState();

if (!current) {
  console.log('No bot-state.json found - nothing to reset (a fresh start already shows zero).');
  process.exit(0);
}

const pendingCount = current.pendingBets?.length ?? 0;

saveState({
  stats: { wins: 0, losses: 0, ties: 0, skipped: 0 },
  netPnlWei: '0',
  simulatedPnlWei: '0',
  dailyLossBnb: 0,
  dayStart: Date.now(),
  consecutiveLosses: 0,
  halted: false,
  pendingBets: current.pendingBets ?? [], // preserved - these are real, still-unresolved bets
});

console.log('Stats and PnL reset to zero.');
if (pendingCount > 0) {
  console.log(`${pendingCount} pending bet(s) preserved - their outcomes will still be tracked normally once they resolve.`);
}
if (current.halted) {
  console.log('Note: the bot was HALTED - that flag is now cleared too, so it will resume betting on next start.');
}
