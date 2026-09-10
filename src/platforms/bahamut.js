const { fetchPageProbeMetadata } = require("../probe");
const { buildBahamutEmbed } = require("../embeds");
const { buildFallbackUrl } = require("../url-routing");

const RESTRICTED_NOTICE = "（內容需登入巴哈姆特才能看完整貼文）";

function hasUsableMetadata(metadata) {
  return Boolean(metadata?.title || metadata?.description);
}

// og:image is whatever the site advertises — for a post built around a YouTube
// embed that's a still thumbnail, and for a post built around a GIF it's
// nothing. The picture the author actually put in the article is the better
// preview (and a GIF keeps animating inside an embed), so it wins when present.
function withArticleMedia(metadata) {
  const articleImage = metadata.images?.[0];
  if (!articleImage) return metadata;
  return { ...metadata, image: articleImage };
}

// A bot-built embed can't hold a player, so the only way to make the article's
// video playable in Discord is to let Discord unfurl the video URL itself:
// send it as message content alongside our embed. Content that isn't unfurled
// still reads as a plain clickable link, so this can't leave the preview worse
// off than the embed alone.
function withVideoContent(payload, metadata) {
  const videoUrl = metadata.videoUrls?.[0];
  if (!videoUrl) return payload;
  console.log(`[preview] bahamut-video ${videoUrl}`);
  return { ...payload, content: videoUrl };
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
    const enriched = withArticleMedia(metadata);
    return withVideoContent(
      { embeds: [buildBahamutEmbed(url, enriched)] },
      metadata,
    );
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
