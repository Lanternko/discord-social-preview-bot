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

const {
  formatGroupMessage,
  buildGroupContextBlock,
} = require("../src/ai/group-context");

const {
  tierLabel: familiarityTierLabel,
  recordMessage: recordFamiliarityMessage,
  getFamiliarityRoster,
  buildFamiliarityBlock,
  resetCacheForTests: resetFamiliarityForTests,
} = require("../src/familiarity");

const { isValidTier } = require("../src/tier-store");
const {
  TIERS,
  TIER_UI_LABELS,
  buildPersonaFromTemplate,
  getTierConfig,
} = require("../src/tier-config");

const { buildPermissionDebugMessage } = require("../src/commands");
const { getMissingChannelPermissions } = require("../src/discord-io");

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

console.log("formatGroupMessage");
it("formats text-only message with member displayName", () => {
  assert.equal(
    formatGroupMessage({
      content: "hello",
      author: { username: "alice" },
      member: { displayName: "Server Nick" },
      stickers: { size: 0, map: () => [] },
      attachments: { size: 0 },
    }),
    "[Server Nick]: hello",
  );
});
it("falls back to globalName then username", () => {
  assert.equal(
    formatGroupMessage({
      content: "hi",
      author: { username: "alice", globalName: "Alice G" },
      member: null,
      stickers: { size: 0, map: () => [] },
      attachments: { size: 0 },
    }),
    "[Alice G]: hi",
  );
  assert.equal(
    formatGroupMessage({
      content: "hi",
      author: { username: "bob" },
      member: null,
      stickers: { size: 0, map: () => [] },
      attachments: { size: 0 },
    }),
    "[bob]: hi",
  );
});
it("appends sticker name with no text content", () => {
  assert.equal(
    formatGroupMessage({
      content: "",
      author: { username: "bob" },
      member: null,
      stickers: { size: 1, map: (fn) => [fn({ name: "起床重睡" })] },
      attachments: { size: 0 },
    }),
    "[bob]: (貼圖：起床重睡)",
  );
});
it("notes attachments alongside text", () => {
  assert.equal(
    formatGroupMessage({
      content: "look",
      author: { username: "bob" },
      member: null,
      stickers: { size: 0, map: () => [] },
      attachments: { size: 1 },
    }),
    "[bob]: look (附件)",
  );
});
it("returns null for fully empty message", () => {
  assert.equal(
    formatGroupMessage({
      content: "",
      author: { username: "bob" },
      member: null,
      stickers: { size: 0, map: () => [] },
      attachments: { size: 0 },
    }),
    null,
  );
});
it("falls back to 未知 when all names missing", () => {
  assert.equal(
    formatGroupMessage({
      content: "x",
      author: {},
      member: null,
      stickers: { size: 0, map: () => [] },
      attachments: { size: 0 },
    }),
    "[未知]: x",
  );
});

