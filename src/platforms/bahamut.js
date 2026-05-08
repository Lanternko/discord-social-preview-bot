const { fetchPageProbeMetadata } = require("../probe");
const { buildBahamutEmbed } = require("../embeds");
const { buildFallbackUrl } = require("../url-routing");

const RESTRICTED_NOTICE = "（內容需登入巴哈姆特才能看完整貼文）";

function hasUsableMetadata(metadata) {
  return Boolean(metadata?.title || metadata?.description);
}

async function buildBahamutPayload(url) {
  try {
    const metadata = await fetchPageProbeMetadata(url);
    if (metadata.restricted) {
      // Even a restricted page often returns a public title / og:description
      // that's enough to let the user decide whether to log in. Surface that
      // instead of dropping straight to a fixer URL.
      if (hasUsableMetadata(metadata)) {
        const noticed = {
          ...metadata,
          description: metadata.description
            ? `${metadata.description}\n\n${RESTRICTED_NOTICE}`
            : RESTRICTED_NOTICE,
        };
        console.log(`[preview] bahamut-restricted-summary ${url}`);
        return { embeds: [buildBahamutEmbed(url, noticed)] };
      }
      console.log(`[preview] bahamut-restricted fallback ${url}`);
      return { content: buildFallbackUrl(url), sourceUrl: url };
    }
    console.log(`[preview] bahamut-custom ${url}`);
    return { embeds: [buildBahamutEmbed(url, metadata)] };
  } catch (error) {
    console.warn(`Could not fetch Bahamut metadata for ${url}:`, error.message);
  }

  console.log(`[preview] bahamut fallback ${url}`);
  return {
    content: buildFallbackUrl(url),
    sourceUrl: url,
    recoverUrls: [buildFallbackUrl(url), url],
    recoverEmbedOptions: { color: 0xf08c2e, footerText: "巴哈姆特 · 預覽降級" },
  };
}

module.exports = { buildBahamutPayload };
