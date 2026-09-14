// telegramControl.js
//
// Polls Telegram for incoming commands (long-polling via getUpdates) and
// dispatches them to callbacks bot.js provides. Only messages from
// TELEGRAM_CHAT_ID (the same chat notify.js sends alerts to) are ever acted
// on - a message from anyone else is silently ignored, since this can pause
// and resume live betting. Uses the same bot token as notify.js but is a
// separate module: sending alerts and listening for commands are different
// concerns, and Discord has no equivalent of this (a real command listener
// there needs a persistent gateway connection via a much heavier library,
// not a plain HTTP poll), so this stays Telegram-only by design.

const {
  ENABLE_TELEGRAM_CONTROL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} = process.env;

const controlEnabled = ENABLE_TELEGRAM_CONTROL === 'true' && !!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID;
const API_BASE = TELEGRAM_BOT_TOKEN ? `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}` : null;
const POLL_TIMEOUT_SECONDS = 30; // Telegram long-polling - holds the request open until a message arrives or this elapses, rather than short-polling repeatedly

async function sendReply(text) {
  try {
    const res = await fetch(`${API_BASE}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: text.slice(0, 4096) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      console.error(`[telegram-control] sendMessage returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.error('[telegram-control] failed to send reply:', err.message);
  }
}

async function fetchUpdates(offset, timeoutSeconds) {
  const res = await fetch(`${API_BASE}/getUpdates?timeout=${timeoutSeconds}&offset=${offset}`, {
    signal: AbortSignal.timeout((timeoutSeconds + 10) * 1000), // headroom beyond Telegram's own long-poll timeout
  });
  if (!res.ok) throw new Error(`getUpdates returned ${res.status}`);
  const data = await res.json();
  return data.result || [];
}

/**
 * handlers: { getStatsText: () => string, onStop: () => string, onStart: () => string }
 * Each returns the text to reply with. Runs an internal long-polling loop
 * that never returns; polling errors are logged and retried after a short
 * delay rather than propagating - this must never be able to affect the
 * actual trading loop it runs alongside.
 */
export function startTelegramControl(handlers) {
  if (!controlEnabled) return;

  let offset = 0;

  async function skipExistingBacklog() {
    // On startup, discard any commands sent while the bot wasn't running -
    // act only on commands sent from this point forward. Without this, a
    // bot that was down for a while would replay a backlog of possibly
    // contradictory stop/start toggles the moment it comes back up.
    try {
      const updates = await fetchUpdates(offset, 0);
      for (const update of updates) offset = update.update_id + 1;
    } catch (err) {
      console.error('[telegram-control] failed to clear backlog, starting from current point anyway:', err.message);
    }
  }

  async function pollLoop() {
    for (;;) {
      try {
        const updates = await fetchUpdates(offset, POLL_TIMEOUT_SECONDS);
        for (const update of updates) {
          offset = update.update_id + 1;
          const msg = update.message;
          if (!msg || !msg.text) continue;
          if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) continue; // not the authorized chat - ignore silently, no reply at all

          const command = msg.text.trim().split(/\s+/)[0].toLowerCase();
          if (command === '/stats') {
            await sendReply(handlers.getStatsText());
          } else if (command === '/stop') {
            await sendReply(handlers.onStop());
          } else if (command === '/start') {
            await sendReply(handlers.onStart());
          } else if (command === '/help') {
            await sendReply('Commands:\n/stats - current status, mode, and PnL\n/stop - pause new bets (safe, resumable any time)\n/start - resume betting after /stop');
          }
          // Any other text is silently ignored, not replied to as
          // "unrecognized" - a Telegram chat often carries other messages
          // that were never meant for the bot at all.
        }
      } catch (err) {
        console.error('[telegram-control] poll failed, retrying in 5s:', err.message);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
  }

  skipExistingBacklog().then(pollLoop);
}

export function telegramControlIsEnabled() {
  return controlEnabled;
}
