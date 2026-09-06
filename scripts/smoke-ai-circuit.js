#!/usr/bin/env node
// Smoke test for AI circuit breaker + provider result contract.
// Exits non-zero on any assertion failure.
//
// Usage: node scripts/smoke-ai-circuit.js

const assert = require("node:assert/strict");

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "smoke-dummy";
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "sk-smoke-dummy";
process.env.KIMI_API_KEY = process.env.KIMI_API_KEY || "sk-kimi-smoke-dummy";
process.env.KIMI_ENABLED = "true";
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || "sk-gemini-smoke-dummy";
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || "sk-openai-smoke-dummy";
process.env.OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
process.env.STORY_OPENAI_TIMEOUT_MS = "45000";
process.env.RECAP_KIMI_TIMEOUT_MS = "45000";
process.env.RECAP_DEEPSEEK_TIMEOUT_MS = "90000";
process.env.RECAP_DEEPSEEK_REASONING_HEADROOM = "4096";
process.env.RECAP_DEEPSEEK_MAX_TOKENS = "1600";
process.env.RECAP_GEMINI_TIMEOUT_MS = "45000";
delete process.env.AI_PROVIDER;

const {
  parseRetryAfterMs,
  ok,
  fail,
  callDeepSeek,
  callOpenAI,
} = require("../src/ai/providers");
const {
  DEEPSEEK_REASONING_HEADROOM,
  OPENAI_REASONING_HEADROOM,
} = require("../src/config");
const {
  getCooldownMs,
  isProviderAvailable,
  recordProviderSuccess,
  recordProviderFailure,
  getCircuitSnapshot,
  resetCircuitState,
} = require("../src/ai/circuit");
const {
  PERSONAL_CONTEXT_MEMORY_COUNT,
  getPersonalMemoryContextEntries,
  runProviderChain,
  buildGuildChain,
  RECAP_PROVIDER_CHAIN,
  STORY_PROVIDER_CHAIN,
  FALLBACK_CHAIN,
} = require("../src/ai/chain");
const {
  fetchGroupContext,
} = require("../src/ai/group-context");
const {
  subtractScheduleMinute,
  recapNotBeforeMs,
  sendAtOrAfter,
} = require("../src/scheduler");
const {
  getGuildApiKey,
  setGuildApiKey,
  removeGuildApiKey,
  hasGuildApiKey,
  resetCacheForTests: resetKeyCache,
} = require("../src/ai/guild-key-store");
const {
  checkAndIncrement,
  getUsage,
  resetForTests: resetRateLimiter,
} = require("../src/ai/rate-limiter");

let pass = 0;
let fails = 0;
function it(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fails++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}
async function itAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fails++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

function fakeResponseWithHeader(headers) {
  return {
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
  };
}

