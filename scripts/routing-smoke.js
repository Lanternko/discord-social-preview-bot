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

  await it("multi-image with imageCount > images.length (fallback) → 1 embed + button", async () => {
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
    assert.equal(s.hasComponents, true);
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

  await it("probe error → fixer URL fallback", async () => {
    _mockProbeError = new Error("probe boom");
    try {
      const p = await buildThreadsPayload(THREADS_URL);
      const s = shapeOf(p);
      assert.equal(s.contentStartsWithHttp, true);
      assert.ok(s.contentText.includes("fixthreads"));
      assert.equal(s.embedCount, 0);
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

  await it("bahamut restricted → fallback fixer URL", async () => {
    _mockPageMetadata = {
      title: "x",
      description: "y",
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

  console.log("");
  console.log(`Result: ${pass} passed, ${fail} failed`);

  // Cleanup background timers so process exits cleanly
  try {
    require("../src/ai/memory").stopMemorySweepTimer();
  } catch {}
  process.exit(fail > 0 ? 1 : 0);
})();
