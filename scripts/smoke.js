#!/usr/bin/env node
// Smoke test for pure-function refactor verification.
// Exits non-zero on any assertion failure. Run before AND after the refactor;
// outputs must match.
//
// Usage: node scripts/smoke.js

const assert = require("node:assert/strict");

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "smoke-dummy";

const {
  normalizeUrl,
  extractSupportedUrls,
  replaceHostFixer,
  buildFallbackUrl,
  isThreadsUrl,
  isInstagramUrl,
  isInstagramStoryUrl,
  extractInstagramStoryOwner,
  isBilibiliUrl,
  isBahamutUrl,
  isPttUrl,
  extractBilibiliBvid,
  shouldIgnoreMessage,
} = require("../src/url-routing");

const { trimDescription, pickRandom } = require("../src/utils");

const { buildUserTurn, buildOpenAIMessages, buildGeminiContents } =
  require("../src/ai/persona");

const { isValidTier } = require("../src/tier-store");
const {
  TIERS,
  TIER_UI_LABELS,
  buildPersonaFromTemplate,
  getTierConfig,
} = require("../src/tier-config");

let pass = 0;
let fail = 0;
function it(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

console.log("normalizeUrl");
it("strips fbclid", () => {
  assert.equal(
    normalizeUrl("https://example.com/x?fbclid=abc"),
    "https://example.com/x",
  );
});
it("strips utm_*", () => {
  assert.equal(
    normalizeUrl("https://example.com/?utm_source=a&utm_medium=b&keep=1"),
    "https://example.com/?keep=1",
  );
});
it("strips Twitter t/s on x.com", () => {
  assert.equal(
    normalizeUrl("https://x.com/u/status/1?t=abc&s=def"),
    "https://x.com/u/status/1",
  );
});
it("keeps t on YouTube (timestamp)", () => {
  assert.equal(
    normalizeUrl("https://www.youtube.com/watch?v=abc&t=120"),
    "https://www.youtube.com/watch?v=abc&t=120",
  );
});
it("strips si on YouTube", () => {
  assert.equal(
    normalizeUrl("https://www.youtube.com/watch?v=abc&si=xyz"),
    "https://www.youtube.com/watch?v=abc",
  );
});
it("strips Instagram igsh", () => {
  assert.equal(
    normalizeUrl("https://www.instagram.com/p/ABC/?igsh=xyz"),
    "https://www.instagram.com/p/ABC/",
  );
});
it("strips Bilibili spm_id_from", () => {
  assert.equal(
    normalizeUrl(
      "https://www.bilibili.com/video/BV1xx?spm_id_from=666&unique_k=foo",
    ),
    "https://www.bilibili.com/video/BV1xx",
  );
});
it("does not strip s on YouTube", () => {
  assert.equal(
    normalizeUrl("https://www.youtube.com/watch?v=abc&s=keep"),
    "https://www.youtube.com/watch?v=abc&s=keep",
  );
});

console.log("extractSupportedUrls");
it("returns Threads URL with tracking stripped", () => {
  assert.deepEqual(
    extractSupportedUrls(
      "check this https://www.threads.net/@a/post/123?fbclid=x out",
    ),
    ["https://www.threads.net/@a/post/123"],
  );
});
it("ignores unsupported hosts", () => {
  assert.deepEqual(
    extractSupportedUrls("https://example.com/foo https://x.com/u/status/1"),
    ["https://x.com/u/status/1"],
  );
});
it("dedups identical normalized URLs", () => {
  assert.deepEqual(
    extractSupportedUrls(
      "https://x.com/u/status/1?fbclid=a https://x.com/u/status/1",
    ),
    ["https://x.com/u/status/1"],
  );
});
it("handles no URLs", () => {
  assert.deepEqual(extractSupportedUrls("plain text"), []);
});
it("handles multiple supported URLs", () => {
  const result = extractSupportedUrls(
    "https://x.com/u/1 and https://www.reddit.com/r/foo",
  );
  assert.deepEqual(result, [
    "https://x.com/u/1",
    "https://www.reddit.com/r/foo",
  ]);
});

console.log("replaceHostFixer");
it("swaps host, keeps path/query", () => {
  assert.equal(
    replaceHostFixer("https://x.com/u/status/1?foo=bar", "fxtwitter.com"),
    "https://fxtwitter.com/u/status/1?foo=bar",
  );
});

console.log("buildFallbackUrl");
it("twitter -> fxtwitter", () => {
  assert.equal(
    buildFallbackUrl("https://x.com/u/status/1"),
    "https://fxtwitter.com/u/status/1",
  );
});
it("threads -> fixthreads", () => {
  assert.equal(
    buildFallbackUrl("https://www.threads.net/@a/post/1"),
    "https://fixthreads.seria.moe/@a/post/1",
  );
});
it("instagram -> ddinstagram", () => {
  assert.equal(
    buildFallbackUrl("https://www.instagram.com/p/ABC/"),
    "https://ddinstagram.com/p/ABC/",
  );
});
it("reddit -> rxddit", () => {
  assert.equal(
    buildFallbackUrl("https://www.reddit.com/r/x/1"),
    "https://rxddit.com/r/x/1",
  );
});
it("bluesky -> bskx", () => {
  assert.equal(
    buildFallbackUrl("https://bsky.app/profile/x"),
    "https://bskx.app/profile/x",
  );
});
it("bilibili -> vxbilibili", () => {
  assert.equal(
    buildFallbackUrl("https://www.bilibili.com/video/BV1xx"),
    "https://vxbilibili.com/video/BV1xx",
  );
});
it("facebook -> facebed", () => {
  assert.equal(
    buildFallbackUrl("https://www.facebook.com/post/1"),
    "https://facebed.com/post/1",
  );
});
it("unsupported -> fixembed wrapper", () => {
  assert.equal(
    buildFallbackUrl("https://example.com/foo"),
    "https://fixembed.app/embed?url=" +
      encodeURIComponent("https://example.com/foo"),
  );
});

console.log("isXxxUrl predicates");
it("isThreadsUrl", () => {
  assert.equal(isThreadsUrl("https://www.threads.net/x"), true);
  assert.equal(isThreadsUrl("https://example.com"), false);
});
it("isInstagramUrl", () => {
  assert.equal(isInstagramUrl("https://www.instagram.com/p/x/"), true);
  assert.equal(isInstagramUrl("https://example.com"), false);
});
it("isInstagramStoryUrl detects /stories/", () => {
  assert.equal(
    isInstagramStoryUrl("https://www.instagram.com/stories/foo/123"),
    true,
  );
  assert.equal(
    isInstagramStoryUrl("https://www.instagram.com/p/abc/"),
    false,
  );
});
it("extractInstagramStoryOwner", () => {
  assert.equal(
    extractInstagramStoryOwner("https://www.instagram.com/stories/foo/123"),
    "foo",
  );
  assert.equal(
    extractInstagramStoryOwner("https://www.instagram.com/stories/bar"),
    "bar",
  );
  assert.equal(
    extractInstagramStoryOwner("https://www.instagram.com/p/abc"),
    null,
  );
});
it("isBilibiliUrl / isBahamutUrl / isPttUrl", () => {
  assert.equal(isBilibiliUrl("https://www.bilibili.com/video/BV1"), true);
  assert.equal(isBilibiliUrl("https://b23.tv/x"), true);
  assert.equal(isBahamutUrl("https://forum.gamer.com.tw/foo"), true);
  assert.equal(isPttUrl("https://www.ptt.cc/bbs/X/M.123.html"), true);
  assert.equal(isPttUrl("https://example.com"), false);
});
it("extractBilibiliBvid", () => {
  assert.equal(
    extractBilibiliBvid("https://www.bilibili.com/video/BV1xx2yy/"),
    "BV1xx2yy",
  );
  assert.equal(extractBilibiliBvid("https://www.bilibili.com/foo"), null);
});

console.log("shouldIgnoreMessage");
it("ignores bot authors", () => {
  assert.equal(
    shouldIgnoreMessage({ author: { bot: true }, content: "hi" }),
    true,
  );
});
it("ignores nopreview marker", () => {
  assert.equal(
    shouldIgnoreMessage({ author: { bot: false }, content: "x nopreview y" }),
    true,
  );
});
it("ignores fxignore marker", () => {
  assert.equal(
    shouldIgnoreMessage({ author: { bot: false }, content: "FXIGNORE" }),
    true,
  );
});
it("does not ignore plain text", () => {
  assert.equal(
    shouldIgnoreMessage({ author: { bot: false }, content: "plain" }),
    false,
  );
});

console.log("trimDescription");
it("returns input shorter than limit unchanged", () => {
  assert.equal(trimDescription("hi", 100), "hi");
});
it("truncates and adds ellipsis", () => {
  assert.equal(trimDescription("aaaaaaaa", 5), "aaaa…");
});
it("handles null", () => {
  assert.equal(trimDescription(null, 5), null);
});
it("handles empty string", () => {
  assert.equal(trimDescription("", 5), "");
});

console.log("pickRandom");
it("returns one of array elements", () => {
  for (let i = 0; i < 20; i++) {
    const arr = ["a", "b", "c"];
    assert.ok(arr.includes(pickRandom(arr)));
  }
});

console.log("buildUserTurn");
it("wraps with sender XML when text present", () => {
  const msg = { author: { username: "alice", globalName: null }, member: null };
  assert.equal(
    buildUserTurn(msg, "hello"),
    '<sender name="alice"/>\nhello',
  );
});
it("uses member.displayName preferentially", () => {
  const msg = {
    author: { username: "alice", globalName: "Alice G" },
    member: { displayName: "ServerNick" },
  };
  assert.equal(
    buildUserTurn(msg, "hi"),
    '<sender name="ServerNick"/>\nhi',
  );
});
it("falls back to globalName then username", () => {
  const msg1 = {
    author: { username: "alice", globalName: "Alice G" },
    member: null,
  };
  assert.equal(buildUserTurn(msg1, "x"), '<sender name="Alice G"/>\nx');
  const msg2 = { author: { username: "bob" }, member: null };
  assert.equal(buildUserTurn(msg2, "x"), '<sender name="bob"/>\nx');
});
it("uses placeholder when text empty", () => {
  const msg = { author: { username: "alice" }, member: null };
  assert.match(buildUserTurn(msg, ""), /^<sender name="alice"\/>\n（這個人 @ 了你/);
});
it("falls back to 使用者 when all names missing", () => {
  const msg = { author: {}, member: null };
  assert.equal(buildUserTurn(msg, "x"), '<sender name="使用者"/>\nx');
});

console.log("buildOpenAIMessages");
it("prepends system message with supplied persona", () => {
  const msgs = buildOpenAIMessages(
    [{ role: "user", content: "hi" }],
    "you are 西寶",
  );
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs[0].content, "you are 西寶");
  assert.deepEqual(msgs[1], { role: "user", content: "hi" });
});