console.log("buildGroupContextBlock");
it("returns empty string for empty/null", () => {
  assert.equal(buildGroupContextBlock([]), "");
  assert.equal(buildGroupContextBlock(null), "");
  assert.equal(buildGroupContextBlock(undefined), "");
});
it("wraps lines under header", () => {
  const out = buildGroupContextBlock(["[a]: hi", "[b]: yo"]);
  assert.match(out, /^\n\n## 最近群組對話/);
  assert.ok(out.includes("[a]: hi"));
  assert.ok(out.includes("[b]: yo"));
});

console.log("familiarity.tierLabel");
it("maps thresholds to tier names", () => {
  assert.equal(familiarityTierLabel(500), "摯友");
  assert.equal(familiarityTierLabel(99999), "摯友");
  assert.equal(familiarityTierLabel(100), "老朋友");
  assert.equal(familiarityTierLabel(499), "老朋友");
  assert.equal(familiarityTierLabel(20), "熟人");
  assert.equal(familiarityTierLabel(99), "熟人");
  assert.equal(familiarityTierLabel(5), "認識");
  assert.equal(familiarityTierLabel(19), "認識");
  assert.equal(familiarityTierLabel(1), "剛認識");
  assert.equal(familiarityTierLabel(4), "剛認識");
  assert.equal(familiarityTierLabel(0), null);
});

console.log("familiarity.recordMessage / getFamiliarityRoster");
// Use unique guildIds (timestamped) so tests never collide with real local
// data/familiarity.json data the developer may have accumulated.
it("records and returns roster sorted by count desc with tier labels", () => {
  resetFamiliarityForTests();
  const g = "smoke-record-" + Date.now();
  for (let i = 0; i < 3; i++) recordFamiliarityMessage(g, "u1", "Alice");
  for (let i = 0; i < 7; i++) recordFamiliarityMessage(g, "u2", "Bob");
  for (let i = 0; i < 25; i++) recordFamiliarityMessage(g, "u3", "Carol");

  const roster = getFamiliarityRoster(g);
  assert.equal(roster.length, 3);
  assert.equal(roster[0].name, "Carol");
  assert.equal(roster[0].count, 25);
  assert.equal(roster[0].tier, "熟人");
  assert.equal(roster[1].name, "Bob");
  assert.equal(roster[1].tier, "認識");
  assert.equal(roster[2].name, "Alice");
  assert.equal(roster[2].tier, "剛認識");
});
it("returns [] for missing or unknown guildId", () => {
  assert.deepEqual(getFamiliarityRoster(undefined), []);
  assert.deepEqual(getFamiliarityRoster(null), []);
  assert.deepEqual(getFamiliarityRoster(""), []);
  assert.deepEqual(
    getFamiliarityRoster("never-seen-" + Date.now()),
    [],
  );
});
it("recordMessage with missing guildId/userId is a no-op (no throw)", () => {
  resetFamiliarityForTests();
  recordFamiliarityMessage(null, "u1", "x");
  recordFamiliarityMessage("g", null, "x");
  recordFamiliarityMessage(undefined, undefined, "x");
});
it("updates displayName on subsequent records", () => {
  resetFamiliarityForTests();
  const g = "smoke-rename-" + Date.now();
  recordFamiliarityMessage(g, "u1", "OldName");
  recordFamiliarityMessage(g, "u1", "NewName");
  const roster = getFamiliarityRoster(g);
  assert.equal(roster[0].name, "NewName");
  assert.equal(roster[0].count, 2);
});
it("caps roster at the top 20 talkers", () => {
  resetFamiliarityForTests();
  const g = "smoke-cap-" + Date.now();
  for (let i = 0; i < 30; i++) {
    recordFamiliarityMessage(g, `u${i}`, `User${i}`);
  }
  const roster = getFamiliarityRoster(g);
  assert.ok(
    roster.length <= 20,
    `roster length ${roster.length} exceeds ROSTER_LIMIT 20`,
  );
});

console.log("familiarity.buildFamiliarityBlock");
it("returns empty string for empty/null", () => {
  assert.equal(buildFamiliarityBlock([]), "");
  assert.equal(buildFamiliarityBlock(null), "");
  assert.equal(buildFamiliarityBlock(undefined), "");
});
it("groups by tier in canonical order with header", () => {
  const out = buildFamiliarityBlock([
    { name: "C", count: 25, tier: "熟人" },
    { name: "A", count: 600, tier: "摯友" },
    { name: "B", count: 25, tier: "熟人" },
  ]);
  assert.match(out, /^\n\n## 群友熟悉度/);
  const aIdx = out.indexOf("摯友");
  const cIdx = out.indexOf("熟人");
  assert.ok(
    aIdx >= 0 && cIdx >= 0 && aIdx < cIdx,
    `摯友 should appear before 熟人; got ${out}`,
  );
  assert.ok(out.includes("A"));
  assert.ok(out.includes("B"));
  assert.ok(out.includes("C"));
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
it("brief has no group context, standard/detailed do", () => {
  assert.equal(TIERS.brief.groupContextCount, 0);
  assert.ok(TIERS.standard.groupContextCount > 0);
  assert.ok(TIERS.detailed.groupContextCount > 0);
});

console.log("");
console.log("debug-perms null-guild guard");
it("buildPermissionDebugMessage returns DM message when not in guild", () => {
  const msg = buildPermissionDebugMessage({ inGuild: () => false });
  assert.match(msg, /只能在伺服器/);
});
it("buildPermissionDebugMessage handles inGuild()=true with guild=null without throwing", () => {
  // Reproduces the prod crash: Discord delivered an interaction whose
  // guildId was set (so inGuild() returns true) but the bot's cache had
  // no entry for that guild, so .guild was null. Reading .guild.members
  // used to throw and bring the whole process down.
  const msg = buildPermissionDebugMessage({
    inGuild: () => true,
    guild: null,
    guildId: "999",
    channelId: "888",
  });
  assert.match(msg, /只能在伺服器/);
});
it("getMissingChannelPermissions returns sentinel when guild is null", () => {
  const result = getMissingChannelPermissions({
    inGuild: () => true,
    guild: null,
  });
  assert.deepEqual(result, ["GuildUnavailable"]);
});

console.log("");
console.log(`Result: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
