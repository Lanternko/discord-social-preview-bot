const {
  VIDEO_ATTACHMENT_TIMEOUT_MS,
  VIDEO_ATTACHMENT_MAX_CONCURRENT,
} = require("./config");
const {
  effectiveMaxBytes,
  isGuildVideoAllowed,
  readCapped,
} = require("./video");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// Discord blurs an attachment whose filename starts with SPOILER_ — the only
// way to hide media the bot uploads itself (embeds have no spoiler flag).
const SPOILER_PREFIX = "SPOILER_";

// Shared with video.js's cap in spirit but counted separately: one post's
// images are downloaded as a group, so a 4-image post holds one slot.
let inFlight = 0;

function spoilerName(index, sourceUrl) {
  const extension =
    String(sourceUrl)
      .split("?")[0]
      .match(/\.(jpe?g|png|gif|webp)$/i)?.[1] || "jpg";
  return `${SPOILER_PREFIX}${index + 1}.${extension.toLowerCase()}`;
}

// Download a post's images for re-upload as spoilered attachments, or return
// null so the caller falls back to a link. The whole set shares the guild's
// upload budget — Discord counts a message's attachments together — so one
// oversize image drops the group rather than sending a partial gallery.
// Never throws.
async function fetchSpoilerImageAttachments(urls, guild) {
  if (!Array.isArray(urls) || urls.length === 0) return null;
  if (!isGuildVideoAllowed(guild)) {
    console.log(
      `[spoiler] guild not allowed guild=${guild?.id ?? "dm"} → 連結`,
    );
    return null;
  }
  if (inFlight >= VIDEO_ATTACHMENT_MAX_CONCURRENT) {
    console.log(
      `[spoiler] skip (concurrency ${inFlight}/${VIDEO_ATTACHMENT_MAX_CONCURRENT}) → 連結`,
    );
    return null;
  }

  let budget = effectiveMaxBytes(guild);
  inFlight += 1;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    VIDEO_ATTACHMENT_TIMEOUT_MS,
  );
  try {
    const attachments = [];
    for (const [index, url] of urls.entries()) {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "User-Agent": BROWSER_UA },
      });
      if (!response.ok || !response.body) {
        console.log(`[spoiler] fetch ${response.status} → 連結`);
        return null;
      }
      const buffer = await readCapped(response, budget);
      if (!buffer) {
        console.log(`[spoiler] over the guild upload cap → 連結`);
        return null;
      }
      budget -= buffer.length;
      attachments.push({ buffer, name: spoilerName(index, url) });
    }
    console.log(
      `[spoiler] attached images=${attachments.length} bytes=${attachments.reduce(
        (sum, item) => sum + item.buffer.length,
        0,
      )} guild=${guild?.id ?? "?"}`,
    );
    return attachments;
  } catch (error) {
    console.warn(`[spoiler] fetch failed: ${error.message} → 連結`);
    return null;
  } finally {
    clearTimeout(timer);
    inFlight -= 1;
  }
}

module.exports = { fetchSpoilerImageAttachments, SPOILER_PREFIX };
