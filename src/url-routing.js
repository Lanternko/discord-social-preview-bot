const {
  FIXEMBED_BASE_URL,
  FIXER_TWITTER,
  FIXER_THREADS,
  FIXER_REDDIT,
  FIXER_PIXIV,
  FIXER_BLUESKY,
  FIXER_BILIBILI,
  FIXER_FACEBOOK,
  FIXER_INSTAGRAM,
} = require("./config");

const THREADS_HOSTS = new Set([
  "threads.net",
  "www.threads.net",
  "threads.com",
  "www.threads.com",
]);
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const BAHAMUT_HOSTS = new Set(["forum.gamer.com.tw", "m.gamer.com.tw"]);
const PTT_HOSTS = new Set(["ptt.cc", "www.ptt.cc"]);
const BILIBILI_HOSTS = new Set([
  "bilibili.com",
  "www.bilibili.com",
  "b23.tv",
]);
const FACEBOOK_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "fb.watch",
]);
const TWITTER_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "youtu.be",
]);

const REDDIT_HOSTS = new Set([
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "redd.it",
]);
const PIXIV_HOSTS = new Set(["pixiv.net", "www.pixiv.net"]);
const BLUESKY_HOSTS = new Set(["bsky.app", "www.bsky.app"]);

const SUPPORTED_HOSTS = new Set([
  ...THREADS_HOSTS,
  ...INSTAGRAM_HOSTS,
  ...TWITTER_HOSTS,
  ...REDDIT_HOSTS,
  ...PIXIV_HOSTS,
  ...BLUESKY_HOSTS,
  ...FACEBOOK_HOSTS,
  ...BAHAMUT_HOSTS,
  ...PTT_HOSTS,
  ...BILIBILI_HOSTS,
]);

const URL_REGEX = /https?:\/\/[^\s<>()]+/gi;
const IGNORE_MARKERS = ["fxignore", "previewignore", "nopreview"];

const UNIVERSAL_TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_name",
  "utm_reader",
  "fbclid",
  "gclid",
  "gbraid",
  "wbraid",
  "dclid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "li_fat_id",
  "mibextid",
  "mc_cid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref_src",
  "ref_url",
  "xmt",
  "slof",
];

const HOST_GATED_TRACKING_PARAMS = [
  { param: "igsh", hosts: INSTAGRAM_HOSTS },
  { param: "igshid", hosts: INSTAGRAM_HOSTS },
  { param: "t", hosts: TWITTER_HOSTS },
  { param: "s", hosts: TWITTER_HOSTS },
  { param: "si", hosts: YOUTUBE_HOSTS },
  { param: "feature", hosts: YOUTUBE_HOSTS },
  { param: "pp", hosts: YOUTUBE_HOSTS },
  { param: "spm_id_from", hosts: BILIBILI_HOSTS },
  { param: "trackid", hosts: BILIBILI_HOSTS },
  { param: "vd_source", hosts: BILIBILI_HOSTS },
  { param: "from", hosts: BILIBILI_HOSTS },
  { param: "from_spmid", hosts: BILIBILI_HOSTS },
  { param: "seid", hosts: BILIBILI_HOSTS },
  { param: "share_source", hosts: BILIBILI_HOSTS },
  { param: "share_medium", hosts: BILIBILI_HOSTS },
  { param: "share_plat", hosts: BILIBILI_HOSTS },
  { param: "share_session_id", hosts: BILIBILI_HOSTS },
  { param: "share_tag", hosts: BILIBILI_HOSTS },
  { param: "timestamp", hosts: BILIBILI_HOSTS },
  { param: "unique_k", hosts: BILIBILI_HOSTS },
  { param: "upsig", hosts: BILIBILI_HOSTS },
];

function normalizeUrl(rawUrl) {
  const url = new URL(rawUrl);
  for (const param of UNIVERSAL_TRACKING_PARAMS) {
    url.searchParams.delete(param);
  }
  for (const { param, hosts } of HOST_GATED_TRACKING_PARAMS) {
    if (hosts.has(url.hostname)) {
      url.searchParams.delete(param);
    }
  }
  return url.toString();
}

