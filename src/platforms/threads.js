const { FIXER_THREADS, FIXER_THREADS_SECONDARY } = require("../config");
const { replaceHostFixer, buildFallbackUrl } = require("../url-routing");
const { fetchThreadsMetadata } = require("../probe");
const { trimDescription } = require("../utils");
const {
  buildThreadsCompactEmbed,
  buildThreadsMediaEmbed,
  buildThreadsLinkRow,
  buildThreadsCarouselEmbeds,
} = require("../embeds");

async function buildThreadsPayload(url) {
  try {
    const metadata = await fetchThreadsMetadata(url);

    const isTextOnly = !metadata.image;

    if (isTextOnly || metadata.twitterCard === "summary") {
      const logLabel = isTextOnly ? "threads-text-only" : "threads-compact";
      console.log(`[preview] ${logLabel} ${metadata.twitterCard} ${url}`);
      return { embeds: [buildThreadsCompactEmbed(url, metadata)] };
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

    if (metadata.imageCount > 1) {
      const allImages =
        metadata.images && metadata.images.length > 1
          ? metadata.images.slice(0, 10)
          : null;

      if (allImages) {
        console.log(
          `[preview] threads-multi-image carousel count=${allImages.length} ${url}`,
        );
        return {
          embeds: buildThreadsCarouselEmbeds(url, metadata, allImages),
        };
      }
      console.log(`[preview] threads-multi-image fallback ${url}`);
      return {
        embeds: [buildThreadsMediaEmbed(url, metadata)],
        components: [buildThreadsLinkRow(url)],
      };
    }

    console.log(`[preview] threads-generic ${metadata.twitterCard} ${url}`);
    return { embeds: [buildThreadsCompactEmbed(url, metadata)] };
  } catch (error) {
    console.warn(`Could not fetch Threads metadata for ${url}:`, error.message);
  }

  console.log(`[preview] threads fixer fallback ${url}`);
  return { content: buildFallbackUrl(url) };
}

module.exports = { buildThreadsPayload };