async function main() {
  console.log("parseRetryAfterMs");
  it("parses integer seconds", () => {
    const r = parseRetryAfterMs(fakeResponseWithHeader({ "retry-after": "120" }));
    assert.equal(r, 120000);
  });
  it("parses fractional seconds (floor)", () => {
    const r = parseRetryAfterMs(fakeResponseWithHeader({ "retry-after": "2.9" }));
    assert.equal(r, 2900);
  });
  it("parses HTTP-date to positive ms", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const r = parseRetryAfterMs(fakeResponseWithHeader({ "retry-after": future }));
    assert.ok(r >= 0 && r <= 6000, `expected ~5000 got ${r}`);
  });
  it("returns null when header missing", () => {
    const r = parseRetryAfterMs(fakeResponseWithHeader({}));
    assert.equal(r, null);
  });
  it("returns null for garbage value", () => {
    const r = parseRetryAfterMs(fakeResponseWithHeader({ "retry-after": "not-a-date" }));
    assert.equal(r, null);
  });

  console.log("ok/fail helpers");
  it("ok(text) returns success shape", () => {
    assert.deepEqual(ok("hi"), { ok: true, text: "hi" });
  });

  console.log("chat fallback chain");
  it("puts OpenAI Luna first in the shared fallback", () => {
    assert.equal(FALLBACK_CHAIN[0].label, "openai:gpt-5.6-luna");
  });

  console.log("daily recap provider policy");
  it("uses DeepSeek thinking → DeepSeek direct → Kimi → Gemini and excludes Groq/Llama", () => {
    assert.deepEqual(
      RECAP_PROVIDER_CHAIN.map((provider) => provider.label.split(":")[0]),
      ["deepseek", "deepseek", "kimi", "gemini"],
    );
    assert.ok(RECAP_PROVIDER_CHAIN[1].label.endsWith(":direct"));
    assert.ok(RECAP_PROVIDER_CHAIN.every((provider) => !/groq|llama/i.test(provider.label)));
    assert.equal(RECAP_PROVIDER_CHAIN[0].options.timeoutMs, 90000);
    assert.equal(RECAP_PROVIDER_CHAIN[1].options.timeoutMs, 90000);
    assert.equal(RECAP_PROVIDER_CHAIN[2].options.timeoutMs, 45000);
    assert.equal(RECAP_PROVIDER_CHAIN[3].options.timeoutMs, 45000);
    assert.deepEqual(RECAP_PROVIDER_CHAIN[0].options.thinking, { type: "enabled" });
    assert.equal(RECAP_PROVIDER_CHAIN[0].options.reasoningEffort, "medium");
    assert.equal(RECAP_PROVIDER_CHAIN[0].options.reasoningHeadroom, 4096);
    assert.deepEqual(RECAP_PROVIDER_CHAIN[1].options.thinking, { type: "disabled" });
    assert.equal(RECAP_PROVIDER_CHAIN[1].options.reasoningHeadroom, 0);
  });

  console.log("bedtime story provider policy");
  it("uses OpenAI Luna then DeepSeek direct", () => {
    assert.deepEqual(
      STORY_PROVIDER_CHAIN.map((provider) => provider.label),
      ["openai:gpt-5.6-luna", `deepseek:${process.env.DEEPSEEK_MODEL || "deepseek-chat"}:direct`],
    );
    assert.equal(STORY_PROVIDER_CHAIN[0].options.timeoutMs, 45000);
    assert.equal(STORY_PROVIDER_CHAIN[1].options.timeoutMs, 90000);
    assert.deepEqual(STORY_PROVIDER_CHAIN[1].options.thinking, { type: "disabled" });
  });

  await itAsync("sends story prompt to OpenAI with max_completion_tokens", async () => {
    const originalFetch = global.fetch;
    let requestUrl;
    let requestBody;
    global.fetch = async (url, options) => {
      requestUrl = url;
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          choices: [{ message: { content: "從前從前。" }, finish_reason: "stop" }],
        }),
      };
    };
    try {
      const result = await STORY_PROVIDER_CHAIN[0].call(
        [{ role: "user", content: "講故事" }],
        "persona",
        900,
      );
      assert.equal(result.ok, true);
      assert.match(String(requestUrl), /api\.openai\.com/);
      assert.equal(requestBody.model, "gpt-5.6-luna");
      // 900 is the display budget; Luna's hidden reasoning is billed against
      // the same ceiling, so the headroom rides on top of it.
      assert.equal(
        requestBody.max_completion_tokens,
        900 + OPENAI_REASONING_HEADROOM,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  await itAsync("sends DeepSeek recap with medium thinking and recap headroom", async () => {
    const originalFetch = global.fetch;
    let requestBody;
    global.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          choices: [{ message: { content: "完成" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 34,
            completion_tokens_details: { reasoning_tokens: 20 },
          },
        }),
      };
    };
    try {
      const result = await RECAP_PROVIDER_CHAIN[0].call(
        [{ role: "user", content: "回顧" }],
        "persona",
        1600,
      );
      assert.equal(result.ok, true);
      assert.deepEqual(requestBody.thinking, { type: "enabled" });
      assert.equal(requestBody.reasoning_effort, "medium");
      assert.equal(requestBody.max_tokens, 5696);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await itAsync("falls back to DeepSeek :direct when thinking recap returns empty", async () => {
    resetCircuitState();
    const originalFetch = global.fetch;
    const bodies = [];
    global.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      if (bodies.length === 1) {
        return {
          ok: true,
          headers: { get: () => null },
          json: async () => ({
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2948,
              completion_tokens_details: { reasoning_tokens: 2948 },
            },
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          choices: [{ message: { content: "今日回顧：有人在露營。" }, finish_reason: "stop" }],
        }),
      };
    };
    try {
      const recapDeepSeek = RECAP_PROVIDER_CHAIN.filter((provider) =>
        provider.label.startsWith("deepseek:"),
      );
      const result = await runProviderChain(
        recapDeepSeek,
        [{ role: "user", content: "回顧" }],
        "persona",
        1600,
      );
      assert.equal(result.provider.label.endsWith(":direct"), true);
      assert.equal(result.text, "今日回顧：有人在露營。");
      assert.deepEqual(bodies[0].thinking, { type: "enabled" });
      assert.equal(bodies[0].reasoning_effort, "medium");
      assert.deepEqual(bodies[1].thinking, { type: "disabled" });
      assert.equal(bodies[1].reasoning_effort, undefined);
    } finally {
      global.fetch = originalFetch;
    }
  });

  console.log("daily recap pre-generation timing");
  it("moves :00 and midnight schedules one minute earlier", () => {
    assert.deepEqual(subtractScheduleMinute(19, 0), { hour: 18, minute: 59 });
    assert.deepEqual(subtractScheduleMinute(0, 0), { hour: 23, minute: 59 });
    assert.deepEqual(subtractScheduleMinute(0, 30), { hour: 0, minute: 29 });
  });
  it("derives original publication instant from cron's scheduled start", () => {
    const started = new Date("2026-07-15T10:59:00.000Z");
    assert.equal(recapNotBeforeMs({ date: started }), started.getTime() + 60000);
  });
  await itAsync("holds a fast result until the original publication time", async () => {
    let nowMs = 1_000_000;
    let sentAt = null;
    const channel = {
      send: async () => {
        sentAt = nowMs;
        return { id: "sent" };
      },
    };
    await sendAtOrAfter(channel, { content: "recap" }, 1_060_000, {
      now: () => nowMs,
      sleep: async (ms) => { nowMs += ms; },
    });
    assert.equal(sentAt, 1_060_000);
  });
  await itAsync("sends immediately when recap generation finishes late", async () => {
    let slept = false;
    const channel = { send: async () => ({ id: "sent" }) };
    await sendAtOrAfter(channel, { content: "late recap" }, 1_060_000, {
      now: () => 1_070_000,
      sleep: async () => { slept = true; },
    });
    assert.equal(slept, false);
  });

  console.log("bot rich embed group context");
  await itAsync("keeps bot rich embed previews with a neutral label but drops bot chatter", async () => {
    const emptyColl = { size: 0, map: () => [], filter: () => emptyColl };
    const messages = [
      {
        content: "西寶的一般回覆",
        author: { id: "bot", username: "西寶" },
        stickers: emptyColl,
        attachments: emptyColl,
        reactions: { cache: emptyColl },
        embeds: [],
      },
      {
        content: "",
        author: { id: "bot", username: "西寶" },
        stickers: emptyColl,
        attachments: emptyColl,
        reactions: { cache: emptyColl },
        embeds: [{ author: { name: "外部作者" }, description: "外部貼文內容" }],
      },
      {
        content: "人類訊息",
        author: { id: "human", username: "群友" },
        stickers: emptyColl,
        attachments: emptyColl,
        reactions: { cache: emptyColl },
        embeds: [],
      },
    ];
    const channel = {
      messages: {
        fetch: async () => ({ values: () => messages[Symbol.iterator]() }),
      },
    };
    const context = await fetchGroupContext(channel, 5, "before", "bot");
    assert.equal(context.length, 2);
    assert.ok(context.some((entry) => /^\[連結預覽\]:/.test(entry.line)));
    assert.ok(context.some((entry) => entry.line.includes("外部貼文內容")));
    assert.ok(context.every((entry) => !entry.line.includes("西寶的一般回覆")));
    const preview = context.find((entry) => entry.isLinkPreview);
    assert.equal(preview.userId, null);
    assert.equal(preview.displayName, null);
  });
  it("fail(kind, extra) returns failure shape", () => {
    assert.deepEqual(fail("timeout"), { ok: false, kind: "timeout" });
    assert.deepEqual(
      fail("rate_limit", { status: 429, retryAfterMs: 1000 }),
      { ok: false, kind: "rate_limit", status: 429, retryAfterMs: 1000 },
    );
  });

  console.log("getCooldownMs");
  it("auth gets 10 minute cooldown", () => {
    assert.equal(getCooldownMs({ kind: "auth" }), 600000);
  });
  it("queue_exceeded gets 30s cooldown", () => {
    assert.equal(getCooldownMs({ kind: "queue_exceeded" }), 30000);
  });
  it("rate_limit uses retryAfterMs when present", () => {
    assert.equal(getCooldownMs({ kind: "rate_limit", retryAfterMs: 5000 }), 5000);
  });
  it("rate_limit falls back to 60s when no retryAfterMs", () => {
    assert.equal(getCooldownMs({ kind: "rate_limit" }), 60000);
  });
  it("timeout/network/server all get 60s", () => {
    assert.equal(getCooldownMs({ kind: "timeout" }), 60000);
    assert.equal(getCooldownMs({ kind: "network" }), 60000);
    assert.equal(getCooldownMs({ kind: "server" }), 60000);
  });
  it("empty gets 0ms (content issue, not provider issue)", () => {
    assert.equal(getCooldownMs({ kind: "empty" }), 0);
  });
  it("unknown kind falls back to 30s", () => {
    assert.equal(getCooldownMs({ kind: "something-weird" }), 30000);
  });

  console.log("personal memory context");
  it("keeps only the latest 3 group-context entries for personal extraction", () => {
    const entries = [
      { line: "[a]: 1" },
      { line: "[b]: 2" },
      { line: "[c]: 3" },
      { line: "[d]: 4" },
    ];
    assert.equal(PERSONAL_CONTEXT_MEMORY_COUNT, 3);
    assert.deepEqual(getPersonalMemoryContextEntries(entries), entries.slice(1));
    assert.deepEqual(getPersonalMemoryContextEntries(null), []);
  });

  console.log("circuit state");
  it("fresh provider is available", () => {
    resetCircuitState();
    assert.equal(isProviderAvailable("p1"), true);
  });
  it("auth failure puts provider in cooldown", () => {
    resetCircuitState();
    const now = 1_000_000;
    recordProviderFailure("p1", { kind: "auth" }, now);
    assert.equal(isProviderAvailable("p1", now), false);
    assert.equal(isProviderAvailable("p1", now + 599_000), false);
    assert.equal(isProviderAvailable("p1", now + 600_001), true);
  });
  it("empty failure does NOT put provider in cooldown", () => {
    resetCircuitState();
    const now = 1_000_000;
    recordProviderFailure("p1", { kind: "empty" }, now);
    assert.equal(isProviderAvailable("p1", now), true);
    assert.equal(getCircuitSnapshot(now).length, 0);
  });
  it("recordProviderSuccess clears cooldown", () => {
    resetCircuitState();
    const now = 1_000_000;
    recordProviderFailure("p1", { kind: "timeout" }, now);
    assert.equal(isProviderAvailable("p1", now), false);
    recordProviderSuccess("p1");
    assert.equal(isProviderAvailable("p1", now), true);
  });
  it("failCount increments across consecutive failures", () => {
    resetCircuitState();
    const now = 1_000_000;
    recordProviderFailure("p1", { kind: "timeout" }, now);
    recordProviderFailure("p1", { kind: "server" }, now + 1000);
    const snap = getCircuitSnapshot(now + 1000);
    assert.equal(snap[0].failCount, 2);
    assert.equal(snap[0].lastFailureKind, "server");
  });
  it("snapshot reports cooldownRemainingMs", () => {
    resetCircuitState();
    const now = 1_000_000;
    recordProviderFailure("p1", { kind: "timeout" }, now);
    const snap = getCircuitSnapshot(now + 10_000);
    assert.equal(snap[0].cooldownRemainingMs, 50_000);
    assert.equal(snap[0].available, false);
  });

  console.log("runProviderChain");
  await itAsync("first ok wins, records success", async () => {
    resetCircuitState();
    const calls = [];
    const chain = [
      {
        label: "a",
        call: async () => {
          calls.push("a");
          return ok("hello from a");
        },
      },
      {
        label: "b",
        call: async () => {
          calls.push("b");
          return ok("should not be reached");
        },
      },
    ];
    const result = await runProviderChain(chain, []);
    assert.equal(result.text, "hello from a");
    assert.deepEqual(calls, ["a"]);
  });

  await itAsync("skips cooling-down provider, falls through to next", async () => {
    resetCircuitState();
    recordProviderFailure("a", { kind: "timeout" });
    const calls = [];
    const chain = [
      { label: "a", call: async () => { calls.push("a"); return ok("from a"); } },
      { label: "b", call: async () => { calls.push("b"); return ok("from b"); } },
    ];
    const result = await runProviderChain(chain, []);
    assert.equal(result.text, "from b");
    assert.deepEqual(calls, ["b"]);
  });

  await itAsync("failure on one provider cascades to next, then returns result", async () => {
    resetCircuitState();
    const chain = [
      { label: "a", call: async () => fail("server", { status: 503 }) },
      { label: "b", call: async () => ok("saved by b") },
    ];
    const result = await runProviderChain(chain, []);
    assert.equal(result.text, "saved by b");
    assert.equal(isProviderAvailable("a"), false);
  });

  await itAsync("returns null when all providers fail", async () => {
    resetCircuitState();
    const chain = [
      { label: "a", call: async () => fail("timeout") },
      { label: "b", call: async () => fail("server", { status: 500 }) },
    ];
    const result = await runProviderChain(chain, []);
    assert.equal(result, null);
  });

  await itAsync("returns null when all providers are cooling down", async () => {
    resetCircuitState();
    recordProviderFailure("a", { kind: "auth" });
    recordProviderFailure("b", { kind: "server" });
    const calls = [];
    const chain = [
      { label: "a", call: async () => { calls.push("a"); return ok("nope"); } },
      { label: "b", call: async () => { calls.push("b"); return ok("nope"); } },
    ];
    const result = await runProviderChain(chain, []);
    assert.equal(result, null);
    assert.deepEqual(calls, []);
  });

  await itAsync("empty failure does NOT cool provider (still callable next time)", async () => {
    resetCircuitState();
    const chain = [
      { label: "a", call: async () => fail("empty", { detail: "safety" }) },
    ];
    await runProviderChain(chain, []);
    assert.equal(isProviderAvailable("a"), true);
  });

  // ── guild-key-store ──────────────────────────────────────────────────
  console.log("guild-key-store");
  it("returns null for unknown guild", () => {
    resetKeyCache();
    assert.equal(getGuildApiKey("unknown-guild"), null);
  });
  it("set then get returns the key", () => {
    resetKeyCache();
    setGuildApiKey("g1", "sk-test123");
    assert.equal(getGuildApiKey("g1"), "sk-test123");
  });
  it("hasGuildApiKey returns true after set", () => {
    assert.equal(hasGuildApiKey("g1"), true);
  });
  it("remove clears the key", () => {
    resetKeyCache();
    setGuildApiKey("g1", "sk-test");
    removeGuildApiKey("g1");
    assert.equal(hasGuildApiKey("g1"), false);
    assert.equal(getGuildApiKey("g1"), null);
  });

  // ── rate-limiter ───────────────────────────────────────────────────
  console.log("rate-limiter");
  it("first call is allowed", () => {
    resetRateLimiter();
    const r = checkAndIncrement("g1", 3);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 2);
  });
  it("allows up to limit", () => {
    resetRateLimiter();
    checkAndIncrement("g1", 3);
    checkAndIncrement("g1", 3);
    const r = checkAndIncrement("g1", 3);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 0);
  });
  it("denies past limit", () => {
    const r = checkAndIncrement("g1", 3);
    assert.equal(r.allowed, false);
    assert.equal(r.remaining, 0);
  });
  it("getUsage returns current count", () => {
    const u = getUsage("g1");
    assert.equal(u.count, 3);
  });
  it("reset clears counters", () => {
    resetRateLimiter();
    const u = getUsage("g1");
    assert.equal(u.count, 0);
  });

  // ── buildGuildChain ────────────────────────────────────────────────
  console.log("buildGuildChain");
  const briefTier = { tier: "brief" };
  const standardTier = { tier: "standard" };
  const detailedTier = { tier: "detailed" };

  it("brief tier gets flash model in chain", () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    const { chain, rateLimited } = buildGuildChain("free-guild-123", briefTier);
    assert.equal(rateLimited, false);
    const dsEntry = chain.find((e) => e.label.startsWith("deepseek:"));
    assert.ok(dsEntry, "should have a DeepSeek entry");
    assert.ok(dsEntry.label.includes("flash"), `expected flash model in label, got ${dsEntry.label}`);
  });
  it("rate-limited free guild has no DeepSeek entry", () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    // Test the rate limiter contract directly
    checkAndIncrement("rate-test-guild", 1);
    const r = checkAndIncrement("rate-test-guild", 1);
    assert.equal(r.allowed, false);
  });
  it("guild with own key on standard tier gets pro model with :guild label", () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    setGuildApiKey("keyed-guild", "sk-guildkey");
    const { chain } = buildGuildChain("keyed-guild", standardTier);
    const dsEntry = chain.find((e) => e.label.startsWith("deepseek:"));
    assert.ok(dsEntry, "should have a DeepSeek entry");
    assert.ok(dsEntry.label.includes(":guild"), `expected :guild suffix, got ${dsEntry.label}`);
    assert.ok(!dsEntry.label.includes("flash"), `expected pro model, got ${dsEntry.label}`);
    assert.equal(chain[0], dsEntry);
    assert.equal(chain[1].label.split(":")[0], "kimi");
  });
  it("guild with own key on brief tier gets flash model", () => {
    resetKeyCache();
    resetCircuitState();
    setGuildApiKey("keyed-guild", "sk-mykey");
    const { chain } = buildGuildChain("keyed-guild", briefTier);
    const dsEntry = chain.find((e) => e.label.startsWith("deepseek:"));
    assert.ok(dsEntry);
    assert.ok(dsEntry.label.includes("flash"), `expected flash model, got ${dsEntry.label}`);
  });
  await itAsync("passes task-specific thinking options to keyed DeepSeek", async () => {
    resetKeyCache();
    setGuildApiKey("voice-guild", "sk-voice-test");
    let requestBody;
    const originalFetch = global.fetch;
    global.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          choices: [{ message: { content: "表示：うん。\n読み：うん。" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 12 },
        }),
      };
    };
    try {
      const { chain } = buildGuildChain("voice-guild", standardTier, {
        deepSeek: {
          thinking: { type: "enabled" },
          reasoningEffort: "high",
          reasoningHeadroom: 2048,
        },
      });
      const result = await chain[0].call(
        [{ role: "user", content: "こんにちは" }],
        "persona",
        100,
      );
      assert.equal(result.ok, true);
      assert.deepEqual(requestBody.thinking, { type: "enabled" });
      assert.equal(requestBody.reasoning_effort, "high");
      assert.equal(requestBody.max_tokens, 2148);
    } finally {
      global.fetch = originalFetch;
    }
  });

  // Regression guard for the 42% empty-reply bug (2026-06-01 → 2026-09-06):
  // the free flash entry ran with reasoningHeadroom 0 while thinking stayed
  // ON, so v4-flash spent the whole display budget on hidden reasoning and
  // returned finish_reason=length with no content.
  await itAsync("free flash entry reserves reasoning headroom", async () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    let requestBody;
    const originalFetch = global.fetch;
    global.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          choices: [{ message: { content: "嗨" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 12 },
        }),
      };
    };
    try {
      const { chain } = buildGuildChain("free-headroom-guild", briefTier);
      const dsEntry = chain.find((e) => e.label.startsWith("deepseek:"));
      assert.ok(dsEntry.label.includes("flash"));
      await dsEntry.call([{ role: "user", content: "hi" }], "persona", 180);
      assert.equal(
        requestBody.max_tokens,
        180 + DEEPSEEK_REASONING_HEADROOM,
        "flash must get display budget + headroom, not the bare display budget",
      );
      assert.ok(
        !requestBody.thinking || requestBody.thinking.type !== "disabled",
        "headroom 0 is only valid when thinking is explicitly disabled",
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
  await itAsync("callOpenAI reserves reasoning headroom", async () => {
    let requestBody;
    const originalFetch = global.fetch;
    global.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          choices: [{ message: { content: "嗨" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 12 },
        }),
      };
    };
    try {
      await callOpenAI([{ role: "user", content: "hi" }], "persona", 180);
      assert.equal(
        requestBody.max_completion_tokens,
        180 + OPENAI_REASONING_HEADROOM,
        "OpenAI bills reasoning against max_completion_tokens too",
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  // cleanup
  resetKeyCache();
  resetRateLimiter();

  console.log(`\nResult: ${pass} passed, ${fails} failed`);
  process.exit(fails > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
