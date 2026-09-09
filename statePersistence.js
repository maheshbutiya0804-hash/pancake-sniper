import fs from 'fs';

// statePersistence.js
//
// Generic JSON load/save for bot.js's runtime counters (stats, PnL,
// consecutive-loss tracking, the halted flag, and any still-pending bets) so
// a restart doesn't silently reset them to zero or drop a bet that's still
// awaiting resolution. bot.js owns what goes in the object and handles its
// own BigInt<->string conversion; this module just handles the file.

const STATE_FILE = 'bot-state.json';

export function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[state] failed to load persisted state, starting fresh:', err.message);
    return null;
  }
}

export function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[state] failed to save state:', err.message);
  }
}
