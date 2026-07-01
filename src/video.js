const {
  VIDEO_ATTACHMENT_ENABLED,
  VIDEO_ATTACHMENT_GUILD_IDS,
  VIDEO_ATTACHMENT_MAX_BYTES,
  VIDEO_ATTACHMENT_MAX_CONCURRENT,
  VIDEO_ATTACHMENT_TIMEOUT_MS,
} = require("./config");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Discord per-message upload limit by guild boost tier (MiB). The base was
// bumped to 25 MiB for everyone; boost tiers 2/3 raise it. A bot uploading to a
// guild is bound by that guild's tier — not by any Nitro the poster may have.
const UPLOAD_LIMIT_MIB_BY_TIER = { 0: 25, 1: 25, 2: 50, 3: 100 };

function uploadLimitBytes(guild) {
  const tier = guild?.premiumTier ?? 0;
  const mib = UPLOAD_LIMIT_MIB_BY_TIER[tier] ?? 25;
  return mib * 1024 * 1024;
}

function isGuildVideoAllowed(guild) {
  if (!VIDEO_ATTACHMENT_ENABLED) return false;
  if (!guild) return false; // no guild context (DM) → can't know the limit
  if (VIDEO_ATTACHMENT_GUILD_IDS.length === 0) return true; // empty allowlist = all
  return VIDEO_ATTACHMENT_GUILD_IDS.includes(guild.id);
}

// Effective byte cap: the guild's Discord limit, optionally lowered further by
// the VIDEO_ATTACHMENT_MAX_BYTES override (never raised above the guild limit).
function effectiveMaxBytes(guild) {
  const guildLimit = uploadLimitBytes(guild);
  return VIDEO_ATTACHMENT_MAX_BYTES > 0
    ? Math.min(VIDEO_ATTACHMENT_MAX_BYTES, guildLimit)
    : guildLimit;
}

// Global cap on simultaneous downloads. A flood of video links can't pile up:
// once this is saturated, extra posts fall straight back to the fixer link.
let inFlight = 0;

// Stream the body, aborting the moment it exceeds maxBytes — so a missing or
// lying Content-Length can't make us buffer an unbounded download.
async function readCapped(response, maxBytes) {
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// Download `url` as a Discord-uploadable video attachment, or return null to
// signal the caller should fall back to the fixer link. Never throws.
async function fetchVideoAttachment(url, guild) {
  if (!url || !isGuildVideoAllowed(guild)) return null;
  if (inFlight >= VIDEO_ATTACHMENT_MAX_CONCURRENT) {
    console.log(
      `[video] skip (concurrency ${inFlight}/${VIDEO_ATTACHMENT_MAX_CONCURRENT}) → fixer`,
    );
    return null;
  }

  const maxBytes = effectiveMaxBytes(guild);
  inFlight += 1;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    VIDEO_ATTACHMENT_TIMEOUT_MS,
  );
  try {
    // Cheap pre-check: reject oversize on the HEAD, before downloading a byte.
    try {
      const head = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": BROWSER_UA },
      });
      const len = Number(head.headers.get("content-length") || 0);
      if (len > maxBytes) {
        console.log(`[video] too big ${len}B > ${maxBytes}B → fixer`);
        return null;
      }
    } catch {
      // HEAD unsupported / blocked — fall through to the capped GET below.
    }

    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": BROWSER_UA },
    });
    if (!res.ok || !res.body) {
      console.log(`[video] fetch ${res.status} → fixer`);
      return null;
    }
    const buffer = await readCapped(res, maxBytes);
    if (!buffer) {
      console.log(`[video] exceeded ${maxBytes}B mid-download → fixer`);
      return null;
    }
    console.log(
      `[video] attached bytes=${buffer.length} guild=${guild?.id ?? "?"}`,
    );
    return { buffer, name: "threads-video.mp4" };
  } catch (error) {
    console.warn(`[video] fetch failed: ${error.message} → fixer`);
    return null;
  } finally {
    clearTimeout(timer);
    inFlight -= 1;
  }
}

module.exports = {
  uploadLimitBytes,
  isGuildVideoAllowed,
  effectiveMaxBytes,
  fetchVideoAttachment,
};
