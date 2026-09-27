// Discord's "西寶 is typing…" indicator lasts ~10 s per sendTyping call, so a
// reply that thinks for 20-40 s needs it re-sent while it waits. Without it the
// user stares at nothing and assumes she's dead — the wait itself is what made
// timeouts feel so bad. Purely cosmetic: a failed sendTyping never blocks the
// reply.
const TYPING_REFRESH_MS = 8000;

async function withTyping(channel, fn, { refreshMs = TYPING_REFRESH_MS } = {}) {
  if (!channel || typeof channel.sendTyping !== "function") return fn();
  const ping = () => {
    Promise.resolve()
      .then(() => channel.sendTyping())
      .catch(() => {});
  };
  ping();
  const timer = setInterval(ping, refreshMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

module.exports = { withTyping, TYPING_REFRESH_MS };
