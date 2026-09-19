const {
  isThreadsUrl,
  isInstagramUrl,
  isBilibiliUrl,
  isBahamutUrl,
  isPttUrl,
  isTwitterUrl,
  isRedditUrl,
  isPixivUrl,
  isBlueskyUrl,
  isFacebookUrl,
  buildFallbackUrl,
  replaceHostFixer,
} = require("./url-routing");
const { FIXER_TWITTER_SECONDARY } = require("./config");
const { buildBahamutPayload } = require("./platforms/bahamut");
const { buildPttPayload } = require("./platforms/ptt");
const { buildInstagramPayload } = require("./platforms/instagram");
const { fetchTweetHasMedia } = require("./platforms/twitter");
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
function buildTwitterPayload(url) {
  const payload = buildSimpleFixerPayload(url, RECOVER_PROFILES.twitter);
  const secondaryUrl = replaceHostFixer(url, FIXER_TWITTER_SECONDARY);
  return {
    ...payload,
    fallbackContents: [secondaryUrl],
    viewerValidation: "twitter",
    viewerRequiresMedia: fetchTweetHasMedia(url),
    recoverUrls: [secondaryUrl, ...payload.recoverUrls],
  };
}

async function buildPreviewPayloads(urls) {
  const tasks = urls.map(async (url) => {
    try {
      if (isBahamutUrl(url)) return await buildBahamutPayload(url);
      if (isPttUrl(url)) return await buildPttPayload(url);
      if (isInstagramUrl(url)) return await buildInstagramPayload(url);
      if (isBilibiliUrl(url)) return await buildBilibiliPayload(url);
      if (isThreadsUrl(url)) return await buildThreadsPayload(url);
      if (isTwitterUrl(url)) {
        console.log(`[preview] fixer twitter ${url}`);
        return buildTwitterPayload(url);
      }
      if (isRedditUrl(url)) {
        console.log(`[preview] fixer reddit ${url}`);
        return buildSimpleFixerPayload(url, RECOVER_PROFILES.reddit);
      }
      if (isPixivUrl(url)) {
        console.log(`[preview] fixer pixiv ${url}`);
        return buildSimpleFixerPayload(url, RECOVER_PROFILES.pixiv);
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
