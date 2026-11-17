// Instagram's own /embed/captioned/ page — the one blogs iframe — answers our
// host without a login wall and carries the post as JSON (`contextJSON`):
// owner, caption, and every carousel slide with its sized image URLs. That is
// what lets the bot build its own full-resolution gallery. The viewers can't:
// deinstagram's unfurl mosaics a carousel into one 720×360 tile (two photos
// side by side at ~360px wide each), the others show only the first slide.
//
// Returns null on any miss (network, non-200, page shape changed, missing
// media) — the caller keeps the viewer chain. Never throws.

const EMBED_TIMEOUT_MS = 4000;
const MAX_HTML_BYTES = 2_000_000;
// Discord renders gallery tiles at ~550px; the 1080px rendition is plenty and
// a fraction of the original's size (a 3071×4096 slide is ~1.6 MB).
const PREFERRED_IMAGE_WIDTH = 1080;
// Deliberately bare: a full desktop-Chrome UA is served the client-rendered
// shell (no contextJSON at all); the bare token gets the server-rendered page
// with the post JSON inline (2026-11-17).
const USER_AGENT = "Mozilla/5.0";

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

// Pure: embed-page HTML → post metadata, or null when the page doesn't hold a
// post (removed / private posts serve the page without gql_data).
function parseInstagramEmbedHtml(html) {
  if (typeof html !== "string") return null;
  const media = extractContextJson(html)?.gql_data?.shortcode_media;
  if (!media || typeof media !== "object") return null;

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
