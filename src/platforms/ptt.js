const { fetchPageProbeMetadata } = require("../probe");
const { buildPttEmbed } = require("../embeds");
const { buildFallbackUrl } = require("../url-routing");

async function buildPttPayload(url) {
  try {
    const metadata = await fetchPageProbeMetadata(url);
    console.log(`[preview] ptt-custom ${url}`);
    return { embeds: [buildPttEmbed(url, metadata)] };
  } catch (error) {
    console.warn(`Could not fetch PTT metadata for ${url}:`, error.message);
  }

  console.log(`[preview] ptt fallback ${url}`);
  return { content: buildFallbackUrl(url) };
}

module.exports = { buildPttPayload };