console.log("buildGeminiContents");
it("maps assistant -> model and wraps as parts", () => {
  const turns = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "嗯…" },
  ];
  assert.deepEqual(buildGeminiContents(turns), [
    { role: "user", parts: [{ text: "hi" }] },
    { role: "model", parts: [{ text: "嗯…" }] },
  ]);
});

console.log("tier-store");
it("isValidTier accepts brief/standard/detailed", () => {
  assert.ok(isValidTier("brief"));
  assert.ok(isValidTier("standard"));
  assert.ok(isValidTier("detailed"));
});
it("isValidTier rejects unknown", () => {
  assert.ok(!isValidTier("xyz"));
  assert.ok(!isValidTier(undefined));
});

console.log("tier-config");
it("buildPersonaFromTemplate substitutes all placeholders", () => {
  const template =
    "headline {SENTENCE_MIN}~{SENTENCE_MAX} A {A_MIN}~{A_MAX} A+ {A_PLUS_MIN}~{A_PLUS_MAX} B {B_MIN}~{B_MAX} E {E_MAX}";
  const out = buildPersonaFromTemplate(template, TIERS.detailed);
  assert.equal(out, "headline 3~15 A 5~8 A+ 10~15 B 3~5 E 15");
});
it("getTierConfig defaults to brief when guildId missing", () => {
  const cfg = getTierConfig(undefined);
  assert.equal(cfg.tier, "brief");
  assert.equal(cfg.memoryMaxTurns, TIERS.brief.memoryMaxTurns);
  assert.equal(cfg.label, TIER_UI_LABELS.brief);
  assert.ok(typeof cfg.persona === "string" && cfg.persona.length > 0);
  for (const placeholder of [
    "{SENTENCE_MIN}",
    "{SENTENCE_MAX}",
    "{A_MIN}",
    "{A_MAX}",
    "{A_PLUS_MIN}",
    "{A_PLUS_MAX}",
    "{B_MIN}",
    "{B_MAX}",
    "{E_MAX}",
  ]) {
    assert.ok(
      !cfg.persona.includes(placeholder),
      `persona still contains ${placeholder}`,
    );
  }
});
it("TIERS entries carry required fields", () => {
  for (const key of ["brief", "standard", "detailed"]) {
    const t = TIERS[key];
    assert.ok(t, `missing tier ${key}`);
    for (const field of [
      "memoryMaxTurns",
      "maxReplyChars",
      "maxTokens",
      "sentenceMin",
      "sentenceMax",
      "aMin",
      "aMax",
      "aPlusMin",
      "aPlusMax",
      "bMin",
      "bMax",
      "eMax",
    ]) {
      assert.equal(typeof t[field], "number", `${key}.${field} not a number`);
    }
    assert.equal(typeof t.vision, "boolean");
  }
});
it("detailed tier expands A+ beyond brief", () => {
  assert.ok(TIERS.detailed.aPlusMax > TIERS.brief.aPlusMax);
  assert.ok(TIERS.detailed.aMax > TIERS.brief.aMax);
  assert.ok(TIERS.detailed.eMax > TIERS.brief.eMax);
});

console.log("");
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
