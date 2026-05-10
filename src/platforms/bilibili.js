const { FIXER_BILIBILI } = require("../config");
const {
  extractBilibiliBvid,
  normalizeUrl,
  replaceHostFixer,
} = require("../url-routing");
const { buildBilibiliEmbed } = require("../embeds");

async function fetchBilibiliMetadata(url) {
  const bvid = extractBilibiliBvid(url);
  if (!bvid) {
    throw new Error("Could not extract Bilibili BVID");
  }

  const response = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.bilibili.com/",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Bilibili API returned ${response.status}`);
  }

  const payload = await response.json();
  if (payload.code !== 0 || !payload.data) {
    throw new Error(`Bilibili API error ${payload.code ?? "unknown"}`);
  }

  return {
    title: payload.data.title || "Bilibili Video",
    description: payload.data.desc || null,
    image: payload.data.pic?.replace(/^http:\/\//i, "https://") || null,
    author: payload.data.owner?.name || null,
  };
}

async function buildBilibiliFallbackUrl(url) {
  const parsed = new URL(url);

  if (parsed.hostname !== "b23.tv") {
    return replaceHostFixer(url, FIXER_BILIBILI);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const finalUrl = normalizeUrl(response.url || url);
    const finalParsed = new URL(finalUrl);
    if (
      finalParsed.hostname === "www.bilibili.com" ||
      finalParsed.hostname === "bilibili.com"
    ) {
      return replaceHostFixer(finalUrl, FIXER_BILIBILI);
    }
  } catch (error) {
    console.warn(
      `Could not expand b23.tv short link for ${url}:`,
      error.message,
    );
  } finally {
    clearTimeout(timeout);
  }

  return replaceHostFixer(url, FIXER_BILIBILI);
}

async function buildBilibiliPayload(url) {
  const fixerUrl = await buildBilibiliFallbackUrl(url);
  // The API path uses BVID directly, so b23.tv short links must be expanded
  // before we can hit it. `buildBilibiliFallbackUrl` already follows the
  // redirect; reuse its expanded URL here.
  const targetUrl =
    new URL(url).hostname === "b23.tv"
      ? fixerUrl.replace(
          new RegExp(`^https?://${FIXER_BILIBILI}`),
          "https://www.bilibili.com",
        )
      : url;

  try {
    const metadata = await fetchBilibiliMetadata(targetUrl);
    if (metadata.title) {
      console.log(
        `[preview] bilibili-api-embed ${url} title=${metadata.title.slice(0, 32)}`,
      );
      return {
        embeds: [buildBilibiliEmbed(url, metadata)],
      };
    }
  } catch (error) {
    console.warn(`[preview] bilibili API failed for ${url}: ${error.message}`);
  }

  console.log(`[preview] bilibili-fixer ${url} -> ${fixerUrl}`);
  return {
    content: fixerUrl,
    recoverUrls: [fixerUrl],
    recoverEmbedOptions: { color: 0x00a1d6, footerText: "Bilibili · 預覽降級" },
    sourceUrl: url,
  };
}

module.exports = {
  fetchBilibiliMetadata,
  buildBilibiliFallbackUrl,
  buildBilibiliPayload,
};
