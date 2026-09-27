const {
  isThreadsUrl,
  isInstagramUrl,
  isBilibiliUrl,
  isBahamutUrl,
  isPttUrl,
  isPinterestUrl,
  isTwitterUrl,
  isRedditUrl,
  isPixivUrl,
  isBlueskyUrl,
  isFacebookUrl,
  buildFallbackUrl,
  replaceHostFixer,
} = require("./url-routing");
const { FIXER_TWITTER_SECONDARY, R18_SPOILER_ENABLED } = require("./config");
const { buildBahamutPayload } = require("./platforms/bahamut");
const { buildPttPayload } = require("./platforms/ptt");
const { buildPinterestPayload } = require("./platforms/pinterest");
const { buildInstagramPayload } = require("./platforms/instagram");
const { fetchTweetMeta } = require("./platforms/twitter");
const { isPanoramaCandidate } = require("./panorama");
const {
  buildTwitterSpoilerEmbed,
  buildTwitterCarouselEmbeds,
  buildPixivSpoilerEmbed,
  buildPixivCarouselEmbeds,
} = require("./embeds");
const { fetchPixivMeta, fetchPixivPageSizes } = require("./platforms/pixiv");
const { buildBilibiliPayload } = require("./platforms/bilibili");
const { buildThreadsPayload } = require("./platforms/threads");

// Per-host visual cues for the OG-recovery embed. Helps users recognise the
// platform when the bot has to fall back to a meta-only embed.
const RECOVER_PROFILES = {
  twitter: { color: 0x1da1f2, footerText: "X (Twitter) · 預覽降級" },
  reddit: { color: 0xff4500, footerText: "Reddit · 預覽降級" },
  pixiv: { color: 0x0096fa, footerText: "Pixiv · 預覽降級" },
  bluesky: { color: 0x0085ff, footerText: "Bluesky · 預覽降級" },
  facebook: { color: 0x1877f2, footerText: "Facebook · 預覽降級" },
  generic: { color: 0x2b2d31, footerText: "預覽降級" },
};

function buildSimpleFixerPayload(url, recoverProfile) {
  const fixerUrl = buildFallbackUrl(url);
  return {
    content: fixerUrl,
    recoverUrls: [fixerUrl],
    recoverEmbedOptions: recoverProfile,
    sourceUrl: url,
  };
}

// facebed has no cache — every request re-scrapes Facebook live, so it takes
// 2-5s and sometimes blows past the default 6s. Give OG recovery more room and
// race facebed against facebook.com itself (which serves real OG tags to its
// own crawler UA), so either one being slow or down doesn't kill the preview.
const FACEBOOK_RECOVER_TIMEOUT_MS = 15000;
const FACEBOOK_CRAWLER_USER_AGENT = "facebookexternalhit/1.1";

function buildFacebookPayload(url) {
  const payload = buildSimpleFixerPayload(url, RECOVER_PROFILES.facebook);
  return {
    ...payload,
    recoverUrls: [
      ...payload.recoverUrls,
      { url, userAgent: FACEBOOK_CRAWLER_USER_AGENT, requireOgUrl: true },
    ],
    recoverStrategy: { race: true, timeoutMs: FACEBOOK_RECOVER_TIMEOUT_MS },
  };
}

// fxtwitter intermittently unfurls a post as a "This post is unavailable"
// stub (seen on sensitive posts). The stub has a title + description, so it
// passes the generic non-empty check and would sit there as the preview —
// validate it as useless and retry on a second fixer. The secondary also leads
// OG recovery, since the primary's stub would otherwise be "recovered" as-is.
// It also strips the media off some image posts; the media lookup (started now,
// awaited only at the embed check, seconds later) lets validation catch that.
async function buildTwitterPayload(url) {
  const meta = await fetchTweetMeta(url);
  const secondaryUrl = replaceHostFixer(url, FIXER_TWITTER_SECONDARY);
  if (R18_SPOILER_ENABLED && meta?.sensitive && meta.photos.length > 0) {
    return buildSensitiveTwitterPayload(url, meta, secondaryUrl);
  }
  // Multi-image posts only: a single image already unfurls fine through the
  // fixer, and a post with video keeps the fixer's playable player.
  if (meta && !meta.hasNonPhotoMedia && meta.photos.length > 1) {
    return buildTwitterCarouselPayload(url, meta);
  }
  const payload = buildSimpleFixerPayload(url, RECOVER_PROFILES.twitter);
  return {
    ...payload,
    fallbackContents: [secondaryUrl],
    viewerValidation: "twitter",
    viewerRequiresMedia: meta ? meta.hasMedia : null,
    recoverUrls: [secondaryUrl, ...payload.recoverUrls],
  };
}

// A sensitive post never goes out as a fixer link: the viewers unfurl the
// image in the clear. The bot builds the card itself and uploads every image
// as a spoilered attachment (all of them — a fixer unfurl only ever shows the
// first, or one mosaic of it). If the upload can't happen, the link goes out
// wrapped in spoiler bars so Discord blurs its own unfurl instead.
function buildSensitiveTwitterPayload(url, meta, secondaryUrl) {
  const hint =
    meta.photoCount > meta.photos.length
      ? `\n-# 還有 ${meta.photoCount - meta.photos.length} 張`
      : "";
  console.log(
    `[twitter] sensitive → spoiler card images=${meta.photos.length}/${meta.photoCount} ${url}`,
  );
  return {
    embeds: [buildTwitterSpoilerEmbed(url, meta)],
    spoilerImages: meta.photos,
    spoilerContent: hint ? hint.trimStart() : null,
    spoilerMissContent: `🔞 ||${secondaryUrl}||`,
    sourceUrl: url,
  };
}

