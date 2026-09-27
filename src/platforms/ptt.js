const { fetchPageProbeMetadata } = require("../probe");
const { fetchPttMetadataViaHttp } = require("../ptt-fetch");
const { buildPttEmbed } = require("../embeds");
const { buildFallbackUrl } = require("../url-routing");

// 純 fetch 快路徑優先，chromium 第二。快路徑 miss 時回 null（不 throw），probe
// 仍是安全網——它處理不了的只有「PTT 版型大改」這種我們本來就會退回去的狀況。
async function fetchPttMetadata(url) {
  const fast = await fetchPttMetadataViaHttp(url);
  if (fast) return { metadata: fast, source: "http" };
  return { metadata: await fetchPageProbeMetadata(url), source: "probe" };
}

async function buildPttPayload(url) {
  try {
    const { metadata, source } = await fetchPttMetadata(url);
    console.log(`[preview] ptt-custom ${url} source=${source}`);
    return { embeds: [buildPttEmbed(url, metadata)] };
  } catch (error) {
    console.warn(`Could not fetch PTT metadata for ${url}:`, error.message);
  }

  console.log(`[preview] ptt fallback ${url}`);
  return { content: buildFallbackUrl(url) };
}

module.exports = { buildPttPayload };
