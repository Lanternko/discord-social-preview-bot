const { fetchPageProbeMetadata } = require("../probe");
const { buildBahamutEmbed } = require("../embeds");
const { buildFallbackUrl } = require("../url-routing");

async function buildBahamutPayload(url) {
  try {
    const metadata = await fetchPageProbeMetadata(url);
    if (metadata.restricted) {
      console.log(`[preview] bahamut-restricted fallback ${url}`);
      return { content: buildFallbackUrl(url) };
    }
    console.log(`[preview] bahamut-custom ${url}`);
    return { embeds: [buildBahamutEmbed(url, metadata)] };
  } catch (error) {
    console.warn(`Could not fetch Bahamut metadata for ${url}:`, error.message);
  }

  console.log(`[preview] bahamut fallback ${url}`);
  return { content: buildFallbackUrl(url) };
}

module.exports = { buildBahamutPayload };
