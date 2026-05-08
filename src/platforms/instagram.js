const {
  FIXEMBED_BASE_URL,
  FIXER_INSTAGRAM,
  FIXER_INSTAGRAM_SECONDARY,
} = require("../config");
const {
  isInstagramStoryUrl,
  extractInstagramStoryOwner,
  replaceHostFixer,
} = require("../url-routing");
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

  const primaryUrl = replaceHostFixer(url, FIXER_INSTAGRAM);
  const secondaryUrl = replaceHostFixer(url, FIXER_INSTAGRAM_SECONDARY);
  console.log(`[preview] instagram-fixer ${url}`);
  return {
    content: primaryUrl,
    fallbackContent: secondaryUrl,
    embedFallback: {
      content: `${FIXEMBED_BASE_URL}${encodeURIComponent(url)}`,
    },
    recoverUrls: [primaryUrl, secondaryUrl],
    recoverEmbedOptions: { color: 0xe1306c, footerText: "Instagram · 預覽降級" },
    sourceUrl: url,
  };
}

module.exports = { buildInstagramPayload, fetchInstagramDisplayName };
