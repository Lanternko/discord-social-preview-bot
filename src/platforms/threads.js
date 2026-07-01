const {
  FIXER_THREADS,
  FIXER_THREADS_SECONDARY,
  MULTI_IMAGE_PREVIEW_COUNT,
  THREADS_EMBED_COLOR,
} = require("../config");
const { replaceHostFixer } = require("../url-routing");
const { fetchThreadsMetadata } = require("../probe");
const { trimDescription } = require("../utils");
const {
  buildThreadsCompactEmbed,
  buildThreadsMediaEmbed,
  buildThreadsCarouselEmbeds,
} = require("../embeds");

function buildTailHint(hiddenImages, hasVideo) {
  const parts = [];
  if (hiddenImages > 0) parts.push(`還有 ${hiddenImages} 張`);
  if (hasVideo) parts.push("影片");
  if (!parts.length) return null;
  return `... ${parts.join(" + ")}`;
}

function buildThreadsRecoverUrls(url) {
  return [
    replaceHostFixer(url, FIXER_THREADS),
    replaceHostFixer(url, FIXER_THREADS_SECONDARY),
  ];
}

const THREADS_RECOVER_OPTIONS = {
  color: THREADS_EMBED_COLOR,
  footerText: "Threads · 預覽降級",
};

async function buildThreadsPayload(url) {
  try {
    const metadata = await fetchThreadsMetadata(url);

    const hasVideo = Boolean(metadata.video) || metadata.videoCount > 0;
    // text-only requires NO image AND NO video — otherwise a video-only post
    // (no og:image) silently routes to a text embed and never reaches the
    // video fixer chain. Mixed image+video still routes to multi-image branch
    // below.
    const isTextOnly = !metadata.image && !hasVideo;

    if (isTextOnly || metadata.twitterCard === "summary") {
      const logLabel = isTextOnly ? "threads-text-only" : "threads-compact";
      console.log(`[preview] ${logLabel} ${metadata.twitterCard} ${url}`);
      return { embeds: [buildThreadsCompactEmbed(url, metadata)] };
    }

    if (metadata.imageCount > 1) {
      // MIXED (multi-image + video): keep the image gallery AND hand Discord the
      // fixer URL as message content, so it unfurls a *playable* video below the
      // gallery instead of the carousel eating the video as a static poster
      // frame. The pre-rendered carousel is the guaranteed floor — with `embeds`
      // present, discord-io marks the payload not-url-only, so it suppresses
      // immediately and skips the empty-embed delete; the video unfurl is a pure
      // bonus that either renders or silently doesn't. Because the video is now
      // shown for real, the tail hint no longer announces "+ 影片".
      const videoContent = hasVideo
        ? replaceHostFixer(url, FIXER_THREADS)
        : undefined;

      const allImages =
        metadata.images && metadata.images.length > 1
          ? metadata.images.slice(0, 10)
          : null;

      if (allImages) {
        const previewImages = allImages.slice(0, MULTI_IMAGE_PREVIEW_COUNT);
        const hiddenImages = Math.max(
          0,
          (metadata.imageCount || allImages.length) - previewImages.length,
        );
        const tailHint = buildTailHint(hiddenImages, false);
        console.log(
          `[preview] threads-multi-image carousel count=${previewImages.length}/${allImages.length} hasVideo=${Boolean(hasVideo)} videoUnfurl=${Boolean(videoContent)} hint=${tailHint ? `"${tailHint}"` : "none"} ${url}`,
        );
        return {
          ...(videoContent ? { content: videoContent } : {}),
          embeds: buildThreadsCarouselEmbeds(
            url,
            metadata,
            previewImages,
            tailHint,
          ),
        };
      }
      const fallbackEmbed = buildThreadsMediaEmbed(url, metadata);
      const fallbackHint = buildTailHint(
        Math.max(0, (metadata.imageCount || 1) - 1),
        false,
      );
      if (fallbackHint) {
        const existing = fallbackEmbed.data?.description;
        fallbackEmbed.setDescription(
          existing ? `${existing}\n\n${fallbackHint}` : fallbackHint,
        );
      }
      console.log(
        `[preview] threads-multi-image fallback hasVideo=${Boolean(hasVideo)} videoUnfurl=${Boolean(videoContent)} hint=${fallbackHint ? `"${fallbackHint}"` : "none"} ${url}`,
      );
      return {
        ...(videoContent ? { content: videoContent } : {}),
        embeds: [fallbackEmbed],
      };
    }

    if (metadata.video || metadata.videoCount > 0) {
      console.log(`[preview] threads-video fixer ${url}`);
      const videoFallbackEmbed = buildThreadsCompactEmbed(url, metadata);
      if (!metadata.title) {
        videoFallbackEmbed.setTitle("Threads 影片貼文");
      }
      const videoDesc = metadata.description
        ? trimDescription(metadata.description, 3900) +
          "\n\n（影片無法載入，請點連結觀看）"
        : "（影片無法載入，請點連結觀看）";
      videoFallbackEmbed.setDescription(videoDesc);
      return {
        content: replaceHostFixer(url, FIXER_THREADS),
        fallbackContent: replaceHostFixer(url, FIXER_THREADS_SECONDARY),
        embedFallback: { embeds: [videoFallbackEmbed] },
        recoverUrls: buildThreadsRecoverUrls(url),
        recoverEmbedOptions: THREADS_RECOVER_OPTIONS,
        sourceUrl: url,
      };
    }

    if (
      metadata.twitterCard === "summary_large_image" &&
      metadata.image &&
      metadata.imageCount <= 1
    ) {
      console.log(`[preview] threads-single-image ${url}`);
      return { embeds: [buildThreadsMediaEmbed(url, metadata)] };
    }

    console.log(`[preview] threads-generic ${metadata.twitterCard} ${url}`);
    return { embeds: [buildThreadsCompactEmbed(url, metadata)] };
  } catch (error) {
    console.warn(`Could not fetch Threads metadata for ${url}:`, error.message);
  }

  // Probe failure path — still hand back primary + secondary fixer + an OG
  // recovery list so checkAndHandleEmptyEmbeds can render at least a title /
  // description embed if both fixers unfurl empty.
  console.log(`[preview] threads fixer fallback ${url}`);
  return {
    content: replaceHostFixer(url, FIXER_THREADS),
    fallbackContent: replaceHostFixer(url, FIXER_THREADS_SECONDARY),
    recoverUrls: buildThreadsRecoverUrls(url),
    recoverEmbedOptions: THREADS_RECOVER_OPTIONS,
    sourceUrl: url,
  };
}

module.exports = { buildThreadsPayload };
