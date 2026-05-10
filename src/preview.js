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
} = require("./url-routing");
const { buildBahamutPayload } = require("./platforms/bahamut");
const { buildPttPayload } = require("./platforms/ptt");
const { buildInstagramPayload } = require("./platforms/instagram");
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
        return buildSimpleFixerPayload(url, RECOVER_PROFILES.twitter);
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
        return buildSimpleFixerPayload(url, RECOVER_PROFILES.facebook);
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
