const { THREADS_VIEWER_HOSTS, MULTI_IMAGE_PREVIEW_COUNT } = require("../config");
const { replaceHostFixer } = require("../url-routing");
const { resolveThreadsUrl } = require("../threads-url");
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

function buildThreadsViewerUrls(url) {
  return THREADS_VIEWER_HOSTS.map((host) => replaceHostFixer(url, host));
}

function buildThreadsLocalFallback(url, metadata = null, video = false) {
  const embed = buildThreadsCompactEmbed(url, {
    title: metadata?.title || (video ? "Threads 影片貼文" : "Threads 貼文"),
    description:
      metadata?.description || "預覽目前無法載入，請點標題前往原始貼文。",
  });
  if (video) {
    const description = metadata?.description
      ? `${trimDescription(metadata.description, 3900)}\n\n（影片無法載入，請點連結觀看）`
      : "（影片無法載入，請點連結觀看）";
    embed.setDescription(description);
  }
  return { embeds: [embed] };
}

async function buildThreadsPayload(url) {
  const canonicalUrl = await resolveThreadsUrl(url);
  const viewerUrls = buildThreadsViewerUrls(canonicalUrl);

  try {
    const metadata = await fetchThreadsMetadata(canonicalUrl);
    const hasVideo = Boolean(metadata.video) || metadata.videoCount > 0;
    const isTextOnly = !metadata.image && !hasVideo;

    if (isTextOnly || metadata.twitterCard === "summary") {
      const logLabel = isTextOnly ? "threads-text-only" : "threads-compact";
      console.log(
        `[preview] ${logLabel} ${metadata.twitterCard} ${canonicalUrl}`,
      );
      return { embeds: [buildThreadsCompactEmbed(canonicalUrl, metadata)] };
    }

    // This order is load-bearing: a mixed multi-image/video post retains its
    // carousel while also attempting the direct video attachment.
    if (metadata.imageCount > 1) {
      const videoAttachment = hasVideo ? metadata.video : undefined;
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
          `[preview] threads-multi-image carousel count=${previewImages.length}/${allImages.length} hasVideo=${Boolean(hasVideo)} videoAttach=${Boolean(videoAttachment)} hint=${tailHint ? `"${tailHint}"` : "none"} ${canonicalUrl}`,
        );
        return {
          ...(videoAttachment ? { videoAttachment } : {}),
          embeds: buildThreadsCarouselEmbeds(
            canonicalUrl,
            metadata,
            previewImages,
            tailHint,
          ),
        };
      }

      const fallbackEmbed = buildThreadsMediaEmbed(canonicalUrl, metadata);
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
        `[preview] threads-multi-image fallback hasVideo=${Boolean(hasVideo)} videoAttach=${Boolean(videoAttachment)} hint=${fallbackHint ? `"${fallbackHint}"` : "none"} ${canonicalUrl}`,
      );
      return {
        ...(videoAttachment ? { videoAttachment } : {}),
        embeds: [fallbackEmbed],
      };
    }

    if (metadata.video || metadata.videoCount > 0) {
      console.log(`[preview] threads-video ${canonicalUrl}`);
      const videoEmbed = buildThreadsCompactEmbed(canonicalUrl, metadata);
      if (!metadata.title) videoEmbed.setTitle("Threads 影片貼文");
      return {
        ...(metadata.video ? { videoAttachment: metadata.video } : {}),
        videoAttachmentEmbeds: [videoEmbed],
        content: viewerUrls[0],
        fallbackContents: viewerUrls.slice(1),
        viewerValidation: "threads",
        embedFallback: buildThreadsLocalFallback(canonicalUrl, metadata, true),
        sourceUrl: canonicalUrl,
      };
    }

    if (
      metadata.twitterCard === "summary_large_image" &&
      metadata.image &&
      metadata.imageCount <= 1
    ) {
      console.log(`[preview] threads-single-image ${canonicalUrl}`);
      return { embeds: [buildThreadsMediaEmbed(canonicalUrl, metadata)] };
    }

    console.log(
      `[preview] threads-generic ${metadata.twitterCard} ${canonicalUrl}`,
    );
    return { embeds: [buildThreadsCompactEmbed(canonicalUrl, metadata)] };
  } catch (error) {
    console.warn(
      `Could not fetch Threads metadata for ${canonicalUrl}:`,
      error.message,
    );
  }

  // Discord unfurls viewer URLs. The bot intentionally never fetches viewer
  // HTML, keeping the SSRF boundary limited to the exact official share URL.
  console.log(`[preview] threads viewer fallback ${canonicalUrl}`);
  return {
    content: viewerUrls[0],
    fallbackContents: viewerUrls.slice(1),
    viewerValidation: "threads",
    embedFallback: buildThreadsLocalFallback(canonicalUrl),
    sourceUrl: canonicalUrl,
  };
}

module.exports = {
  buildThreadsPayload,
  buildThreadsViewerUrls,
  buildThreadsLocalFallback,
};
