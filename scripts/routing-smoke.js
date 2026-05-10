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

// === MOCK SETUP ===
// Pre-require the modules whose exports we need to override, then poke their
// cached exports so downstream requires see the mocks.
const probeModulePath = require.resolve("../src/probe");
require(probeModulePath);
let _mockThreadsMetadata = null;
let _mockPageMetadata = null;
let _mockProbeError = null;
require.cache[probeModulePath].exports.fetchThreadsMetadata = async () => {
  if (_mockProbeError) throw _mockProbeError;
  return _mockThreadsMetadata;
};
require.cache[probeModulePath].exports.fetchPageProbeMetadata = async () => {
  if (_mockProbeError) throw _mockProbeError;
  return _mockPageMetadata;
};

// Mock global fetch for Bilibili API + b23.tv expansion + Instagram display name
const _origFetch = global.fetch;
let _mockFetch = null;
global.fetch = async (...args) => {
  if (_mockFetch) return _mockFetch(...args);
  return _origFetch(...args);
};

const { buildThreadsPayload } = require("../src/platforms/threads");
const { buildInstagramPayload } = require("../src/platforms/instagram");
const { buildBahamutPayload } = require("../src/platforms/bahamut");
const { buildPttPayload } = require("../src/platforms/ptt");
const { buildBilibiliPayload } = require("../src/platforms/bilibili");
const { buildPreviewPayloads } = require("../src/preview");

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
    hasComponents: Array.isArray(payload.components) && payload.components.length > 0,
    hasFallbackContent: typeof payload.fallbackContent === "string",
    hasEmbedFallback: payload.embedFallback != null,
  };
}

// === THREADS CASES ===
const THREADS_URL = "https://www.threads.net/@a/post/1";

(async () => {
  console.log("buildThreadsPayload — branch coverage");

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
    assert.equal(s.hasComponents, false, "no button — rely on embed URL instead");
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

  // CRITICAL CASE — this is the regression that bit twice in PR #15.
  await it("MIXED: multi-image AND video → carousel wins (NOT video fixer)", async () => {
    _mockThreadsMetadata = {
      image: "https://x/1.jpg",
      title: "t",
      description: "d",
      twitterCard: "summary_large_image",
      images: ["https://x/1.jpg", "https://x/2.jpg"],
      imageCount: 2,
      videoCount: 1,
      video: true,
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    assert.equal(s.embedCount, 2, "should produce 2 carousel embeds");
    assert.equal(s.hasContent, false, "MUST NOT route to video fixer");
    assert.equal(s.hasFallbackContent, false);
    assert.equal(s.hasEmbedFallback, false);
    assert.equal(s.hasComponents, false, "no button — description hint only");
    const lastDesc = p.embeds[p.embeds.length - 1].data?.description;
    assert.ok(
      typeof lastDesc === "string" && lastDesc.includes("影片"),
      `last embed should hint video presence, got: ${lastDesc}`,
    );
  });

  await it("video only (no multi-image) → fixer URL + fallback chain", async () => {
    _mockThreadsMetadata = {
      image: "https://x/thumb.jpg",
      title: "t",
      description: "d",
      twitterCard: "player",
      images: [],
      imageCount: 0,
      videoCount: 1,
      video: true,
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    assert.equal(s.contentStartsWithHttp, true);
    assert.ok(s.contentText.includes("fixthreads"), "primary fixer present");
    assert.equal(s.hasFallbackContent, true);
    assert.equal(s.hasEmbedFallback, true);
    assert.ok(
      Array.isArray(p.recoverUrls) && p.recoverUrls.length === 2,
      "video branch should expose recoverUrls",
    );
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
      video: true,
    };
    const p = await buildThreadsPayload(THREADS_URL);
    const s = shapeOf(p);
    assert.equal(s.contentStartsWithHttp, true);
    assert.ok(
      s.contentText.includes("fixthreads"),
      "MUST route to video fixer, not text-only embed",
    );
    assert.equal(s.hasFallbackContent, true);
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

  await it("probe error → primary + secondary fixer + OG recovery list", async () => {
    _mockProbeError = new Error("probe boom");
    try {
      const p = await buildThreadsPayload(THREADS_URL);
      const s = shapeOf(p);
      assert.equal(s.contentStartsWithHttp, true);
      assert.ok(s.contentText.includes("fixthreads"));
      assert.equal(s.embedCount, 0);
      assert.equal(
        s.hasFallbackContent,
        true,
        "probe failure should still expose secondary fixer",
      );
      assert.ok(
        Array.isArray(p.recoverUrls) && p.recoverUrls.length === 2,
        "probe failure should expose recoverUrls for OG fallback",
      );
    } finally {
      _mockProbeError = null;
    }
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

  await it("instagram post → primary fixer + fallbackContent + embedFallback", async () => {
    const p = await buildInstagramPayload("https://www.instagram.com/p/ABC/");
    const s = shapeOf(p);
    assert.equal(s.contentStartsWithHttp, true);
    assert.ok(s.contentText.includes("ddinstagram"));
    assert.equal(s.hasFallbackContent, true);
    assert.equal(s.hasEmbedFallback, true);
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

  await it("bilibili API success → custom embed (no fixer URL)", async () => {
    _mockFetch = async (apiUrl) => {
      if (typeof apiUrl === "string" && apiUrl.includes("/x/web-interface/view")) {
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
    const [p] = await buildPreviewPayloads([
      "https://www.facebook.com/post/1",
    ]);
    assert.ok(p.content.includes("facebed"));
    assert.ok(Array.isArray(p.recoverUrls));
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

  console.log("");
  console.log(`Result: ${pass} passed, ${fail} failed`);

  // Cleanup background timers so process exits cleanly
  try {
    require("../src/ai/memory").stopMemorySweepTimer();
  } catch {}
  process.exit(fail > 0 ? 1 : 0);
})();
