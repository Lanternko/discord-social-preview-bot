#!/usr/bin/env node
// Routing smoke test — covers the platform-payload-builder conditional matrix
// that pure-function smoke can't reach. Mocks the probe layer so we can
// test buildThreadsPayload / buildBahamutPayload / buildInstagramPayload etc.
// against deterministic metadata inputs without spawning Playwright.
//
// History: this layer was added after two refactor bugs in the Threads
// branch order slipped past pure-function smoke and pure-function review.
// See PR #15 thread for context.
//
// Usage: node scripts/routing-smoke.js

const assert = require("node:assert/strict");

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "smoke-dummy";
// Owner-delete tests below assume exactly this owner list. Set before any
// require so config.js snapshots it at import.
process.env.BOT_OWNER_IDS = "OWNER";
process.env.EMBED_CHECK_DELAY_MS = "1";

// === MOCK SETUP ===
// Pre-require the modules whose exports we need to override, then poke their
// cached exports so downstream requires see the mocks.
const probeModulePath = require.resolve("../src/probe");
require(probeModulePath);
let _mockThreadsMetadata = null;
let _mockPageMetadata = null;
let _mockProbeError = null;
let _lastThreadsProbeUrl = null;
require.cache[probeModulePath].exports.fetchThreadsMetadata = async (url) => {
  _lastThreadsProbeUrl = url;
  if (_mockProbeError) throw _mockProbeError;
  return _mockThreadsMetadata;
};
let _pageProbeCalls = [];
require.cache[probeModulePath].exports.fetchPageProbeMetadata = async (
  url,
  options,
) => {
  _pageProbeCalls.push({ url, options });
  if (_mockProbeError) throw _mockProbeError;
  return typeof _mockPageMetadata === "function"
    ? _mockPageMetadata(options)
    : _mockPageMetadata;
};

// 巴哈登入 session：預設未設定帳號（null），個別案例再換
const bahaSessionModulePath = require.resolve("../src/bahamut-session");
require(bahaSessionModulePath);
let _mockBahaSession = async () => null;
require.cache[bahaSessionModulePath].exports.getBahamutSessionCookies = (
  opts,
) => _mockBahaSession(opts);

// Mock global fetch for Bilibili API + b23.tv expansion + Instagram display name
const _origFetch = global.fetch;
let _mockFetch = null;
global.fetch = async (...args) => {
  if (_mockFetch) return _mockFetch(...args);
  return _origFetch(...args);
};

const ogFallbackModule = require("../src/og-fallback");
let _mockAvatarMeta = null;
const realFetchOgMetadata = ogFallbackModule.fetchOgMetadata;
ogFallbackModule.fetchOgMetadata = async (url, options) => {
  if (url.startsWith("https://www.threads.com/@")) {
    if (_mockAvatarMeta instanceof Error) throw _mockAvatarMeta;
    return _mockAvatarMeta || {};
  }
  return realFetchOgMetadata(url, options);
};
const {
  buildThreadsPayload,
  resetThreadsAvatarCacheForTests,
} = require("../src/platforms/threads");
const { buildInstagramPayload } = require("../src/platforms/instagram");
const { buildBahamutPayload } = require("../src/platforms/bahamut");
const { buildPttPayload } = require("../src/platforms/ptt");
const { buildBilibiliPayload } = require("../src/platforms/bilibili");
const { buildPreviewPayloads } = require("../src/preview");
const { handleReactionDelete } = require("../src/reaction-delete");
const { sendAIReply, STICKER_MISS_REPLIES } = require("../src/mention");
const { mergeStickerSources } = require("../src/stickers");
const {
  checkAndHandleEmptyEmbeds,
  resolveOutgoing,
} = require("../src/discord-io");
const {
  resolveThreadsUrl,
  resetThreadsUrlResolverForTests,
  getThreadsUrlResolverStats,
  RESOLVE_CACHE_MAX,
  RESOLVE_MAX_CONCURRENT,
  RESOLVE_TIMEOUT_MS,
  POSITIVE_CACHE_TTL_MS,
  NEGATIVE_CACHE_TTL_MS,
} = require("../src/threads-url");

