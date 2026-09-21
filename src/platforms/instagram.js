const { EmbedBuilder } = require("discord.js");
const {
  INSTAGRAM_VIEWER_HOSTS,
  INSTAGRAM_OG_RECOVERY_HOSTS,
} = require("../config");
const {
  isInstagramStoryUrl,
  extractInstagramStoryOwner,
  replaceHostFixer,
} = require("../url-routing");
const { resolveInstagramUrl } = require("../instagram-url");
const { fetchPageProbeMetadata } = require("../probe");
const { isViewerArtworkUrl } = require("../viewer-cards");

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

// Instagram's own og:title is either
//   "波波在 Instagram: \"<caption>\""  or  "Name (@user) • Instagram photos and videos"
// — the caption is already the description, so keep just who posted it and
// pair it with the @handle from og:url when we have one.
function extractInstagramUsername(meta) {
  const candidate = meta?.url || meta?.author;
  if (typeof candidate !== "string") return null;
  const match = candidate.match(
    /instagram\.com\/([A-Za-z0-9._]+)(?:\/(?:p|reel|reels|tv)\/|\/?$)/i,
  );
  if (!match) return null;
  const username = match[1];
  return /^(?:p|reel|reels|tv|stories|explore)$/i.test(username)
    ? null
    : username;
}

function cleanInstagramTitle(title, meta) {
  if (!title) return title;
  const name = title
    .replace(/\s*(?:在|on)\s*Instagram\s*[::][\s\S]*$/i, "")
    .replace(/\s*[•·|]\s*Instagram\b[\s\S]*$/i, "")
    .trim();
  if (!name || /^instagram$/i.test(name)) return null;
  const username = extractInstagramUsername(meta);
  return username && !name.includes(`@${username}`)
    ? `${name}（@${username}）`
    : name;
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
    // Last-ditch metadata sources we fetch ourselves. The canonical
    // instagram.com URL is in the list on purpose: with a Discordbot UA the
    // origin still serves og:image (the real cover) and twitter:title
    // ("Name (@user) • Instagram photos and videos"), which outlives any
    // third-party viewer going down.
    recoverUrls: [
      ...INSTAGRAM_OG_RECOVERY_HOSTS.map((host) =>
        replaceHostFixer(canonicalUrl, host),
      ),
      canonicalUrl,
    ],
    recoverEmbedOptions: {
      color: 0xe1306c,
      titleTransform: cleanInstagramTitle,
    },
    // Fetch every recovery host at once and keep the richest answer (not the
    // fastest — the fastest is usually the cover-less one), and demand a
    // cover: an Instagram post without one means the host answered with its
    // own error/landing page.
    recoverStrategy: {
      collect: true,
      timeoutMs: 5000,
      // instagram7 keeps the caption but answers photo posts with the
      // Instagram glyph as og:image — drop that so it can't pass as a cover
      // (and so the merge takes the real cover from another host).
      normalizeMeta: (meta) =>
        meta.image && isViewerArtworkUrl(meta.image)
          ? { ...meta, image: null }
          : meta,
      // A host with neither a cover nor a caption only served its landing page.
      validateMeta: (meta) => Boolean(meta.image || meta.description),
    },
    placeholderFallback: { embeds: [localFallback] },
    sourceUrl: canonicalUrl,
  };
}

module.exports = {
  buildInstagramPayload,
  fetchInstagramDisplayName,
  cleanInstagramTitle,
  extractInstagramUsername,
};
