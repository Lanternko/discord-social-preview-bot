const { FIXER_BILIBILI } = require("../config");
const {
  extractBilibiliBvid,
  normalizeUrl,
  replaceHostFixer,
} = require("../url-routing");

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
  const fallbackUrl = await buildBilibiliFallbackUrl(url);
  console.log(`[preview] bilibili-fixer ${url} -> ${fallbackUrl}`);
  return { content: fallbackUrl };
}

module.exports = {
  fetchBilibiliMetadata,
  buildBilibiliFallbackUrl,
  buildBilibiliPayload,
};
