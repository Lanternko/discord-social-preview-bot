const { THREADS_VIEWER_HOSTS, MULTI_IMAGE_PREVIEW_COUNT } = require("../config");
const { replaceHostFixer } = require("../url-routing");
const { resolveThreadsUrl } = require("../threads-url");
const { fetchThreadsMetadata } = require("../probe");
const { trimDescription } = require("../utils");
// Module reference (not destructured) so the smoke tests can stub the fetch.
const ogFallback = require("../og-fallback");
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

// A shared Threads link often points at a reply, and Threads' og:description
// then carries the punchline alone — the post being answered never reaches the
// preview, so the reply reads as a non-sequitur. The probe hands back the
// ancestor chain; render it as a quote above the reply.
const MAX_QUOTED_ANCESTORS = 2;
const ANCESTOR_TEXT_LIMIT = 500;

function quoteAncestor(ancestor) {
  const header = ancestor.author ? `**@${ancestor.author}**` : "**原貼文**";
  const body = ancestor.text
    ? trimDescription(ancestor.text, ANCESTOR_TEXT_LIMIT)
    : "（無文字內容）";
  return [header, ...body.split("\n")].map((line) => `> ${line}`).join("\n");
}

function buildReplyDescription(metadata) {
  const ancestors = (metadata.ancestors || []).filter(
    (ancestor) => ancestor && (ancestor.text || ancestor.author),
  );
  if (!ancestors.length) return null;

  // A deep chain would bury the reply itself, so keep the root (what the
  // thread is about) and the direct parent (what the reply answers).
  const quoted =
    ancestors.length > MAX_QUOTED_ANCESTORS
      ? [ancestors[0], ancestors[ancestors.length - 1]]
      : ancestors;
  const skipped = ancestors.length - quoted.length;

  const blocks = [];
  quoted.forEach((ancestor, index) => {
    blocks.push(quoteAncestor(ancestor));
    if (index === 0 && skipped > 0) {
      blocks.push(`> ⋯（中間還有 ${skipped} 則）`);
    }
  });

  const ownText = metadata.description || metadata.postText;
  blocks.push(ownText ? `↳ ${ownText}` : "↳ （這則回覆沒有文字）");
  return blocks.join("\n\n");
}

function withReplyContext(metadata) {
  const description = buildReplyDescription(metadata);
  if (!description) return metadata;
  return { ...metadata, description };
}

function buildThreadsViewerUrls(url) {
  return THREADS_VIEWER_HOSTS.map((host) => replaceHostFixer(url, host));
}

const WALLED_DESCRIPTION =
  "Threads 不讓未登入的人看這篇，所以抓不到內容——可能是作者限定了觀看對象、被標成敏感內容，或已經刪除。請點標題登入 Threads 觀看。";
const GENERIC_DESCRIPTION = "預覽目前無法載入，請點標題前往原始貼文。";

// The canonical permalink is /@user/post/ID, so the author survives even when
// every fetch came back empty — the card should at least say whose post it is.
function threadsAuthorFromUrl(url) {
  try {
    const match = new URL(url).pathname.match(/^\/@([^/]+)\/post\//);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

// A walled post's author page is usually still public, so its og:image gives
// the fallback card a face. Only ever fetched on the already-failed path, on
// the official host, for a username that passed a strict charset check.
const AVATAR_TIMEOUT_MS = 3000;
const AVATAR_CACHE_TTL_MS = 60 * 60 * 1000;
const AVATAR_CACHE_MAX = 200;
const AVATAR_HOST_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
const avatarCache = new Map();

function isSafeAvatarUrl(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    return parsed.protocol === "https:" && AVATAR_HOST_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

async function fetchThreadsAvatar(author) {
  if (!author || !/^[A-Za-z0-9._]{1,64}$/.test(author)) return null;
  const cached = avatarCache.get(author);
  if (cached && Date.now() - cached.at < AVATAR_CACHE_TTL_MS) {
    return cached.url;
  }

  let avatarUrl = null;
  try {
    const meta = await ogFallback.fetchOgMetadata(
      `https://www.threads.com/@${author}`,
      { timeoutMs: AVATAR_TIMEOUT_MS },
    );
    avatarUrl = isSafeAvatarUrl(meta?.image) ? meta.image : null;
  } catch (error) {
    console.log(`[preview] threads avatar miss @${author}: ${error.message}`);
  }

  if (avatarCache.size >= AVATAR_CACHE_MAX) {
    avatarCache.delete(avatarCache.keys().next().value);
  }
  avatarCache.set(author, { url: avatarUrl, at: Date.now() });
  return avatarUrl;
}

function buildThreadsLocalFallback(
  url,
  metadata = null,
  video = false,
  { walled = false, avatarUrl = null } = {},
) {
  const author = threadsAuthorFromUrl(url);
  const kind = video ? "Threads 影片貼文" : "Threads 貼文";
  const embed = buildThreadsCompactEmbed(url, {
    title: metadata?.title || (author ? `@${author} 的 ${kind}` : kind),
    description:
      metadata?.description ||
      (walled ? WALLED_DESCRIPTION : GENERIC_DESCRIPTION),
  });
  if (author) {
    embed.setAuthor({
      name: `@${author}`,
      url: `https://www.threads.com/@${encodeURIComponent(author)}`,
      ...(avatarUrl ? { iconURL: avatarUrl } : {}),
    });
    if (avatarUrl) embed.setThumbnail(avatarUrl);
  }
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
  let walled = false;

  try {
    const rawMetadata = await fetchThreadsMetadata(canonicalUrl);
    const metadata = withReplyContext(rawMetadata);
    if (metadata !== rawMetadata) {
      console.log(
        `[preview] threads-reply-context ancestors=${rawMetadata.ancestors.length} ${canonicalUrl}`,
      );
    }
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
    walled = Boolean(error.walled);
  }

  // Discord unfurls viewer URLs. The bot intentionally never fetches viewer
  // HTML, keeping the SSRF boundary on the official host (share URL + the
  // author's profile page for the avatar).
  const avatarUrl = await fetchThreadsAvatar(threadsAuthorFromUrl(canonicalUrl));
  console.log(
    `[preview] threads viewer fallback walled=${walled} avatar=${Boolean(avatarUrl)} ${canonicalUrl}`,
  );
  return {
    content: viewerUrls[0],
    fallbackContents: viewerUrls.slice(1),
    viewerValidation: "threads",
    embedFallback: buildThreadsLocalFallback(canonicalUrl, null, false, {
      walled,
      avatarUrl,
    }),
    sourceUrl: canonicalUrl,
  };
}

module.exports = {
  buildThreadsPayload,
  buildReplyDescription,
  buildThreadsViewerUrls,
  buildThreadsLocalFallback,
  threadsAuthorFromUrl,
  resetThreadsAvatarCacheForTests: () => avatarCache.clear(),
};
