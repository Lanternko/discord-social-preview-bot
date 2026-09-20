const { PIXIV_MAX_IMAGES, FIXER_PIXIV } = require("../config");

const PIXIV_LOOKUP_TIMEOUT_MS = 5000;
// phixiv only emits the og tags for a crawler.
const DISCORDBOT_UA =
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// pixiv's own CDN refuses any request without a pixiv referer, so Discord
// can't render an i.pximg.net URL — phixiv re-serves the same path, and that
// proxy is what both the gallery embeds and the spoiler download point at.
function toPhixivProxyUrl(pximgUrl) {
  return String(pximgUrl).replace(
    /^https:\/\/i\.pximg\.net\//,
    "https://www.phixiv.net/i/",
  );
}

// Page N of a multi-page work: the path is the first page's with _p0_ swapped.
function pageUrl(firstPageUrl, index) {
  return firstPageUrl.replace(/_p0_/, `_p${index}_`);
}

// What pixiv's own ajax endpoint knows about a work. phixiv's unfurl only ever
// shows page 1 and says nothing about R-18, and its API was retired with a
// message pointing here. No key or login needed. Null when unknown; never
// throws.
async function fetchPixivMeta(url) {
  const illustId = new URL(url).pathname.match(/\/artworks\/(\d+)/)?.[1];
  if (!illustId) return null;
  try {
    const response = await fetch(
      `https://www.pixiv.net/ajax/illust/${illustId}`,
      {
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(PIXIV_LOOKUP_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const body = (await response.json())?.body;
    if (!body) return null;
    const pageCount = body.pageCount || 1;
    // pixiv nulls out every image URL of an R-18 work for logged-out callers.
    // phixiv serves them anyway, so its unfurl is where page 1 comes from.
    const firstProxied = body.urls?.regular
      ? toPhixivProxyUrl(body.urls.regular)
      : await fetchPhixivFirstPageUrl(illustId);
    if (!firstProxied) return null;
    return {
      illustId,
      title: body.title || "",
      author: body.userName || "",
      pageCount,
      // xRestrict: 1 = R-18, 2 = R-18G.
      sensitive: (body.xRestrict ?? 0) > 0,
      images: Array.from(
        { length: Math.min(pageCount, PIXIV_MAX_IMAGES) },
        (_, index) => pageUrl(firstProxied, index),
      ),
    };
  } catch (error) {
    console.warn(`[pixiv] lookup failed ${illustId}: ${error.message}`);
    return null;
  }
}

async function fetchPhixivFirstPageUrl(illustId) {
  try {
    const response = await fetch(
      `https://${FIXER_PIXIV}/artworks/${illustId}`,
      {
        headers: { "User-Agent": DISCORDBOT_UA },
        signal: AbortSignal.timeout(PIXIV_LOOKUP_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const html = await response.text();
    return (
      html.match(/property="og:image"\s+content="([^"]+)"/)?.[1] ||
      html.match(/content="([^"]+)"\s+property="og:image"/)?.[1] ||
      null
    );
  } catch (error) {
    console.warn(`[pixiv] phixiv lookup failed ${illustId}: ${error.message}`);
    return null;
  }
}

module.exports = { fetchPixivMeta, toPhixivProxyUrl };
