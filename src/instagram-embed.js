// Instagram's own /embed/captioned/ page — the one blogs iframe — answers our
// host without a login wall. Carousels carry the post as JSON (`contextJSON`):
// owner, caption, and every slide with its sized image URLs. Single photos
// ship `"contextJSON":null` and only the server-rendered markup, so those are
// read from the static HTML (EmbeddedMediaImage srcset, header, Caption div);
// video posts render EmbedBrokenMedia there and fall through to null. That is
// what lets the bot build its own full-resolution gallery. The viewers can't:
// deinstagram's unfurl mosaics a carousel into one 720×360 tile (two photos
// side by side at ~360px wide each), the others show only the first slide.
//
// Returns null on any miss (network, non-200, page shape changed, missing
// media) — the caller keeps the viewer chain. Never throws.

// Measured 0.30–0.73 s across live fetches (2026-11-17). Past 2 s IG is
// struggling, and every extra second is a second the user waits before the
// viewer chain even starts.
const EMBED_TIMEOUT_MS = 2000;
const MAX_HTML_BYTES = 2_000_000;
// Discord renders gallery tiles at ~550px; the 1080px rendition is plenty and
// a fraction of the original's size (a 3071×4096 slide is ~1.6 MB).
const PREFERRED_IMAGE_WIDTH = 1080;
// Deliberately bare: a full desktop-Chrome UA is served the client-rendered
// shell (no contextJSON at all); the bare token gets the server-rendered page
// with the post JSON inline (2026-11-17).
const USER_AGENT = "Mozilla/5.0";

const { decodeHtmlEntities } = require("./og-fallback");

function buildEmbedPageUrl(shortcode) {
  return `https://www.instagram.com/p/${encodeURIComponent(shortcode)}/embed/captioned/`;
}

// display_resources lists the uncropped renditions first (largest first),
// then the square crops — so the first one at or under the preferred width is
// the uncropped 1080px version.
function pickImageUrl(node) {
  const resources = Array.isArray(node?.display_resources)
    ? node.display_resources
    : [];
  const sized = resources.find(
    (r) => r?.src && Number(r.config_width) <= PREFERRED_IMAGE_WIDTH,
  );
  return sized?.src || node?.display_url || null;
}

function toItem(node) {
  return { isVideo: Boolean(node?.is_video), image: pickImageUrl(node) };
}

function extractContextJson(html) {
  const match = html.match(/"contextJSON":("(?:[^"\\]|\\.)*")/);
  if (!match) return null;
  try {
    return JSON.parse(JSON.parse(match[1]));
  } catch {
    return null;
  }
}

// srcset lists the uncropped renditions first (original, then 1080, 720…),
// then the cropped ones — same ordering rule as display_resources.
function pickSrcsetUrl(srcset) {
  const entries = String(srcset || "")
    .split(",")
    .map((part) => part.trim().match(/^(\S+)\s+(\d+)w$/))
    .filter(Boolean)
    .map((m) => ({ src: decodeHtmlEntities(m[1]), width: Number(m[2]) }));
  return entries.find((e) => e.width <= PREFERRED_IMAGE_WIDTH)?.src || null;
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`));
  return match ? decodeHtmlEntities(match[1]) : null;
}

function captionFromHtml(html) {
  const start = html.indexOf('<div class="Caption">');
  if (start < 0) return null;
  const end = html.indexOf('<div class="CaptionComments">', start);
  if (end < 0) return null;
  const text = decodeHtmlEntities(
    html
      .slice(start + '<div class="Caption">'.length, end)
      .replace(/<a class="CaptionUsername"[^>]*>[\s\S]*?<\/a>/, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/\u00a0/g, " ")
    .trim();
  return text || null;
}

// Single-photo posts: no JSON, only markup. Refuses anything that could be a
// partial picture — a sidecar (would show one of N slides) or a video (the
// page shows EmbedBrokenMedia, and a still would hide that it plays).
function parseStaticPhoto(html) {
  if (/"isSidecar":true/.test(html)) return null;
  if (html.includes("EmbedBrokenMedia")) return null;
  const imgTag = html.match(/<img class="EmbeddedMediaImage"[^>]*>/)?.[0];
  if (!imgTag) return null;
  const image = pickSrcsetUrl(attr(imgTag, "srcset")) || attr(imgTag, "src");
  if (!image) return null;

  const username =
    html.match(/class="UsernameText">([^<]+)</)?.[1]?.trim() ||
    attr(imgTag, "alt")?.match(/@([\w.]+)/)?.[1] ||
    null;
  const avatarTag = html
    .match(/<a class="Avatar"[^>]*>\s*(<img[^>]*>)/)?.[1];
  return {
    shortcode: null,
    username: username ? decodeHtmlEntities(username) : null,
    fullName: null,
    avatar: avatarTag ? attr(avatarTag, "src") : null,
    caption: captionFromHtml(html),
    items: [{ isVideo: false, image }],
  };
}

// Pure: embed-page HTML → post metadata, or null when the page doesn't hold a
// post (removed / private posts serve the page without gql_data).
function parseInstagramEmbedHtml(html) {
  if (typeof html !== "string") return null;
  const media = extractContextJson(html)?.gql_data?.shortcode_media;
  if (!media || typeof media !== "object") return parseStaticPhoto(html);

  const children = media.edge_sidecar_to_children?.edges;
  const items = Array.isArray(children)
    ? children.map((edge) => toItem(edge?.node))
    : [toItem(media)];
  if (items.length === 0) return null;

  const caption = media.edge_media_to_caption?.edges?.[0]?.node?.text;
  return {
    shortcode: media.shortcode || null,
    username: media.owner?.username || null,
    fullName: media.owner?.full_name || null,
    avatar: media.owner?.profile_pic_url || null,
    caption: typeof caption === "string" && caption.trim() ? caption.trim() : null,
    items,
  };
}

async function fetchEmbedHtml(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchInstagramPostMeta(
  shortcode,
  { timeoutMs = EMBED_TIMEOUT_MS } = {},
) {
  if (!shortcode) return null;
  try {
    const html = await fetchEmbedHtml(buildEmbedPageUrl(shortcode), timeoutMs);
    const meta = parseInstagramEmbedHtml(html);
    if (!meta) console.log(`[instagram] embed page has no post data ${shortcode}`);
    return meta;
  } catch (error) {
    console.log(`[instagram] embed page fetch failed ${shortcode}: ${error.message}`);
    return null;
  }
}

module.exports = {
  fetchInstagramPostMeta,
  parseInstagramEmbedHtml,
  buildEmbedPageUrl,
};
