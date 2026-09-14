// notify.js
//
// Sends a plain-text alert to Discord and/or Telegram, whichever are
// configured - both, one, or neither. Both are simple webhook/API calls
// (no SDK, no new dependency - Node's built-in fetch handles it).
//
// A failure here (bad token, unreachable API, whatever) is logged and never
// thrown - a broken notification setup must never affect the actual trading
// logic. That's also why normal callers should NOT await notify() - it's
// fire-and-forget. The one exception is a fatal crash, where the process is
// about to exit anyway and there's nothing left to protect by waiting.

const {
  ENABLE_NOTIFICATIONS,
  DISCORD_WEBHOOK_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} = process.env;

const notificationsEnabled = ENABLE_NOTIFICATIONS === 'true';
const REQUEST_TIMEOUT_MS = 5000; // bounds how long a fatal-crash notify() can ever block exit for

async function sendDiscord(message) {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message.slice(0, 2000) }), // Discord's hard per-message cap
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[notify] Discord webhook returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.error('[notify] Discord webhook failed:', err.message);
  }
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message.slice(0, 4096) }), // Telegram's hard per-message cap
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[notify] Telegram API returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  } catch (err) {
    console.error('[notify] Telegram request failed:', err.message);
  }
}

// Always resolves, never throws - Promise.allSettled means one channel
// failing can't block or fail the other. Callers should NOT await this
// except where delivery must be confirmed before the process exits (a
// fatal crash) - everywhere else, fire-and-forget so a slow or broken
// notification endpoint can never delay the actual trading loop.
export async function notify(message) {
  if (!notificationsEnabled) return;
  await Promise.allSettled([sendDiscord(message), sendTelegram(message)]);
}

// For startup logging - lets bot.js report what's actually configured
// without duplicating notify.js's own env var names.
export function notificationChannels() {
  const channels = [];
  if (DISCORD_WEBHOOK_URL) channels.push('Discord');
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) channels.push('Telegram');
  return channels;
}

export function notificationsAreEnabled() {
  return notificationsEnabled;
}