function extractSupportedUrls(content) {
  const matches = content.match(URL_REGEX) || [];
  const urls = [];
  const seen = new Set();

  for (const raw of matches) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }
    if (!SUPPORTED_HOSTS.has(parsed.hostname)) continue;

    const normalized = normalizeUrl(parsed.toString());
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    urls.push(normalized);
  }
  return urls;
}

function replaceHostFixer(originalUrl, fixerHost) {
  const parsed = new URL(originalUrl);
  parsed.hostname = fixerHost;
  return parsed.toString();
}

function buildFallbackUrl(originalUrl) {
  const hostname = new URL(originalUrl).hostname;

  if (TWITTER_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_TWITTER);
  }
  if (THREADS_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_THREADS);
  }
  if (INSTAGRAM_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_INSTAGRAM);
  }
  if (REDDIT_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_REDDIT);
  }
  if (PIXIV_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_PIXIV);
  }
  if (BLUESKY_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_BLUESKY);
  }
  if (BILIBILI_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_BILIBILI);
  }
  if (FACEBOOK_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_FACEBOOK);
  }
  return `${FIXEMBED_BASE_URL}${encodeURIComponent(originalUrl)}`;
}

function shouldIgnoreMessage(message) {
  if (message.author.bot) return true;
  const lower = message.content.toLowerCase();
  return IGNORE_MARKERS.some((marker) => lower.includes(marker));
}

function isThreadsUrl(url) {
  return THREADS_HOSTS.has(new URL(url).hostname);
}
function isInstagramUrl(url) {
  return INSTAGRAM_HOSTS.has(new URL(url).hostname);
}
function isInstagramStoryUrl(url) {
  const parsed = new URL(url);
  return (
    INSTAGRAM_HOSTS.has(parsed.hostname) &&
    parsed.pathname.startsWith("/stories/")
  );
}
function extractInstagramStoryOwner(url) {
  const parsed = new URL(url);
  if (!INSTAGRAM_HOSTS.has(parsed.hostname)) return null;
  const match = parsed.pathname.match(/^\/stories\/([^/]+)/);
  return match ? match[1] : null;
}
function isBilibiliUrl(url) {
  return BILIBILI_HOSTS.has(new URL(url).hostname);
}
function isBahamutUrl(url) {
  return BAHAMUT_HOSTS.has(new URL(url).hostname);
}
function isPttUrl(url) {
  return PTT_HOSTS.has(new URL(url).hostname);
}
function isTwitterUrl(url) {
  return TWITTER_HOSTS.has(new URL(url).hostname);
}
function isRedditUrl(url) {
  return REDDIT_HOSTS.has(new URL(url).hostname);
}
function isPixivUrl(url) {
  return PIXIV_HOSTS.has(new URL(url).hostname);
}
function isBlueskyUrl(url) {
  return BLUESKY_HOSTS.has(new URL(url).hostname);
}
function isFacebookUrl(url) {
  return FACEBOOK_HOSTS.has(new URL(url).hostname);
}
function extractBilibiliBvid(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
  return match?.[1] || null;
}

module.exports = {
  THREADS_HOSTS,
  INSTAGRAM_HOSTS,
  BAHAMUT_HOSTS,
  PTT_HOSTS,
  BILIBILI_HOSTS,
  FACEBOOK_HOSTS,
  TWITTER_HOSTS,
  YOUTUBE_HOSTS,
  REDDIT_HOSTS,
  PIXIV_HOSTS,
  BLUESKY_HOSTS,
  SUPPORTED_HOSTS,
  URL_REGEX,
  IGNORE_MARKERS,
  UNIVERSAL_TRACKING_PARAMS,
  HOST_GATED_TRACKING_PARAMS,
  normalizeUrl,
  extractSupportedUrls,
  replaceHostFixer,
  buildFallbackUrl,
  shouldIgnoreMessage,
  isThreadsUrl,
  isInstagramUrl,
  isInstagramStoryUrl,
  extractInstagramStoryOwner,
  isBilibiliUrl,
  isBahamutUrl,
  isPttUrl,
  isTwitterUrl,
  isRedditUrl,
  isPixivUrl,
  isBlueskyUrl,
  isFacebookUrl,
  extractBilibiliBvid,
};
