const { EmbedBuilder } = require("discord.js");
const { INSTAGRAM_VIEWER_HOSTS } = require("../config");
const {
  isInstagramStoryUrl,
  extractInstagramStoryOwner,
  replaceHostFixer,
} = require("../url-routing");
const { resolveInstagramUrl } = require("../instagram-url");
const { fetchPageProbeMetadata } = require("../probe");

// og:title is typically "DisplayName (@username) • Instagram…"
async function fetchInstagramDisplayName(username) {
  const profileUrl = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  try {
    const metadata = await fetchPageProbeMetadata(profileUrl);
    if (metadata.title) {
      const match = metadata.title.match(/^(.+?)\s*[（(]@/);
      if (match) return match[1].trim();
    }
  } catch (error) {
    console.warn(
      `[preview] could not fetch Instagram display name for ${username}:`,
      error.message,
    );
  }
  return null;
}

async function buildInstagramPayload(url) {
  if (isInstagramStoryUrl(url)) {
    const storyOwner = extractInstagramStoryOwner(url);
    if (storyOwner) {
      const displayName = await fetchInstagramDisplayName(storyOwner);
      const ownerLabel = displayName
        ? `${displayName}（@${storyOwner}）`
        : `@${storyOwner}`;
      console.log(
        `[preview] instagram-story owner=${storyOwner} displayName=${displayName ?? "n/a"} ${url}`,
      );
      return { content: `這是 **${ownerLabel}** 的限動！` };
    }
    console.log(`[preview] instagram-story unknown-owner ${url}`);
    return {
      content: "這是 Instagram 限動（但我抓不到是誰發的…抱歉）",
    };
  }

  const canonicalUrl = resolveInstagramUrl(url);
  const viewerUrls = INSTAGRAM_VIEWER_HOSTS.map((host) =>
    replaceHostFixer(canonicalUrl, host),
  );
  const localFallback = new EmbedBuilder()
    .setColor(0xe1306c)
    .setTitle("Instagram 貼文")
    .setURL(canonicalUrl)
    .setDescription("預覽目前無法載入，請點標題前往原始貼文。");
  console.log(`[preview] instagram-viewer ${canonicalUrl}`);
  return {
    content: viewerUrls[0],
    fallbackContents: viewerUrls.slice(1),
    viewerValidation: "instagram",
    embedFallback: { embeds: [localFallback] },
    sourceUrl: canonicalUrl,
  };
}

module.exports = { buildInstagramPayload, fetchInstagramDisplayName };