// === TEST RUNNER ===
let pass = 0;
let fail = 0;
async function it(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function shapeOf(payload) {
  return {
    hasContent: typeof payload.content === "string",
    contentStartsWithHttp:
      typeof payload.content === "string" && payload.content.startsWith("http"),
    contentText: payload.content,
    embedCount: Array.isArray(payload.embeds) ? payload.embeds.length : 0,
    hasComponents:
      Array.isArray(payload.components) && payload.components.length > 0,
    hasFallbackContent: typeof payload.fallbackContent === "string",
    fallbackContents: payload.fallbackContents,
    hasEmbedFallback: payload.embedFallback != null,
    hasVideoAttachment: typeof payload.videoAttachment === "string",
    videoAttachmentText: payload.videoAttachment,
  };
}

// === THREADS CASES ===
const THREADS_URL = "https://www.threads.net/@a/post/1";

(async () => {
  console.log("resolveThreadsUrl — redirect security and resource bounds");

  await it("reads one manual redirect, validates canonical Location, and cancels body", async () => {
    resetThreadsUrlResolverForTests();
    let calls = 0;
    let cancelled = 0;
    const shareUrl = "https://www.threads.com/share/BBV95gatql/";
    const canonical = "https://www.threads.com/@0_s0321/post/DcqQ5GpETBM";
    const fetchImpl = async (requestedUrl, options) => {
      calls += 1;
      assert.equal(requestedUrl, shareUrl);
      assert.equal(options.redirect, "manual");
      assert.equal(options.method, "GET");
      assert.ok(options.signal);
      return {
        status: 302,
        headers: new Headers({ location: `${canonical}?xmt=tracking&slof=1` }),
        bodyUsed: false,
        body: { cancel: async () => void (cancelled += 1) },
      };
    };
    assert.equal(await resolveThreadsUrl(shareUrl, { fetchImpl }), canonical);
    assert.equal(await resolveThreadsUrl(shareUrl, { fetchImpl }), canonical);
    assert.equal(calls, 1, "positive result should be cached");
    assert.equal(cancelled, 1, "redirect body should be cancelled");
    assert.equal(RESOLVE_TIMEOUT_MS, 2500);
  });

  await it("does not fetch non-exact share URLs and negative-caches unsafe Location", async () => {
    resetThreadsUrlResolverForTests();
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        status: 302,
        headers: new Headers({
          location: "https://evil.example/@victim/post/redirected",
        }),
        body: null,
      };
    };
    const unsafeInput = "http://www.threads.com/share/not-https/";
    assert.equal(
      await resolveThreadsUrl(unsafeInput, { fetchImpl }),
      unsafeInput,
    );
    const safeInput = "https://www.threads.com/share/unsafe-location/";
    assert.equal(await resolveThreadsUrl(safeInput, { fetchImpl }), safeInput);
    assert.equal(await resolveThreadsUrl(safeInput, { fetchImpl }), safeInput);
    assert.equal(calls, 1, "unsafe Location should be negative-cached");
  });

  await it("accepts a relative canonical Location and rejects unsafe redirect targets", async () => {
    resetThreadsUrlResolverForTests();
    let calls = 0;
    const relativeShare = "https://www.threads.com/share/RELATIVE/";
    const relativeResult = await resolveThreadsUrl(relativeShare, {
      fetchImpl: async () => {
        calls += 1;
        return {
          status: 302,
          headers: new Headers({ location: "/@resolver/post/RELATIVE?xmt=x" }),
          body: null,
        };
      },
    });
    assert.equal(
      relativeResult,
      "https://www.threads.com/@resolver/post/RELATIVE",
    );

    const unsafeLocations = [
      "http://www.threads.com/@resolver/post/HTTP",
      "https://threads.com.evil.example/@resolver/post/SUFFIX",
      "https://127.0.0.1/@resolver/post/LOOPBACK",
      "https://www.threads.com:443/@resolver/post/DEFAULTPORT",
      "https://www.threads.com:444/@resolver/post/PORT",
      "https://www.threads.com/not-a-post/PATH",
      "https://www.threads.com/@resolver/post/ID?unexpected=1",
    ];
    for (let index = 0; index < unsafeLocations.length; index += 1) {
      const shareUrl = `https://www.threads.com/share/UNSAFE${index}/`;
      assert.equal(
        await resolveThreadsUrl(shareUrl, {
          fetchImpl: async () => {
            calls += 1;
            return {
              status: 302,
              headers: new Headers({ location: unsafeLocations[index] }),
              body: null,
            };
          },
        }),
        shareUrl,
      );
    }
    assert.equal(calls, unsafeLocations.length + 1);
  });

  await it("fails closed on missing Location, non-redirect status, and timeout", async () => {
    resetThreadsUrlResolverForTests();
    const cases = [
      { token: "NOLOCATION", status: 302, headers: new Headers() },
      { token: "OKSTATUS", status: 200, headers: new Headers() },
      { token: "RATELIMIT", status: 429, headers: new Headers() },
      { token: "SERVERERROR", status: 500, headers: new Headers() },
    ];
    for (const testCase of cases) {
      const shareUrl = `https://www.threads.com/share/${testCase.token}/`;
      assert.equal(
        await resolveThreadsUrl(shareUrl, {
          fetchImpl: async () => ({ ...testCase, body: null }),
        }),
        shareUrl,
      );
    }

    const timeoutUrl = "https://www.threads.com/share/TIMEOUT/";
    assert.equal(
      await resolveThreadsUrl(timeoutUrl, {
        fetchImpl: async (_url, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener("abort", () => {
              const error = new Error("timed out");
              error.name = "AbortError";
              reject(error);
            });
          }),
      }),
      timeoutUrl,
    );
    const stats = getThreadsUrlResolverStats();
    assert.equal(stats.active, 0);
    assert.equal(stats.queued, 0);
  });

  await it("deduplicates inflight work and never exceeds four redirect fetches", async () => {
    resetThreadsUrlResolverForTests();
    let calls = 0;
    const fetchImpl = async (shareUrl) => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      const token = new URL(shareUrl).pathname.split("/").filter(Boolean).pop();
      return {
        status: 302,
        headers: new Headers({
          location: `https://www.threads.com/@resolver/post/${token}`,
        }),
        body: null,
      };
    };
    const shared = "https://www.threads.com/share/DEDUPE/";
    const inputs = Array.from({ length: 100 }, () => shared);
    for (let index = 0; index < 8; index += 1) {
      inputs.push(`https://www.threads.com/share/CONCURRENCY${index}/`);
    }
    await Promise.all(
      inputs.map((url) => resolveThreadsUrl(url, { fetchImpl })),
    );
    const stats = getThreadsUrlResolverStats();
    assert.equal(calls, 9, "100 identical inflight URLs share one fetch");
    assert.ok(stats.maxObservedConcurrency <= RESOLVE_MAX_CONCURRENT);
    assert.equal(RESOLVE_MAX_CONCURRENT, 4);
  });

  await it("bounds positive and negative resolver cache entries", async () => {
    resetThreadsUrlResolverForTests();
    const fetchImpl = async () => ({
      status: 404,
      headers: new Headers(),
      body: null,
    });
    for (let index = 0; index < RESOLVE_CACHE_MAX + 8; index += 1) {
      await resolveThreadsUrl(
        `https://www.threads.com/share/NEGATIVE${index}/`,
        { fetchImpl },
      );
    }
    const stats = getThreadsUrlResolverStats();
    assert.equal(stats.cacheSize, RESOLVE_CACHE_MAX);
    assert.equal(stats.negativeEntries, RESOLVE_CACHE_MAX);
  });

  await it("expires positive and negative resolver cache entries at separate TTLs", async () => {
    resetThreadsUrlResolverForTests();
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      let positiveCalls = 0;
      const positiveFetch = async () => {
        positiveCalls += 1;
        return {
          status: 302,
          headers: new Headers({
            location: "https://www.threads.com/@resolver/post/POSITIVE",
          }),
          body: null,
        };
      };
      const positiveUrl = "https://www.threads.com/share/POSITIVE/";
      await resolveThreadsUrl(positiveUrl, { fetchImpl: positiveFetch });
      now += POSITIVE_CACHE_TTL_MS - 1;
      await resolveThreadsUrl(positiveUrl, { fetchImpl: positiveFetch });
      assert.equal(positiveCalls, 1);
      now += 2;
      await resolveThreadsUrl(positiveUrl, { fetchImpl: positiveFetch });
      assert.equal(positiveCalls, 2);

      let negativeCalls = 0;
      const negativeFetch = async () => {
        negativeCalls += 1;
        return { status: 404, headers: new Headers(), body: null };
      };
      const negativeUrl = "https://www.threads.com/share/NEGATIVETTL/";
      await resolveThreadsUrl(negativeUrl, { fetchImpl: negativeFetch });
      now += NEGATIVE_CACHE_TTL_MS - 1;
      await resolveThreadsUrl(negativeUrl, { fetchImpl: negativeFetch });
      assert.equal(negativeCalls, 1);
      now += 2;
      await resolveThreadsUrl(negativeUrl, { fetchImpl: negativeFetch });
      assert.equal(negativeCalls, 2);
    } finally {
      Date.now = originalNow;
    }
  });

  console.log("buildThreadsPayload — branch coverage");

  await it("expands a share URL before probe and uses canonical links", async () => {
    resetThreadsUrlResolverForTests();
    const shareUrl = "https://www.threads.com/share/BBV95gatql/";
    const canonical = "https://www.threads.com/@0_s0321/post/DcqQ5GpETBM";
    _mockFetch = async (_url, options) => {
      assert.equal(options.redirect, "manual");
      return {
        status: 302,
        headers: new Headers({ location: `${canonical}?xmt=tracking` }),
        body: null,
      };
    };
    _mockThreadsMetadata = {
      image: null,
      title: "canonical post",
      description: "body",
      twitterCard: null,
      images: [],
      imageCount: 0,
      videoCount: 0,
      video: false,
    };
    try {
      const p = await buildThreadsPayload(shareUrl);
      assert.equal(_lastThreadsProbeUrl, canonical);
      assert.equal(p.embeds[0].data.url, canonical);
    } finally {
      _mockFetch = null;
    }
  });

  await it("text-only (no image, no card) → compact embed only", async () => {
    _mockThreadsMetadata = {
      image: null,
      title: "hi",
      description: "body",
      twitterCard: null,
      images: [],
      imageCount: 0,
      videoCount: 0,
      video: false,
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    assert.equal(s.embedCount, 1);
    assert.equal(s.hasContent, false);
    assert.equal(s.hasComponents, false);
  });

  await it("reply post → quotes the ancestor above the reply", async () => {
    _mockThreadsMetadata = {
      image: null,
      title: "someone (@kid) on Threads",
      description: "punchline",
      postText: "punchline",
      twitterCard: null,
      images: [],
      imageCount: 0,
      videoCount: 0,
      video: false,
      ancestors: [{ author: "op", text: "setup line 1\nsetup line 2" }],
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const description = p.embeds[0].data.description;
    assert.ok(
      description.includes("> **@op**"),
      `names the quoted author, got: ${description}`,
    );
    assert.ok(
      description.includes("> setup line 1") &&
        description.includes("> setup line 2"),
      `every quoted line keeps its > prefix, got: ${description}`,
    );
    assert.ok(
      description.includes("↳ punchline"),
      `the reply itself is still shown, got: ${description}`,
    );
    assert.ok(
      description.indexOf("> **@op**") < description.indexOf("↳ punchline"),
      "setup must come before the punchline",
    );
  });

  await it("deep reply chain → keeps root + direct parent, marks the gap", async () => {
    _mockThreadsMetadata = {
      image: null,
      title: "t",
      description: "d",
      twitterCard: null,
      images: [],
      imageCount: 0,
      videoCount: 0,
      video: false,
      ancestors: [
        { author: "root", text: "root text" },
        { author: "mid", text: "mid text" },
        { author: "parent", text: "parent text" },
      ],
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const description = p.embeds[0].data.description;
    assert.ok(description.includes("@root"), "keeps the thread's root post");
    assert.ok(description.includes("@parent"), "keeps the direct parent");
    assert.ok(
      !description.includes("@mid"),
      "drops the middle of a long chain",
    );
    assert.ok(
      description.includes("還有 1 則"),
      `says how many were skipped, got: ${description}`,
    );
  });

  await it("non-reply post → description untouched", async () => {
    _mockThreadsMetadata = {
      image: null,
      title: "t",
      description: "plain body",
      twitterCard: null,
      images: [],
      imageCount: 0,
      videoCount: 0,
      video: false,
      ancestors: [],
    };
    const p = await buildThreadsPayload(THREADS_URL);
    assert.equal(p.embeds[0].data.description, "plain body");
  });

  await it("twitterCard=summary even with image → compact embed only", async () => {
    _mockThreadsMetadata = {
      image: "https://x/y.jpg",
      title: "t",
      description: "d",
      twitterCard: "summary",
      images: ["https://x/y.jpg"],
      imageCount: 1,
      videoCount: 0,
      video: false,
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    assert.equal(s.embedCount, 1);
    assert.equal(s.hasContent, false);
  });

  await it("multi-image (3 images, no video) → carousel of 3 embeds", async () => {
    _mockThreadsMetadata = {
      image: "https://x/1.jpg",
      title: "t",
      description: "d",
      twitterCard: "summary_large_image",
      images: ["https://x/1.jpg", "https://x/2.jpg", "https://x/3.jpg"],
      imageCount: 3,
      videoCount: 0,
      video: false,
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    assert.equal(s.embedCount, 3);
    assert.equal(s.hasContent, false);
    assert.equal(s.hasComponents, false);
  });

  await it("multi-image >3 images → truncated to MULTI_IMAGE_PREVIEW_COUNT, last embed hints remaining", async () => {
    _mockThreadsMetadata = {
      image: "https://x/1.jpg",
      title: "t",
      description: "d",
      twitterCard: "summary_large_image",
      images: [
        "https://x/1.jpg",
        "https://x/2.jpg",
        "https://x/3.jpg",
        "https://x/4.jpg",
        "https://x/5.jpg",
      ],
      imageCount: 5,
      videoCount: 0,
      video: false,
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    assert.equal(s.embedCount, 3, "should truncate to default preview count 3");
    assert.equal(
      s.hasComponents,
      false,
      "no button — rely on embed URL instead",
    );
    const lastDesc = p.embeds[p.embeds.length - 1].data?.description;
    assert.ok(
      typeof lastDesc === "string" && lastDesc.includes("還有 2 張"),
      `last embed should hint remaining images, got: ${lastDesc}`,
    );
  });

  await it("multi-image with imageCount > images.length (fallback) → 1 embed + description hint", async () => {
    _mockThreadsMetadata = {
      image: "https://x/1.jpg",
      title: "t",
      description: "d",
      twitterCard: "summary_large_image",
      images: [],
      imageCount: 5,
      videoCount: 0,
      video: false,
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    assert.equal(s.embedCount, 1);
    assert.equal(s.hasComponents, false, "no button");
    const desc = p.embeds[0].data?.description;
    assert.ok(
      typeof desc === "string" && desc.includes("還有 4 張"),
      `fallback embed should hint remaining images, got: ${desc}`,
    );
  });

  // CRITICAL CASE (regression that bit twice in PR #15): a MIXED post must KEEP
  // the image carousel — images must never be dropped for a bare video fixer. It
  // now ALSO flags the video for upload (videoAttachment) so discord-io can post
  // a real playable video below the gallery. Uses 5 images to also assert the
  // truncation hint survives and no longer announces "影片".
  await it("MIXED: multi-image AND video → carousel gallery + video attachment", async () => {
    _mockThreadsMetadata = {
      image: "https://x/1.jpg",
      title: "t",
      description: "d",
      twitterCard: "summary_large_image",
      images: [
        "https://x/1.jpg",
        "https://x/2.jpg",
        "https://x/3.jpg",
        "https://x/4.jpg",
        "https://x/5.jpg",
      ],
      imageCount: 5,
      videoCount: 1,
      video: "https://cdn.example/v.mp4",
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    // gallery preserved (truncated to the preview count)...
    assert.equal(s.embedCount, 3, "keeps the image carousel (truncated to 3)");
    // ...AND the video is flagged for a real upload, not a bare fixer URL
    assert.equal(s.hasVideoAttachment, true, "flags the video for attachment");
    assert.equal(s.videoAttachmentText, "https://cdn.example/v.mp4");
    assert.equal(s.hasContent, false, "MUST NOT post a bare fixer/content URL");
    assert.equal(s.hasFallbackContent, false);
    assert.equal(s.hasEmbedFallback, false);
    assert.equal(s.hasComponents, false);
    const lastDesc = p.embeds[p.embeds.length - 1].data?.description;
    assert.ok(
      typeof lastDesc === "string" && lastDesc.includes("還有 2 張"),
      `last embed should still hint remaining images, got: ${lastDesc}`,
    );
    assert.ok(
      !/影片/.test(lastDesc || ""),
      `hint must NOT announce 影片 now that the video attaches, got: ${lastDesc}`,
    );
  });

  await it("video only (no multi-image) → video attachment + ordered viewer chain", async () => {
    _mockThreadsMetadata = {
      image: "https://x/thumb.jpg",
      title: "t",
      description: "d",
      twitterCard: "player",
      images: [],
      imageCount: 0,
      videoCount: 1,
      video: "https://cdn.example/v.mp4",
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    // tries the real video upload first...
    assert.equal(s.hasVideoAttachment, true, "flags the video for attachment");
    assert.equal(s.videoAttachmentText, "https://cdn.example/v.mp4");
    // ...and still carries the full fixer chain as the fallback when it misses
    assert.equal(s.contentStartsWithHttp, true);
    assert.ok(
      s.contentText.includes("fzthreads.com"),
      "primary viewer present",
    );
    assert.deepEqual(p.fallbackContents, [
      "https://fixthreads.seria.moe/@a/post/1",
    ]);
    assert.equal(p.viewerValidation, "threads");
    assert.equal(s.hasEmbedFallback, true);
    assert.ok(
      Array.isArray(p.videoAttachmentEmbeds) &&
        p.videoAttachmentEmbeds.length === 1,
      "carries a clean title/文案 embed for the successful-attachment case",
    );
    assert.equal(
      p.recoverUrls,
      undefined,
      "Threads must not bot-fetch viewers",
    );
    assert.equal(p.embedFallback.embeds[0].data.url, THREADS_URL);
  });

  // Regression: a video-only post with NO og:image used to fall into the
  // text-only branch (because isTextOnly = !metadata.image) and never hit the
  // video-fixer chain — silently dropping the video.
  await it("video only with NO og:image → still routes to fixer chain", async () => {
    _mockThreadsMetadata = {
      image: null,
      title: "t",
      description: "d",
      twitterCard: "player",
      images: [],
      imageCount: 0,
      videoCount: 1,
      video: "https://cdn.example/v.mp4",
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    assert.equal(s.hasVideoAttachment, true, "flags the video for attachment");
    assert.equal(s.contentStartsWithHttp, true);
    assert.ok(
      s.contentText.includes("fzthreads.com"),
      "MUST route to video fixer, not text-only embed",
    );
    assert.equal(p.fallbackContents.length, 1);
  });

  await it("single image (summary_large_image, imageCount=1) → 1 media embed", async () => {
    _mockThreadsMetadata = {
      image: "https://x/y.jpg",
      title: "t",
      description: "d",
      twitterCard: "summary_large_image",
      images: ["https://x/y.jpg"],
      imageCount: 1,
      videoCount: 0,
      video: false,
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    assert.equal(s.embedCount, 1);
    assert.equal(s.hasContent, false);
    assert.equal(s.hasComponents, false);
  });

  await it("generic fallback (image but no recognized card/multi/video) → compact embed", async () => {
    _mockThreadsMetadata = {
      image: "https://x/y.jpg",
      title: "t",
      description: "d",
      twitterCard: "app",
      images: ["https://x/y.jpg"],
      imageCount: 1,
      videoCount: 0,
      video: false,
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    assert.equal(s.embedCount, 1);
    assert.equal(s.hasContent, false);
  });

  await it("probe error → ordered viewers then local canonical embed", async () => {
    _mockProbeError = new Error("probe boom");
    try {
      const p = await buildThreadsPayload(THREADS_URL);
      const s = shapeOf(p);
      assert.equal(s.contentStartsWithHttp, true);
      assert.ok(s.contentText.includes("fzthreads.com"));
      assert.equal(s.embedCount, 0);
      assert.deepEqual(p.fallbackContents, [
        "https://fixthreads.seria.moe/@a/post/1",
      ]);
      assert.equal(p.viewerValidation, "threads");
      assert.equal(p.recoverUrls, undefined);
      assert.equal(p.embedFallback.embeds[0].data.url, THREADS_URL);
    } finally {
      _mockProbeError = null;
    }
  });

  await it("walled post → fallback card names the author and says why", async () => {
    _mockProbeError = Object.assign(new Error("stub"), { walled: true });
    try {
      const p = await buildThreadsPayload(THREADS_URL);
      const embed = p.embedFallback.embeds[0].data;
      assert.equal(embed.author.name, "@a");
      assert.equal(embed.title, "@a 的 Threads 貼文");
      assert.ok(embed.description.includes("未登入"), "explains the wall");
    } finally {
      _mockProbeError = null;
    }
    _mockProbeError = new Error("network boom");
    try {
      const p = await buildThreadsPayload(THREADS_URL);
      const embed = p.embedFallback.embeds[0].data;
      assert.equal(embed.author.name, "@a", "author even on plain errors");
      assert.ok(!embed.description.includes("未登入"), "no wall claim");
    } finally {
      _mockProbeError = null;
    }
  });

  await it("walled post → author avatar from the public profile page", async () => {
    const avatar = "https://scontent-tpe1-1.cdninstagram.com/v/a.jpg";
    resetThreadsAvatarCacheForTests();
    _mockAvatarMeta = { image: avatar };
    _mockProbeError = Object.assign(new Error("stub"), { walled: true });
    try {
      const embed = (await buildThreadsPayload(THREADS_URL)).embedFallback
        .embeds[0].data;
      assert.equal(embed.author.icon_url, avatar);
      assert.equal(embed.thumbnail.url, avatar);

      // off-CDN image or a failed fetch → card still renders, no avatar
      for (const meta of [
        { image: "https://evil.example/a.jpg" },
        new Error("timeout"),
      ]) {
        resetThreadsAvatarCacheForTests();
        _mockAvatarMeta = meta;
        const plain = (await buildThreadsPayload(THREADS_URL)).embedFallback
          .embeds[0].data;
        assert.equal(plain.author.name, "@a");
        assert.equal(plain.author.icon_url, undefined);
        assert.equal(plain.thumbnail, undefined);
      }
    } finally {
      _mockProbeError = null;
      _mockAvatarMeta = null;
      resetThreadsAvatarCacheForTests();
    }
  });

  await it("Threads viewer validation advances through arbitrary fallbacks and stops at first useful embed", async () => {
    const edits = [];
    const target = {
      id: "viewer-chain",
      embeds: [
        {
          title: "Threads • Log in",
          description: "Join Threads to share ideas",
        },
      ],
      async fetch() {
        return this;
      },
      async edit(payload) {
        edits.push(payload);
        if (payload.content === "https://viewer-one.example/post") {
          this.embeds = [{ title: "Threads" }];
        } else if (payload.content === "https://viewer-two.example/post") {
          this.embeds = [{ title: "author", description: "real post body" }];
        }
        return this;
      },
    };
    const result = await checkAndHandleEmptyEmbeds(
      { reply: async () => assert.fail("must not apologize") },
      [
        {
          sentMessage: target,
          isUrlOnly: true,
          fallbackContents: [
            "https://viewer-one.example/post",
            "https://viewer-two.example/post",
            "https://viewer-three.example/post",
          ],
          viewerValidation: "threads",
          embedFallback: null,
          recoverUrls: null,
        },
      ],
    );
    assert.equal(result.allSucceeded, true);
    assert.deepEqual(
      edits.map((edit) => edit.content),
      ["https://viewer-one.example/post", "https://viewer-two.example/post"],
    );
  });

  await it("all useless Threads viewers end at local canonical embed without OG recovery", async () => {
    const canonical = "https://www.threads.com/@a/post/1";
    const edits = [];
    const localEmbed = { title: "Threads 貼文", url: canonical };
    const target = {
      id: "viewer-local-fallback",
      embeds: [],
      async fetch() {
        return this;
      },
      async edit(payload) {
        edits.push(payload);
        if (payload.content) this.embeds = [{ title: "Threads" }];
        return this;
      },
      async delete() {
        assert.fail("local fallback must prevent deletion");
      },
    };
    const result = await checkAndHandleEmptyEmbeds(
      { reply: async () => assert.fail("must not apologize") },
      [
        {
          sentMessage: target,
          isUrlOnly: true,
          fallbackContents: ["https://viewer.example/post"],
          viewerValidation: "threads",
          embedFallback: { embeds: [localEmbed] },
          recoverUrls: null,
          sourceUrl: canonical,
        },
      ],
    );
    assert.equal(result.allSucceeded, true);
    assert.deepEqual(edits.at(-1).embeds, [localEmbed]);
    assert.equal(edits.at(-1).content, "");
  });

  await it("Instagram viewer chain advances past a login wall and stops on playable media", async () => {
    const edits = [];
    const target = {
      id: "instagram-viewer-chain",
      embeds: [{ title: "Instagram • Log in" }],
      async fetch() {
        return this;
      },
      async edit(payload) {
        edits.push(payload);
        if (payload.content === "https://viewer-two.example/reel/1") {
          this.embeds = [
            {
              title: "@creator",
              video: { url: "https://cdn.example/video.mp4" },
            },
          ];
        }
        return this;
      },
    };
    const result = await checkAndHandleEmptyEmbeds(
      { reply: async () => assert.fail("must not apologize") },
      [
        {
          sentMessage: target,
          isUrlOnly: true,
          fallbackContents: [
            "https://viewer-two.example/reel/1",
            "https://viewer-three.example/reel/1",
          ],
          viewerValidation: "instagram",
          embedFallback: null,
          recoverUrls: null,
        },
      ],
    );
    assert.equal(result.allSucceeded, true);
    assert.deepEqual(
      edits.map((edit) => edit.content),
      ["https://viewer-two.example/reel/1"],
    );
  });

  await it("Instagram viewers all empty → OG recovery wins over the placeholder", async () => {
    const edits = [];
    const target = {
      id: "instagram-og-recover",
      embeds: [],
      async fetch() {
        return this;
      },
      async edit(payload) {
        edits.push(payload);
        return this;
      },
      async delete() {
        assert.fail("OG recovery must prevent deletion");
      },
    };
    _mockFetch = async (url) => {
      if (url.startsWith("https://og-one.example/")) {
        return new Response("forbidden", { status: 403 });
      }
      return new Response(
        '<html><head><meta property="og:title" content="@creator"/><meta property="og:image" content="https://cdn.example/cover.jpg"/></head></html>',
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };
    try {
      const result = await checkAndHandleEmptyEmbeds(
        { reply: async () => assert.fail("must not apologize") },
        [
          {
            sentMessage: target,
            isUrlOnly: true,
            fallbackContents: ["https://viewer-two.example/reel/1"],
            viewerValidation: "instagram",
            embedFallback: null,
            recoverUrls: [
              "https://og-one.example/reel/1",
              "https://og-two.example/reel/1",
            ],
            recoverEmbedOptions: { color: 0xe1306c },
            placeholderFallback: { embeds: [{ title: "Instagram 貼文" }] },
            sourceUrl: "https://www.instagram.com/reel/1/",
          },
        ],
      );
      assert.equal(result.allSucceeded, true);
      const last = edits.at(-1);
      assert.equal(last.content, "");
      assert.equal(last.embeds[0].data.title, "@creator");
      assert.equal(
        last.embeds[0].data.url,
        "https://www.instagram.com/reel/1/",
      );
    } finally {
      _mockFetch = null;
    }
  });

  await it("Instagram OG recovery fails → placeholder instead of delete", async () => {
    const edits = [];
    const placeholder = { title: "Instagram 貼文" };
    const target = {
      id: "instagram-placeholder",
      embeds: [],
      async fetch() {
        return this;
      },
      async edit(payload) {
        edits.push(payload);
        return this;
      },
      async delete() {
        assert.fail("placeholder must prevent deletion");
      },
    };
    _mockFetch = async () => new Response("forbidden", { status: 403 });
    try {
      const result = await checkAndHandleEmptyEmbeds(
        { reply: async () => assert.fail("must not apologize") },
        [
          {
            sentMessage: target,
            isUrlOnly: true,
            fallbackContents: [],
            viewerValidation: "instagram",
            embedFallback: null,
            recoverUrls: ["https://og-one.example/reel/1"],
            placeholderFallback: { embeds: [placeholder] },
            sourceUrl: "https://www.instagram.com/reel/1/",
          },
        ],
      );
      assert.equal(result.allSucceeded, true);
      assert.deepEqual(edits.at(-1).embeds, [placeholder]);
    } finally {
      _mockFetch = null;
    }
  });

  await it("successful video attachment removes the entire viewer fallback chain", async () => {
    const outgoing = await resolveOutgoing(
      {
        videoAttachment: "https://cdn.example/video.mp4",
        videoAttachmentEmbeds: [{ title: "caption" }],
        content: "https://fzthreads.com/@a/post/1",
        fallbackContent: "https://legacy.example/@a/post/1",
        fallbackContents: ["https://fixthreads.seria.moe/@a/post/1"],
      },
      { guild: null },
      {
        fetchVideoAttachment: async () => ({
          buffer: Buffer.from("video"),
          name: "video.mp4",
        }),
      },
    );
    assert.equal(outgoing.content, undefined);
    assert.equal(outgoing.fallbackContent, undefined);
    assert.equal(outgoing.fallbackContents, undefined);
    assert.equal(outgoing.files.length, 1);
  });

  // === BAHAMUT CASES ===
  console.log("buildBahamutPayload");

  await it("normal bahamut → custom embed", async () => {
    _mockPageMetadata = {
      title: "巴哈標題",
      description: "內容",
      author: "Joe",
      image: null,
      restricted: false,
    };
    const p = await buildBahamutPayload("https://forum.gamer.com.tw/x/1");
    const s = shapeOf(p);
    assert.equal(s.embedCount, 1);
    assert.equal(s.hasContent, false);
  });

  await it("bahamut article media wins over og:image, video rides as content", async () => {
    _mockPageMetadata = {
      title: "x",
      description: "y",
      image: "https://i1.ytimg.com/vi/ID/hqdefault.jpg",
      images: [
        "https://meee.com.tw/abc.gif",
        "https://truth.bahamut.com.tw/a.JPG",
      ],
      videoUrls: ["https://www.youtube.com/watch?v=ID"],
      restricted: false,
    };
    const p = await buildBahamutPayload("https://forum.gamer.com.tw/x/1");
    assert.equal(
      p.embeds[0].data?.image?.url,
      "https://meee.com.tw/abc.gif",
      "the GIF the author posted beats the still og:image thumbnail",
    );
    assert.equal(
      p.content,
      "https://www.youtube.com/watch?v=ID",
      "video URL must ride as content so Discord unfurls a real player",
    );
    // embeds + content together keep this off the empty-embed delete path
    assert.equal(shapeOf(p).embedCount, 1);
  });

  await it("bahamut without article media keeps og:image and stays content-free", async () => {
    _mockPageMetadata = {
      title: "x",
      description: "y",
      image: "https://i1.ytimg.com/vi/ID/hqdefault.jpg",
      images: [],
      videoUrls: [],
      restricted: false,
    };
    const p = await buildBahamutPayload("https://forum.gamer.com.tw/x/1");
    assert.equal(
      p.embeds[0].data?.image?.url,
      "https://i1.ytimg.com/vi/ID/hqdefault.jpg",
    );
    assert.equal(shapeOf(p).hasContent, false);
  });

  await it("bahamut text-only post drops the site-wide logo og:image", async () => {
    _mockPageMetadata = {
      title: "x",
      description: "第一行\n第二行",
      image: "https://i2.bahamut.com.tw/bahaLOGO_1200x630.jpg",
      images: [],
      videoUrls: [],
      restricted: false,
    };
    const p = await buildBahamutPayload(
      "https://forum.gamer.com.tw/Co.php?bsn=60076&sn=1",
    );
    assert.equal(
      p.embeds[0].data?.image,
      undefined,
      "no picture beats the Bahamut logo",
    );
    assert.equal(
      p.embeds[0].data?.description,
      "第一行\n第二行",
      "line breaks survive",
    );
  });

  await it("bahamut restricted with public title/desc → embed with login notice", async () => {
    _mockPageMetadata = {
      title: "x",
      description: "y",
      restricted: true,
    };
    const p = await buildBahamutPayload("https://forum.gamer.com.tw/x/1");
    const s = shapeOf(p);
    assert.equal(s.embedCount, 1, "should still show partial public summary");
    const desc = p.embeds[0].data?.description;
    assert.ok(
      typeof desc === "string" && desc.includes("登入巴哈姆特"),
      `should append login notice, got: ${desc}`,
    );
  });

  await it("bahamut restricted with no usable metadata → fixer URL fallback", async () => {
    _mockPageMetadata = {
      title: null,
      description: null,
      restricted: true,
    };
    const p = await buildBahamutPayload("https://forum.gamer.com.tw/x/1");
    const s = shapeOf(p);
    assert.equal(s.embedCount, 0);
    assert.equal(s.contentStartsWithHttp, true);
  });

  await it("bahamut 兒少保護 wall text is not passed off as a summary", async () => {
    _mockPageMetadata = {
      title: "兒少保護警示",
      description:
        "您將進入的頁面，有不適合兒少瀏覽的內容，需年滿 15 歲、完成「手機認證」且開啟「顯示敏感內容」設定才可閱覽。",
      image: "https://i2.bahamut.com.tw/child-protection.png",
      restricted: true,
    };
    const p = await buildBahamutPayload(
      "https://forum.gamer.com.tw/C.php?bsn=60076&snA=1",
    );
    assert.equal(
      shapeOf(p).embedCount,
      0,
      "the wall must not render as the post",
    );
    assert.equal(shapeOf(p).contentStartsWithHttp, true);
  });

  await it("bahamut with a login session → probe carries the session cookies", async () => {
    _pageProbeCalls = [];
    _mockBahaSession = async () => ({ BAHAENUR: "a", BAHARUNE: "b" });
    _mockPageMetadata = {
      title: "場外文",
      description: "內文",
      restricted: false,
    };
    try {
      const p = await buildBahamutPayload(
        "https://forum.gamer.com.tw/C.php?bsn=60076&snA=1",
      );
      assert.equal(shapeOf(p).embedCount, 1);
      assert.equal(_pageProbeCalls.length, 1);
      const names = _pageProbeCalls[0].options.cookies.map(
        (c) => `${c.name}@${c.domain}`,
      );
      assert.deepEqual(names, [
        "BAHAENUR@.gamer.com.tw",
        "BAHARUNE@.gamer.com.tw",
      ]);
    } finally {
      _mockBahaSession = async () => null;
    }
  });

  await it("bahamut walled despite session → forced re-login, retry succeeds", async () => {
    _pageProbeCalls = [];
    const stale = { BAHAENUR: "old", BAHARUNE: "old" };
    const renewed = { BAHAENUR: "new", BAHARUNE: "new" };
    _mockBahaSession = async (opts) => (opts?.force ? renewed : stale);
    _mockPageMetadata = (options) =>
      options.cookies[0].value === "new"
        ? { title: "場外文", description: "內文", restricted: false }
        : {
            title: "兒少保護警示",
            description: "您將進入的頁面…",
            restricted: true,
          };
    try {
      const p = await buildBahamutPayload(
        "https://forum.gamer.com.tw/C.php?bsn=60076&snA=1",
      );
      assert.equal(_pageProbeCalls.length, 2);
      assert.equal(p.embeds[0].data?.title?.includes("場外文"), true);
    } finally {
      _mockBahaSession = async () => null;
    }
  });

  await it("bahamut walled, re-login gives same session → no second probe", async () => {
    _pageProbeCalls = [];
    const same = { BAHAENUR: "a", BAHARUNE: "b" };
    _mockBahaSession = async () => same;
    _mockPageMetadata = {
      title: "兒少保護警示",
      description: "您將進入的頁面…",
      restricted: true,
    };
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const p = await buildBahamutPayload(
        "https://forum.gamer.com.tw/C.php?bsn=60076&snA=1",
      );
      assert.equal(_pageProbeCalls.length, 1);
      assert.equal(shapeOf(p).embedCount, 0);
    } finally {
      console.warn = origWarn;
      _mockBahaSession = async () => null;
    }
  });

  await it("bahamut probe error → fallback fixer URL", async () => {
    _mockProbeError = new Error("probe boom");
    try {
      const p = await buildBahamutPayload("https://forum.gamer.com.tw/x/1");
      const s = shapeOf(p);
      assert.equal(s.embedCount, 0);
      assert.equal(s.contentStartsWithHttp, true);
    } finally {
      _mockProbeError = null;
    }
  });

  // === PTT CASES ===
  console.log("buildPttPayload");

  await it("normal ptt → custom embed", async () => {
    _mockPageMetadata = {
      title: "標題",
      description: "內文",
      author: "PTTuser",
      image: null,
    };
    const p = await buildPttPayload("https://www.ptt.cc/bbs/X/M.123.html");
    const s = shapeOf(p);
    assert.equal(s.embedCount, 1);
    assert.equal(s.hasContent, false);
  });

  await it("ptt probe error → fallback (fixembed)", async () => {
    _mockProbeError = new Error("probe boom");
    try {
      const p = await buildPttPayload("https://www.ptt.cc/bbs/X/M.123.html");
      const s = shapeOf(p);
      assert.equal(s.embedCount, 0);
      assert.equal(s.contentStartsWithHttp, true);
    } finally {
      _mockProbeError = null;
    }
  });

  // === INSTAGRAM CASES ===
  console.log("buildInstagramPayload");

  await it("instagram reel → canonical ordered viewers + OG recovery + placeholder", async () => {
    const p = await buildInstagramPayload(
      "https://instagram.com/reels/DcA0yXWMF4E/?igsh=tracking",
    );
    const s = shapeOf(p);
    assert.equal(s.contentStartsWithHttp, true);
    assert.equal(s.contentText, "https://oginstagram.com/reel/DcA0yXWMF4E/");
    assert.deepEqual(p.fallbackContents, [
      "https://instagram7.com/reel/DcA0yXWMF4E/",
      "https://deinstagram.com/reel/DcA0yXWMF4E/",
    ]);
    assert.equal(p.viewerValidation, "instagram");
    assert.equal(s.hasEmbedFallback, false);
    // instagram.com itself is the last recovery candidate: the origin still
    // serves og:image + twitter:title to a Discordbot UA, so the chain has a
    // source that no third-party viewer outage can take away.
    assert.deepEqual(p.recoverUrls, [
      "https://instagram7.com/reel/DcA0yXWMF4E/",
      "https://deinstagram.com/reel/DcA0yXWMF4E/",
      "https://fxig.seria.moe/reel/DcA0yXWMF4E/",
      "https://www.instagram.com/reel/DcA0yXWMF4E/",
    ]);
    assert.equal(p.recoverStrategy.collect, true);
    // A recovery answer without a cover is the host's own landing page.
    assert.equal(p.recoverStrategy.validateMeta({ title: "Instagram" }), false);
    assert.equal(
      p.recoverStrategy.validateMeta({ image: "https://cdn/x.jpg" }),
      true,
    );
    assert.equal(
      p.placeholderFallback.embeds[0].data.url,
      "https://www.instagram.com/reel/DcA0yXWMF4E/",
    );
  });

  await it("instagram story (with owner, display-name probe fails) → owner-only message", async () => {
    _mockProbeError = new Error("not allowed"); // simulate probe failure for display name lookup
    try {
      const p = await buildInstagramPayload(
        "https://www.instagram.com/stories/some_user/123",
      );
      const s = shapeOf(p);
      assert.equal(s.embedCount, 0);
      assert.equal(s.hasContent, true);
      assert.ok(p.content.includes("@some_user"));
      assert.ok(p.content.includes("限動"));
    } finally {
      _mockProbeError = null;
    }
  });

  await it("instagram story (display-name probe succeeds) → owner-with-name", async () => {
    _mockPageMetadata = {
      title: "Some Display (@some_user) • Instagram photos and videos",
    };
    const p = await buildInstagramPayload(
      "https://www.instagram.com/stories/some_user/123",
    );
    assert.ok(p.content.includes("Some Display"));
    assert.ok(p.content.includes("@some_user"));
  });

  // === BILIBILI API WIRING ===
  console.log("buildBilibiliPayload");

  await it("bilibili API success → custom embed + video attachment (no fixer URL)", async () => {
    _mockFetch = async (apiUrl) => {
      if (
        typeof apiUrl === "string" &&
        apiUrl.includes("/x/web-interface/view")
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: {
              title: "B站影片",
              desc: "簡介",
              pic: "http://i.example.com/cover.jpg",
              owner: { name: "UP主" },
            },
          }),
        };
      }
      throw new Error("unexpected fetch");
    };
    try {
      const p = await buildBilibiliPayload(
        "https://www.bilibili.com/video/BV1xx",
      );
      const s = shapeOf(p);
      assert.equal(s.embedCount, 1, "API success should produce custom embed");
      assert.equal(s.hasContent, false, "no URL needed when API succeeds");
      const data = p.embeds[0].data;
      assert.equal(data.title, "B站影片");
      assert.equal(data.author.name, "UP主");
      assert.ok(
        data.image.url.startsWith("https://"),
        "http image URL upgraded to https",
      );
      // API embed now ALSO carries a playable video (MIXED-style): discord-io
      // uploads media.vxbilibili's mp4 below the cover embed, degrading to the
      // cover alone on any miss. Direct mp4 URL constructed from the BVID.
      assert.equal(
        s.hasVideoAttachment,
        true,
        "API success should flag the video for upload",
      );
      assert.equal(
        s.videoAttachmentText,
        "https://media.vxbilibili.com/video/BV1xx/1",
      );
      // The fallback embed (shown if the video can't attach) keeps the cover
      // + Bilibili footer as its sole visual...
      assert.ok(data.image, "fallback embed keeps the cover image");
      assert.ok(data.footer, "fallback embed keeps the Bilibili footer");
      // ...but when the video DOES attach, discord-io swaps in this content info
      // bar (above the player): a clickable masked-link title, the caption, and
      // an author subtext — no embed box, no duplicate cover.
      const caption = p.videoAttachmentContent;
      assert.equal(typeof caption, "string", "supplies a content info bar");
      assert.ok(
        caption.includes("[B站影片](https://www.bilibili.com/video/BV1xx)"),
        `info bar title must be a clickable masked link, got: ${caption}`,
      );
      assert.ok(caption.includes("UP主"), "info bar keeps the author");
      assert.ok(
        caption.includes("-# "),
        "author/source rendered as Discord subtext",
      );
      assert.ok(
        !Array.isArray(p.videoAttachmentEmbeds),
        "content info bar replaces the old slim-embed approach",
      );
      // When the upload MISSES (e.g. video over the guild's 25 MiB cap), the
      // payload degrades to the fixer link — Discord streams vxbilibili's
      // og:video, so big videos still get a native player — with the cover
      // embed as embedFallback and OG recovery behind it.
      assert.equal(
        p.videoAttachmentMissContent,
        "https://vxbilibili.com/video/BV1xx",
        "miss must degrade to the fixer URL, not the cover embed",
      );
      assert.ok(
        p.embedFallback?.embeds?.length === 1 &&
          p.embedFallback.embeds[0].data.image,
        "cover embed rides along as the fixer's empty-unfurl fallback",
      );
      assert.ok(
        Array.isArray(p.recoverUrls) && p.recoverUrls.length >= 1,
        "OG recovery backs the miss path",
      );
    } finally {
      _mockFetch = null;
    }
  });

  await it("bilibili share-tracking params don't leak into the miss fixer URL", async () => {
    _mockFetch = async (apiUrl) => {
      if (
        typeof apiUrl === "string" &&
        apiUrl.includes("/x/web-interface/view")
      ) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 0,
            data: { title: "B站影片", desc: null, pic: null, owner: null },
          }),
        };
      }
      throw new Error("unexpected fetch");
    };
    try {
      const p = await buildBilibiliPayload(
        "https://www.bilibili.com/video/BV1xx?buvid=XUC8E44&mid=xnHnld&p=1&plat_id=116&share_from=ugc&up_id=63231",
      );
      assert.equal(
        p.videoAttachmentMissContent,
        "https://vxbilibili.com/video/BV1xx",
        "miss URL must be the minimal canonical form, not the tracking-param wall",
      );
      assert.equal(p.recoverUrls[0], "https://vxbilibili.com/video/BV1xx");
    } finally {
      _mockFetch = null;
    }
  });

  await it("bilibili API failure → fixer URL + recoverUrls", async () => {
    _mockFetch = async () => {
      throw new Error("network down");
    };
    try {
      const p = await buildBilibiliPayload(
        "https://www.bilibili.com/video/BV1xx",
      );
      const s = shapeOf(p);
      assert.equal(s.embedCount, 0);
      assert.equal(s.contentStartsWithHttp, true);
      assert.ok(s.contentText.includes("vxbilibili"));
      assert.ok(
        Array.isArray(p.recoverUrls) && p.recoverUrls.length >= 1,
        "API failure should still expose recoverUrls",
      );
    } finally {
      _mockFetch = null;
    }
  });

  // === PREVIEW DISPATCHER (preview.js) ===
  console.log("buildPreviewPayloads dispatcher");

  await it("twitter URL → fixer with recoverUrls", async () => {
    const [p] = await buildPreviewPayloads(["https://x.com/u/status/1"]);
    assert.ok(p.content.includes("fxtwitter"));
    assert.ok(Array.isArray(p.recoverUrls) && p.recoverUrls.length >= 1);
    assert.equal(p.sourceUrl, "https://x.com/u/status/1");
    assert.ok(p.recoverEmbedOptions?.footerText?.includes("X"));
  });

  await it("twitter URL → vxtwitter as fallback + first OG-recovery candidate", async () => {
    const [p] = await buildPreviewPayloads(["https://x.com/u/status/1"]);
    assert.equal(p.viewerValidation, "twitter");
    assert.deepEqual(p.fallbackContents, ["https://vxtwitter.com/u/status/1"]);
    // The primary's "unavailable" stub must not win OG recovery.
    assert.equal(p.recoverUrls[0], "https://vxtwitter.com/u/status/1");
  });

  await it("twitter payload looks up whether the post has media", async () => {
    const seen = [];
    _mockFetch = async (input) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ tweet: { media: { all: [{}] } } }));
    };
    try {
      const [p] = await buildPreviewPayloads(["https://x.com/u/status/42"]);
      assert.equal(await p.viewerRequiresMedia, true);
      assert.deepEqual(seen, ["https://api.fxtwitter.com/status/42"]);
      const [profile] = await buildPreviewPayloads(["https://x.com/u"]);
      assert.equal(await profile.viewerRequiresMedia, null);
    } finally {
      _mockFetch = null;
    }
  });

  await it("twitter embed without the post's media advances to vxtwitter", async () => {
    const edits = [];
    const target = {
      id: "twitter-media-stripped",
      embeds: [{ title: "ほんま (@honma_nmn)", description: "壁に耳あり" }],
      async fetch() {
        return this;
      },
      async edit(payload) {
        edits.push(payload);
        this.embeds = [
          {
            title: "ほんま (@honma_nmn)",
            image: { url: "https://pbs.twimg.com/a.jpg" },
          },
        ];
        return this;
      },
    };
    const result = await checkAndHandleEmptyEmbeds(
      { reply: async () => assert.fail("must not apologize") },
      [
        {
          sentMessage: target,
          isUrlOnly: true,
          fallbackContents: ["https://vxtwitter.com/honma_nmn/status/1"],
          viewerValidation: "twitter",
          viewerRequiresMedia: Promise.resolve(true),
          embedFallback: null,
          recoverUrls: null,
        },
      ],
    );
    assert.equal(result.allSucceeded, true);
    assert.deepEqual(
      edits.map((edit) => edit.content),
      ["https://vxtwitter.com/honma_nmn/status/1"],
    );
  });

  await it("multi-image X post → gallery of embeds, no download", async () => {
    _mockFetch = async () =>
      new Response(
        JSON.stringify({
          tweet: {
            text: "body",
            author: { name: "a", screen_name: "a" },
            media: {
              all: [
                { type: "photo", url: "https://pbs.twimg.com/media/a.jpg" },
                { type: "photo", url: "https://pbs.twimg.com/media/b.jpg" },
                { type: "photo", url: "https://pbs.twimg.com/media/c.jpg" },
              ],
            },
          },
        }),
      );
    try {
      const url = "https://x.com/a/status/42";
      const [p] = await buildPreviewPayloads([url]);
      assert.equal(p.content, undefined);
      assert.equal(p.spoilerImages, undefined);
      assert.equal(p.embeds.length, 3);
      // One album: Discord groups embeds that share a URL.
      assert.deepEqual(
        new Set(p.embeds.map((e) => e.data.url)),
        new Set([url]),
      );
      assert.deepEqual(
        p.embeds.map((e) => e.data.image.url),
        [
          "https://pbs.twimg.com/media/a.jpg?name=large",
          "https://pbs.twimg.com/media/b.jpg?name=large",
          "https://pbs.twimg.com/media/c.jpg?name=large",
        ],
      );
    } finally {
      _mockFetch = null;
    }
  });

  await it("equal-size X slices → gallery flagged as a panorama candidate", async () => {
    const slice = (id) => ({
      type: "photo",
      url: `https://pbs.twimg.com/media/${id}.jpg`,
      width: 1820,
      height: 4096,
    });
    _mockFetch = async () =>
      new Response(
        JSON.stringify({
          tweet: {
            author: { name: "a", screen_name: "a" },
            media: { all: ["a", "b", "c", "d"].map(slice) },
          },
        }),
      );
    try {
      const [p] = await buildPreviewPayloads(["https://x.com/a/status/42"]);
      assert.equal(p.embeds.length, 4, "gallery stays as the fallback");
      assert.deepEqual(
        p.panoramaImages,
        ["a", "b", "c", "d"].map(
          (id) => `https://pbs.twimg.com/media/${id}.jpg?name=large`,
        ),
      );
    } finally {
      _mockFetch = null;
    }
  });

  await it("mixed-size X photos are not a panorama candidate", async () => {
    _mockFetch = async () =>
      new Response(
        JSON.stringify({
          tweet: {
            author: { name: "a", screen_name: "a" },
            media: {
              all: [
                { type: "photo", url: "https://pbs.twimg.com/media/a.jpg", width: 800, height: 600 },
                { type: "photo", url: "https://pbs.twimg.com/media/b.jpg", width: 600, height: 800 },
              ],
            },
          },
        }),
      );
    try {
      const [p] = await buildPreviewPayloads(["https://x.com/a/status/42"]);
      assert.equal(p.panoramaImages, undefined);
    } finally {
      _mockFetch = null;
    }
  });

  await it("stitched panorama replaces the album with one attached image", async () => {
    const { EmbedBuilder } = require("discord.js");
    const lead = new EmbedBuilder().setDescription("body").setImage("https://a");
    const outgoing = await resolveOutgoing(
      {
        embeds: [lead, new EmbedBuilder().setImage("https://b")],
        panoramaImages: ["https://a", "https://b"],
      },
      { guild: null },
      {
        fetchPanoramaAttachment: async () => ({
          buffer: Buffer.from("img"),
          name: "panorama.jpg",
        }),
      },
    );
    assert.equal(outgoing.embeds.length, 1);
    assert.equal(outgoing.embeds[0].data.description, "body");
    assert.equal(outgoing.embeds[0].data.image.url, "attachment://panorama.jpg");
    assert.equal(outgoing.files[0].name, "panorama.jpg");
    assert.equal(outgoing.panoramaImages, undefined);
  });

  await it("panorama miss keeps the gallery untouched", async () => {
    const outgoing = await resolveOutgoing(
      { embeds: [{ a: 1 }, { b: 2 }], panoramaImages: ["https://a", "https://b"] },
      { guild: null },
      { fetchPanoramaAttachment: async () => null },
    );
    assert.equal(outgoing.embeds.length, 2);
    assert.equal(outgoing.files, undefined);
    assert.equal(outgoing.panoramaImages, undefined);
  });

  await it("stitchPanorama joins continuous slices and rejects broken seams", async () => {
    const sharp = require("sharp");
    const { stitchPanorama } = require("../src/panorama");
    // One horizontal gradient cut into two halves → continuous seam; with a
    // vertical stripe pattern so the seam columns carry texture.
    const width = 200;
    const height = 120;
    const pixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y += 1)
      for (let x = 0; x < width; x += 1) {
        const v = (x + (y % 20 < 10 ? 0 : 40)) % 256;
        pixels.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
      }
    const whole = sharp(pixels, { raw: { width, height, channels: 3 } });
    const half = (left) =>
      whole.clone().extract({ left, top: 0, width: width / 2, height }).png().toBuffer();
    const [a, b] = await Promise.all([half(0), half(width / 2)]);
    const stitched = await stitchPanorama([a, b]);
    assert.ok(stitched, "continuous halves stitch");
    const meta = await sharp(stitched).metadata();
    assert.equal(meta.width, width);
    assert.equal(await stitchPanorama([b, a]), null, "swapped halves break the seam");
    const blank = await sharp({
      create: { width: 100, height, channels: 3, background: "#fff" },
    }).png().toBuffer();
    assert.equal(await stitchPanorama([blank, blank]), null, "blank margins prove nothing");
  });

  await it("single-image and video posts stay on the fixer unfurl", async () => {
    const tweet = (all) => async () =>
      new Response(
        JSON.stringify({
          tweet: { author: { name: "a", screen_name: "a" }, media: { all } },
        }),
      );
    try {
      _mockFetch = tweet([
        { type: "photo", url: "https://pbs.twimg.com/media/a.jpg" },
      ]);
      const [single] = await buildPreviewPayloads(["https://x.com/a/status/1"]);
      assert.ok(single.content.includes("fxtwitter"));
      // A post with video keeps the fixer's playable player.
      _mockFetch = tweet([
        { type: "photo", url: "https://pbs.twimg.com/media/a.jpg" },
        { type: "video", url: "https://video.example/v.mp4" },
      ]);
      const [mixed] = await buildPreviewPayloads(["https://x.com/a/status/2"]);
      assert.ok(mixed.content.includes("fxtwitter"));
      assert.equal(mixed.embeds, undefined);
    } finally {
      _mockFetch = null;
    }
  });

  await it("sensitive X post → own spoiler card with every image", async () => {
    _mockFetch = async () =>
      new Response(
        JSON.stringify({
          tweet: {
            possibly_sensitive: true,
            text: "body",
            author: { name: "poiAI", screen_name: "poipoip01" },
            media: {
              all: [
                {
                  type: "photo",
                  url: "https://pbs.twimg.com/media/a.jpg?name=orig",
                },
                {
                  type: "photo",
                  url: "https://pbs.twimg.com/media/b.jpg?name=orig",
                },
              ],
            },
          },
        }),
      );
    try {
      const [p] = await buildPreviewPayloads([
        "https://x.com/poipoip01/status/42",
      ]);
      // No fixer link: the viewers unfurl a sensitive image in the clear.
      assert.equal(p.content, undefined);
      assert.deepEqual(p.spoilerImages, [
        "https://pbs.twimg.com/media/a.jpg?name=large",
        "https://pbs.twimg.com/media/b.jpg?name=large",
      ]);
      assert.equal(
        p.spoilerMissContent.includes("||https://vxtwitter.com"),
        true,
      );
      assert.equal(p.embeds.length, 1);
    } finally {
      _mockFetch = null;
    }
  });

  await it("sensitive post over the image cap keeps a 還有 N 張 hint", async () => {
    _mockFetch = async () =>
      new Response(
        JSON.stringify({
          tweet: {
            possibly_sensitive: true,
            author: { name: "a", screen_name: "a" },
            media: {
              all: Array.from({ length: 6 }, (_, i) => ({
                type: "photo",
                url: `https://pbs.twimg.com/media/${i}.jpg`,
              })),
            },
          },
        }),
      );
    try {
      const [p] = await buildPreviewPayloads(["https://x.com/a/status/42"]);
      assert.equal(p.spoilerImages.length, 4);
      assert.match(p.spoilerContent, /還有 2 張/);
    } finally {
      _mockFetch = null;
    }
  });

  await it("sensitive video post stays on the fixer chain", async () => {
    _mockFetch = async () =>
      new Response(
        JSON.stringify({
          tweet: {
            possibly_sensitive: true,
            author: { name: "a", screen_name: "a" },
            media: {
              all: [{ type: "video", url: "https://video.example/v.mp4" }],
            },
          },
        }),
      );
    try {
      const [p] = await buildPreviewPayloads(["https://x.com/a/status/42"]);
      assert.equal(p.spoilerImages, undefined);
      assert.ok(p.content.includes("fxtwitter"));
      assert.equal(await p.viewerRequiresMedia, true);
    } finally {
      _mockFetch = null;
    }
  });

  await it("spoiler images upload as SPOILER_ attachments", async () => {
    const outgoing = await resolveOutgoing(
      {
        embeds: [{ title: "poiAI" }],
        spoilerImages: ["https://pbs.twimg.com/media/a.jpg?name=large"],
        spoilerContent: "還有 1 張",
        spoilerMissContent: "🔞 ||https://vxtwitter.com/a/status/1||",
      },
      { guild: null },
      {
        fetchSpoilerImageAttachments: async (urls) =>
          urls.map((_, i) => ({
            buffer: Buffer.from("img"),
            name: `SPOILER_${i + 1}.jpg`,
          })),
      },
    );
    assert.equal(outgoing.files.length, 1);
    assert.equal(outgoing.files[0].name, "SPOILER_1.jpg");
    assert.equal(outgoing.embeds.length, 1);
    assert.equal(outgoing.content, "還有 1 張");
    assert.equal(outgoing.spoilerImages, undefined);
  });

  await it("spoiler upload miss falls back to a spoilered link", async () => {
    const outgoing = await resolveOutgoing(
      {
        embeds: [{ title: "poiAI" }],
        spoilerImages: ["https://pbs.twimg.com/media/a.jpg?name=large"],
        spoilerMissContent: "🔞 ||https://vxtwitter.com/a/status/1||",
      },
      { guild: null },
      { fetchSpoilerImageAttachments: async () => null },
    );
    assert.equal(outgoing.content, "🔞 ||https://vxtwitter.com/a/status/1||");
    assert.equal(outgoing.embeds, undefined);
    assert.equal(outgoing.files, undefined);
  });

  await it("multi-page pixiv work → gallery of phixiv-proxied pages", async () => {
    _mockFetch = async (input) => {
      assert.match(String(input), /ajax\/illust\/118216884/);
      return new Response(
        JSON.stringify({
          body: {
            illustId: "118216884",
            title: "白毛浮綠水",
            userName: "KaoWYK",
            pageCount: 3,
            xRestrict: 0,
            urls: {
              regular:
                "https://i.pximg.net/img-master/img/2024/04/28/17/13/43/118216884_p0_master1200.jpg",
            },
          },
        }),
      );
    };
    try {
      const url = "https://www.pixiv.net/artworks/118216884";
      const [p] = await buildPreviewPayloads([url]);
      assert.equal(p.content, undefined);
      assert.equal(p.embeds.length, 3);
      assert.deepEqual(
        new Set(p.embeds.map((e) => e.data.url)),
        new Set([url]),
      );
      // i.pximg.net needs a pixiv referer — Discord can only fetch the proxy.
      assert.deepEqual(
        p.embeds.map((e) => e.data.image.url),
        [0, 1, 2].map(
          (n) =>
            `https://www.phixiv.net/i/img-master/img/2024/04/28/17/13/43/118216884_p${n}_master1200.jpg`,
        ),
      );
    } finally {
      _mockFetch = null;
    }
  });

  await it("R-18 pixiv work → spoiler card, pages read off phixiv", async () => {
    const seen = [];
    _mockFetch = async (input) => {
      seen.push(String(input));
      if (String(input).includes("ajax/illust")) {
        return new Response(
          JSON.stringify({
            body: {
              illustId: "149784500",
              title: "るるかちゃん",
              userName: "Drs",
              pageCount: 2,
              xRestrict: 1,
              // Logged out, pixiv hides every image URL of an R-18 work.
              urls: { regular: null },
            },
          }),
        );
      }
      return new Response(
        '<meta property="og:image" content="https://phixiv.net/i/img-master/img/x/149784500_p0_master1200.jpg" />',
      );
    };
    try {
      const [p] = await buildPreviewPayloads([
        "https://www.pixiv.net/artworks/149784500",
      ]);
      assert.equal(p.content, undefined);
      assert.deepEqual(p.spoilerImages, [
        "https://phixiv.net/i/img-master/img/x/149784500_p0_master1200.jpg",
        "https://phixiv.net/i/img-master/img/x/149784500_p1_master1200.jpg",
      ]);
      assert.match(p.spoilerMissContent, /^🔞 \|\|https:\/\/phixiv/);
      assert.equal(
        seen.length,
        2,
        "ajax first, phixiv only when it hides URLs",
      );
    } finally {
      _mockFetch = null;
    }
  });

  await it("single-page all-ages pixiv work keeps the phixiv unfurl", async () => {
    _mockFetch = async () =>
      new Response(
        JSON.stringify({
          body: {
            pageCount: 1,
            xRestrict: 0,
            urls: {
              regular: "https://i.pximg.net/img-master/a_p0_master1200.jpg",
            },
          },
        }),
      );
    try {
      const [p] = await buildPreviewPayloads([
        "https://www.pixiv.net/artworks/1",
      ]);
      assert.ok(p.content.includes("phixiv"));
      assert.equal(p.embeds, undefined);
    } finally {
      _mockFetch = null;
    }
  });

  await it("pixiv lookup failure falls back to the phixiv link", async () => {
    _mockFetch = async () => new Response("nope", { status: 500 });
    try {
      const [p] = await buildPreviewPayloads([
        "https://www.pixiv.net/artworks/1",
      ]);
      assert.ok(p.content.includes("phixiv"));
      assert.ok(Array.isArray(p.recoverUrls));
    } finally {
      _mockFetch = null;
    }
  });

  await it("redd.it short URL → rxddit (regression)", async () => {
    const [p] = await buildPreviewPayloads(["https://redd.it/abc"]);
    assert.ok(
      p.content.includes("rxddit"),
      `redd.it should now route to rxddit, got: ${p.content}`,
    );
    assert.ok(Array.isArray(p.recoverUrls));
  });

  await it("pixiv URL → phixiv with recoverUrls", async () => {
    const [p] = await buildPreviewPayloads([
      "https://www.pixiv.net/artworks/1234",
    ]);
    assert.ok(p.content.includes("phixiv"));
    assert.ok(Array.isArray(p.recoverUrls));
  });

  await it("bluesky URL → bskx with recoverUrls", async () => {
    const [p] = await buildPreviewPayloads([
      "https://bsky.app/profile/x/post/1",
    ]);
    assert.ok(p.content.includes("bskx"));
    assert.ok(Array.isArray(p.recoverUrls));
  });

  await it("facebook URL → facebed with recoverUrls", async () => {
    const [p] = await buildPreviewPayloads(["https://www.facebook.com/post/1"]);
    assert.ok(p.content.includes("facebed"));
    assert.ok(Array.isArray(p.recoverUrls));
    // facebed races facebook.com itself (crawler UA, login wall rejected).
    assert.ok(p.recoverUrls[0].includes("facebed"));
    assert.equal(p.recoverUrls[1].url, "https://www.facebook.com/post/1");
    assert.equal(p.recoverUrls[1].requireOgUrl, true);
    assert.equal(p.recoverStrategy.race, true);
    assert.ok(p.recoverStrategy.timeoutMs > 6000);
  });

  await it("multiple URLs run in parallel and preserve order", async () => {
    _mockThreadsMetadata = {
      image: null,
      title: "ttitle",
      description: "tdesc",
      twitterCard: null,
      images: [],
      imageCount: 0,
      videoCount: 0,
      video: false,
    };
    const out = await buildPreviewPayloads([
      "https://x.com/u/status/1",
      "https://www.threads.net/@a/post/1",
      "https://bsky.app/profile/x/post/1",
    ]);
    assert.equal(out.length, 3);
    assert.ok(out[0].content?.includes("fxtwitter"));
    assert.equal(Array.isArray(out[1].embeds), true, "threads should be embed");
    assert.ok(out[2].content?.includes("bskx"));
  });

  // === REACTION DELETE (reaction-delete.js) ===
  // handleReactionDelete needs live Discord objects (fetchReference, member
  // fetch, permissionsFor) that pure smoke can't reach — mock them here and
  // assert the authorization matrix: only 西寶's OWN message, only by the
  // link's poster (via reply reference) or a ManageMessages mod, only on 🗑️.
  console.log("handleReactionDelete — authorization matrix");

  const DELETE_CLIENT = { user: { id: "BOT" } };

  function makeTrashReaction({
    emojiName = "🗑️",
    authorId = "BOT", // author of the reacted message (BOT = 西寶's own)
    origAuthorId = "POSTER", // author of the original message the preview replied to
    hasReference = true,
    canManage = false,
  } = {}) {
    const state = { deleted: false };
    const message = {
      partial: false,
      id: "MSG",
      author: { id: authorId },
      reference: hasReference ? { messageId: "ORIG" } : null,
      fetchReference: async () => ({ author: { id: origAuthorId } }),
      guild: {
        name: "G",
        members: { cache: new Map(), fetch: async () => ({ id: "m" }) },
      },
      channel: { name: "c", permissionsFor: () => ({ has: () => canManage }) },
      delete: async () => {
        state.deleted = true;
      },
    };
    return {
      reaction: { partial: false, emoji: { name: emojiName }, message },
      state,
    };
  }

  await it("link poster's 🗑️ deletes 西寶's own message", async () => {
    const { reaction, state } = makeTrashReaction({ origAuthorId: "POSTER" });
    await handleReactionDelete(
      reaction,
      { id: "POSTER", bot: false },
      DELETE_CLIENT,
    );
    assert.equal(state.deleted, true);
  });

  await it("random user without ManageMessages cannot delete", async () => {
    const { reaction, state } = makeTrashReaction({
      origAuthorId: "POSTER",
      canManage: false,
    });
    await handleReactionDelete(
      reaction,
      { id: "RANDO", bot: false },
      DELETE_CLIENT,
    );
    assert.equal(state.deleted, false);
  });

  await it("ManageMessages mod can delete even if not the poster", async () => {
    const { reaction, state } = makeTrashReaction({
      origAuthorId: "POSTER",
      canManage: true,
    });
    await handleReactionDelete(
      reaction,
      { id: "MOD", bot: false },
      DELETE_CLIENT,
    );
    assert.equal(state.deleted, true);
  });

  await it("bot owner deletes without being poster or mod", async () => {
    const { reaction, state } = makeTrashReaction({
      origAuthorId: "POSTER",
      canManage: false,
    });
    await handleReactionDelete(
      reaction,
      { id: "OWNER", bot: false },
      DELETE_CLIENT,
    );
    assert.equal(state.deleted, true);
  });

  await it("bot owner deletes an orphaned preview (reference gone)", async () => {
    const { reaction, state } = makeTrashReaction({
      hasReference: false,
      canManage: false,
    });
    await handleReactionDelete(
      reaction,
      { id: "OWNER", bot: false },
      DELETE_CLIENT,
    );
    assert.equal(state.deleted, true);
  });

  await it("owner privilege still never touches non-西寶 messages", async () => {
    const { reaction, state } = makeTrashReaction({ authorId: "HUMAN" });
    await handleReactionDelete(
      reaction,
      { id: "OWNER", bot: false },
      DELETE_CLIENT,
    );
    assert.equal(state.deleted, false);
  });

  await it("never deletes a message 西寶 did not author", async () => {
    const { reaction, state } = makeTrashReaction({
      authorId: "HUMAN",
      origAuthorId: "POSTER",
    });
    await handleReactionDelete(
      reaction,
      { id: "POSTER", bot: false },
      DELETE_CLIENT,
    );
    assert.equal(state.deleted, false);
  });

  await it("ignores non-🗑️ reactions", async () => {
    const { reaction, state } = makeTrashReaction({
      emojiName: "❌",
      origAuthorId: "POSTER",
    });
    await handleReactionDelete(
      reaction,
      { id: "POSTER", bot: false },
      DELETE_CLIENT,
    );
    assert.equal(state.deleted, false);
  });

  await it("ignores reactions from bots", async () => {
    const { reaction, state } = makeTrashReaction({ origAuthorId: "POSTER" });
    await handleReactionDelete(
      reaction,
      { id: "POSTER", bot: true },
      DELETE_CLIENT,
    );
    assert.equal(state.deleted, false);
  });

  // === CONTEXT MENU DELETE (commands.js) ===
  // Apps > 刪除西寶訊息 shares isAuthorizedToDelete with the 🗑️ reaction; what's
  // new here is the interaction plumbing (targetMessage + mandatory ephemeral
  // acknowledgement), so assert both the auth outcome and that every path replies.
  console.log("handleDeleteMessageContext — context menu twin");
  const { handleDeleteMessageContext } = require("../src/commands");

  function makeDeleteInteraction(messageOpts, userId) {
    const { reaction, state } = makeTrashReaction(messageOpts);
    const replies = [];
    return {
      interaction: {
        targetMessage: reaction.message,
        user: { id: userId, bot: false },
        reply: async (p) => replies.push(p),
      },
      state,
      replies,
    };
  }

  await it("context menu: owner deletes and gets an ephemeral ack", async () => {
    const { interaction, state, replies } = makeDeleteInteraction(
      { canManage: false },
      "OWNER",
    );
    await handleDeleteMessageContext(interaction, DELETE_CLIENT);
    assert.equal(state.deleted, true);
    assert.equal(replies.length, 1, "interaction must be acknowledged");
  });

  await it("context menu: poster deletes via reply reference", async () => {
    const { interaction, state } = makeDeleteInteraction(
      { origAuthorId: "POSTER" },
      "POSTER",
    );
    await handleDeleteMessageContext(interaction, DELETE_CLIENT);
    assert.equal(state.deleted, true);
  });

  await it("context menu: random user is refused but still acknowledged", async () => {
    const { interaction, state, replies } = makeDeleteInteraction(
      { canManage: false },
      "RANDO",
    );
    await handleDeleteMessageContext(interaction, DELETE_CLIENT);
    assert.equal(state.deleted, false);
    assert.equal(replies.length, 1, "refusal must still reply ephemerally");
  });

  await it("context menu: never deletes a non-西寶 message, even for owner", async () => {
    const { interaction, state, replies } = makeDeleteInteraction(
      { authorId: "HUMAN" },
      "OWNER",
    );
    await handleDeleteMessageContext(interaction, DELETE_CLIENT);
    assert.equal(state.deleted, false);
    assert.equal(replies.length, 1);
  });

  // === STICKER SEND (mention.js sendAIReply) ===
  // The catalog→payload path needs a live message.reply to assert against —
  // pure smoke can only reach extractSticker/buildStickerSendPayload in
  // isolation, not the "which of the three send shapes goes out" decision.
  console.log("");
  console.log("sendAIReply — 貼圖 attachment matrix");

  const STICKER_CATALOG = mergeStickerSources(
    [{ id: "s1", name: "起床重睡", description: "賴床", available: true }],
    new Map([
      [
        "西寶專屬",
        {
          kind: "library",
          name: "西寶專屬",
          meaning: "自帶圖庫",
          file: __filename, // any readable path — AttachmentBuilder is lazy
          basename: "xibao.png",
        },
      ],
    ]),
  );

  function makeReplyTarget({ failOnce = false } = {}) {
    const sent = [];
    let failed = false;
    return {
      sent,
      message: {
        reply: async (payload) => {
          if (failOnce && !failed && (payload.stickers || payload.files)) {
            failed = true;
            throw new Error("Unknown Sticker");
          }
          sent.push(payload);
          return { id: "SENT" };
        },
      },
    };
  }

  await it("attaches a guild sticker by id and keeps the text", async () => {
    const { message, sent } = makeReplyTarget();
    await sendAIReply(message, "欸…好啦 [貼圖:起床重睡]", STICKER_CATALOG);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].stickers, ["s1"]);
    assert.equal(sent[0].content, "欸…好啦");
    assert.equal(sent[0].files, undefined);
  });

  await it("uploads a library sticker as a file, no content when text-free", async () => {
    const { message, sent } = makeReplyTarget();
    await sendAIReply(message, "[貼圖:西寶專屬]", STICKER_CATALOG);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].files.length, 1);
    assert.equal(sent[0].files[0].name, "xibao.png");
    assert.equal(sent[0].stickers, undefined);
    assert.equal(
      sent[0].content,
      undefined,
      "sticker-only reply carries no text",
    );
  });

  await it("plain replies go out untouched", async () => {
    const { message, sent } = makeReplyTarget();
    await sendAIReply(message, "我沒有那個貼圖啦", STICKER_CATALOG);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, "我沒有那個貼圖啦");
    assert.equal(sent[0].stickers, undefined);
    assert.equal(sent[0].files, undefined);
  });

  await it("a failed sticker send retries as text-only instead of losing the reply", async () => {
    const { message, sent } = makeReplyTarget({ failOnce: true });
    await sendAIReply(message, "好啦 [貼圖:起床重睡]", STICKER_CATALOG);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].content, "好啦");
    assert.equal(
      sent[0].stickers,
      undefined,
      "second attempt drops the sticker",
    );
  });

  await it("an invented sticker name never reaches the channel", async () => {
    const { message, sent } = makeReplyTarget();
    await sendAIReply(message, "哈哈 [貼圖:我亂編的]", STICKER_CATALOG);
    assert.equal(sent[0].content, "哈哈");
    assert.equal(sent[0].stickers, undefined);
  });

  await it("a reply that was ONLY a bad sticker token falls back to a spoken line", async () => {
    const { message, sent } = makeReplyTarget();
    await sendAIReply(message, "[貼圖:我亂編的]", STICKER_CATALOG);
    assert.equal(sent.length, 1);
    assert.ok(
      STICKER_MISS_REPLIES.includes(sent[0].content),
      `expected a STICKER_MISS_REPLIES line, got ${JSON.stringify(sent[0].content)}`,
    );
  });

  console.log("");
  console.log(`Result: ${pass} passed, ${fail} failed`);

  // Cleanup background timers so process exits cleanly
  try {
    require("../src/ai/memory").stopMemorySweepTimer();
  } catch {}
  process.exit(fail > 0 ? 1 : 0);
})();
