const { NATIVE_EMBED_WAIT_MS } = require("./config");

// Discord unfurls some links well on its own (measured 2026-09-27: 29/29 X
// single-image posts and 2/2 text posts came back with full text + a
// full-size image, ~0.9s after posting). For those the bot's preview is a
// duplicate, so a payload can carry a `nativeEmbedCheck` and the bot first
// waits to see whether Discord's own embed shows up.

const POLL_INTERVAL_MS = 1000;

// One check per payload: { statusId, requireImage }. The native X embed's
// `url` is the twitter.com permalink, so the status id identifies it whichever
// host (x.com / twitter.com / mobile.) the user pasted.
function embedSatisfies(embed, check) {
  if (!embed?.url?.includes(`/status/${check.statusId}`)) return false;
  if (!embed.description && !embed.title) return false;
  if (check.requireImage && !embed.image && !embed.thumbnail) return false;
  return true;
}

function nativeEmbedsPresent(embeds, checks) {
  return checks.every((check) =>
    embeds.some((embed) => embedSatisfies(embed, check)),
  );
}

// True when every payload can defer to Discord and all their native embeds
// arrived in time. All-or-nothing on purpose: once the bot posts anything,
// its success path suppresses every embed on the user's message, so it can't
// leave one native card up and cover the rest itself.
async function nativeEmbedsCover(message, payloads) {
  if (NATIVE_EMBED_WAIT_MS <= 0) return false;
  if (payloads.length === 0) return false;
  const checks = payloads.map((payload) => payload?.nativeEmbedCheck);
  if (checks.some((check) => !check)) return false;

  const deadline = Date.now() + NATIVE_EMBED_WAIT_MS;
  let embeds = message.embeds || [];
  while (!nativeEmbedsPresent(embeds, checks)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)),
    );
    try {
      embeds = (await message.fetch(true)).embeds || [];
    } catch (error) {
      console.warn(`[native] refetch failed ${message.id}: ${error.message}`);
      return false;
    }
  }
  return true;
}

module.exports = { nativeEmbedsCover, embedSatisfies, nativeEmbedsPresent };