// Every photo of a multi-image post, as the bot's own gallery. Nothing is
// downloaded — the embeds point Discord at the images. Equal-size slices may be
// one wide picture split up (Discord's 2x2 album would break it apart), so they
// also carry `panoramaImages`: discord-io stitches them if the seams line up,
// and keeps this gallery otherwise.
function buildTwitterCarouselPayload(url, meta) {
  const panorama =
    meta.photoCount === meta.photos.length &&
    isPanoramaCandidate(meta.photoSizes);
  console.log(
    `[twitter] carousel images=${meta.photos.length}/${meta.photoCount}${panorama ? " panorama?" : ""} ${url}`,
  );
  return {
    embeds: buildTwitterCarouselEmbeds(url, meta),
    ...(panorama ? { panoramaImages: meta.photos } : {}),
    sourceUrl: url,
  };
}

// phixiv unfurls page 1 of a work and nothing else — no other pages, no R-18
// signal. With pixiv's own metadata the bot can do both: hide an R-18 work
// behind spoilered attachments, and show a multi-page work as a gallery.
// Single-page all-ages works keep the phixiv unfurl, which is already right.
async function buildPixivPayload(url) {
  const meta = await fetchPixivMeta(url);
  const payload = buildSimpleFixerPayload(url, RECOVER_PROFILES.pixiv);
  if (!meta) return payload;
  if (R18_SPOILER_ENABLED && meta.sensitive) {
    console.log(
      `[pixiv] R18 → spoiler card images=${meta.images.length}/${meta.pageCount} ${url}`,
    );
    return {
      embeds: [buildPixivSpoilerEmbed(url, meta)],
      spoilerImages: meta.images,
      spoilerContent:
        meta.pageCount > meta.images.length
          ? `還有 ${meta.pageCount - meta.images.length} 張`
          : null,
      spoilerMissContent: `🔞 ||${payload.content}||`,
      sourceUrl: url,
    };
  }
  if (meta.images.length > 1) {
    const panorama = await isPixivPanoramaCandidate(meta);
    console.log(
      `[pixiv] gallery images=${meta.images.length}/${meta.pageCount}${panorama ? " panorama?" : ""} ${url}`,
    );
    return {
      embeds: buildPixivCarouselEmbeds(url, meta),
      ...(panorama ? { panoramaImages: meta.images } : {}),
      sourceUrl: url,
    };
  }
  return payload;
}

// Same idea as the X slices: a whole, untruncated work of 2-4 equal pages may
// be one wide picture. The page sizes cost one more lookup, so it's only made
// when the page count already fits.
async function isPixivPanoramaCandidate(meta) {
  if (meta.pageCount !== meta.images.length) return false;
  if (meta.pageCount < 2 || meta.pageCount > 4) return false;
  return isPanoramaCandidate(await fetchPixivPageSizes(meta.illustId));
}

async function buildPreviewPayloads(urls) {
  const tasks = urls.map(async (url) => {
    try {
      if (isBahamutUrl(url)) return await buildBahamutPayload(url);
      if (isPttUrl(url)) return await buildPttPayload(url);
      if (isPinterestUrl(url)) return await buildPinterestPayload(url);
      if (isInstagramUrl(url)) return await buildInstagramPayload(url);
      if (isBilibiliUrl(url)) return await buildBilibiliPayload(url);
      if (isThreadsUrl(url)) return await buildThreadsPayload(url);
      if (isTwitterUrl(url)) {
        console.log(`[preview] fixer twitter ${url}`);
        return await buildTwitterPayload(url);
      }
      if (isRedditUrl(url)) {
        console.log(`[preview] fixer reddit ${url}`);
        return buildSimpleFixerPayload(url, RECOVER_PROFILES.reddit);
      }
      if (isPixivUrl(url)) {
        console.log(`[preview] fixer pixiv ${url}`);
        return await buildPixivPayload(url);
      }
      if (isBlueskyUrl(url)) {
        console.log(`[preview] fixer bluesky ${url}`);
        return buildSimpleFixerPayload(url, RECOVER_PROFILES.bluesky);
      }
      if (isFacebookUrl(url)) {
        console.log(`[preview] fixer facebook ${url}`);
        return buildFacebookPayload(url);
      }

      console.log(`[preview] fixer generic ${url}`);
      return buildSimpleFixerPayload(url, RECOVER_PROFILES.generic);
    } catch (error) {
      console.warn(
        `[preview] payload build failed for ${url}: ${error.message}`,
      );
      // Even on builder error, hand back a generic fixer URL with OG recovery
      // so the user still gets something. Never silently drop a URL.
      return buildSimpleFixerPayload(url, RECOVER_PROFILES.generic);
    }
  });

  return Promise.all(tasks);
}

module.exports = { buildPreviewPayloads };
