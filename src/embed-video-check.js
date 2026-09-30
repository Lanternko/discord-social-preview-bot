// Is the video a viewer's embed advertises actually a video?
//
// Why this exists: a viewer whose upstream media fetch failed can keep
// serving og:video while the URL itself answers with a cover jpeg (or a
// 4xx/5xx). Discord then draws a card with a play button that dies with
// "顯示影片失敗" — and because the card has text + a cover, classifyViewerPreview
// called it a success and the fallback chain stopped (deinstagram, reel
// DdvF1gjTizh, 2026-09-30). Only positive evidence of breakage rejects the
// card: a timeout, a blocked HEAD or an unfamiliar content-type is trusted,
// since failing open costs one bad card while failing closed would throw away
// every working viewer we can't reach from this host.

const { readEmbedValue } = require("./viewer-cards");

const VIDEO_CHECK_TIMEOUT_MS = 4000;
// Some viewers only answer for Discord's crawler.
const DISCORD_UA =
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";

function embedVideoUrl(embed) {
  const video = readEmbedValue(embed, "video");
  if (!video) return null;
  return typeof video === "string" ? video : video.url || null;
}

// Returns a reason string when `url` is provably not playable video, else null.
async function probeVideoUrl(url, { fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VIDEO_CHECK_TIMEOUT_MS);
  try {
    // Range 0-0 instead of HEAD: some viewers 405 a HEAD but stream a GET.
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": DISCORD_UA, Range: "bytes=0-0" },
    });
    res.body?.cancel?.().catch(() => {});
    if (res.status >= 400) return `video-http-${res.status}`;
    const type = String(res.headers.get("content-type") || "").toLowerCase();
    if (type.startsWith("image/")) return `video-is-image`;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findBrokenEmbedVideo(embeds, options = {}) {
  const urls = (embeds || []).map(embedVideoUrl).filter(Boolean);
  for (const url of urls) {
    const reason = await probeVideoUrl(url, options);
    if (reason) return reason;
  }
  return null;
}

module.exports = { probeVideoUrl, findBrokenEmbedVideo };
