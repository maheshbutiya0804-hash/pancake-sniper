import fs from 'fs';

// statePersistence.js
//
// Generic JSON load/save for bot.js's runtime counters (stats, PnL,
// consecutive-loss tracking, the halted flag, and any still-pending bets) so
// a restart doesn't silently reset them to zero or drop a bet that's still
// awaiting resolution. bot.js owns what goes in the object and handles its
// own BigInt<->string conversion; this module just handles the file.
//
// STATE_FILE_PATH lets this point at a mounted persistent volume on
// platforms with an ephemeral default filesystem (e.g. Railway) - without
// it, this file (and the recovery it provides) is silently wiped on every
// redeploy/restart.

const STATE_FILE = process.env.STATE_FILE_PATH || 'bot-state.json';

export function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[state] failed to load persisted state from ${STATE_FILE}, starting fresh:`, err.message);
    return null;
  }
}

export function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[state] failed to save state to ${STATE_FILE}:`, err.message);
  }
}
