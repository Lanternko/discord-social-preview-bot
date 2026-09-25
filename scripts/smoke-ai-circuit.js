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
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "gsk-groq-smoke-dummy";
// Assert the shipped default, not whatever the operator has in .env.
delete process.env.GROQ_MODELS;
delete process.env.GROQ_MODEL;
delete process.env.GEMINI_MODEL;
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
  classifyHttpFailure,
  ok,
  fail,
  callDeepSeek,
  callOpenAI,
  callGemini,
} = require("../src/ai/providers");
const {
  DEEPSEEK_VISION_MODEL,
  VISION_MAX_IMAGES,
  VISION_MAX_BYTES,
  VISION_TIMEOUT_MS,
  DEEPSEEK_REASONING_HEADROOM,
  OPENAI_REASONING_HEADROOM,
  GEMINI_REASONING_HEADROOM,
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
  resolveImageType,
  collectVisionImages,
  loadVisionImages,
  buildImageNote,
  attachImagesToTurns,
} = require("../src/ai/vision");
const { buildUserTurn } = require("../src/ai/persona");
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
  todayString,
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
  // The whole fallback tail was 404 for weeks. These pin the models that were
  // actually verified live against each provider on 2026-09-06.
  it("carries no decommissioned model ids", () => {
    const labels = FALLBACK_CHAIN.map((p) => p.label);
    for (const dead of ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "gemini-2.0-flash"]) {
      assert.ok(
        !labels.some((l) => l.includes(dead)),
        `${dead} returns 404 model_not_found — fallback would be silently dead`,
      );
    }
  });
  it("uses a single non-reasoning Groq model", () => {
    const groq = FALLBACK_CHAIN.filter((p) => p.label.startsWith("groq:"));
    // Groq's free tier caps output tokens per minute at 1000 and counts
    // max_tokens as expected output, so a reasoning model here cannot be
    // given headroom without tripping "Request too large ... on output
    // tokens". Keep this layer to one model that emits no hidden reasoning.
    assert.equal(groq.length, 1, `expected exactly one Groq layer, got ${groq.map((p) => p.label)}`);
    assert.equal(groq[0].label, "groq:qwen/qwen3.8-27b");
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
  it("uses DeepSeek v4-pro thinking, then flash direct, then OpenAI Luna", () => {
    assert.deepEqual(
      STORY_PROVIDER_CHAIN.map((provider) => provider.label),
      [
        "deepseek:deepseek-v4-pro:story",
        `deepseek:${process.env.DEEPSEEK_MODEL || "deepseek-flash"}:direct`,
        "openai:gpt-5.6-luna",
      ],
    );
    assert.equal(STORY_PROVIDER_CHAIN[0].options.timeoutMs, 240000);
    assert.equal(STORY_PROVIDER_CHAIN[0].options.reasoningHeadroom, 16000);
    assert.equal(STORY_PROVIDER_CHAIN[0].options.rejectTruncated, true);
    assert.equal(STORY_PROVIDER_CHAIN[1].options.rejectTruncated, true);
    assert.equal(STORY_PROVIDER_CHAIN[0].options.thinking, undefined);
    assert.equal(STORY_PROVIDER_CHAIN[1].options.timeoutMs, 90000);
    assert.deepEqual(STORY_PROVIDER_CHAIN[1].options.thinking, { type: "disabled" });
    assert.equal(STORY_PROVIDER_CHAIN[2].options.timeoutMs, 45000);
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
      const result = await STORY_PROVIDER_CHAIN[2].call(
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

  await itAsync("story chain rejects a length-truncated story; chat keeps it", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: "小翔指著自己" }, finish_reason: "length" }],
      }),
    });
    try {
      const turns = [{ role: "user", content: "故事" }];
      const story = await STORY_PROVIDER_CHAIN[0].call(turns, "persona", 1500);
      assert.equal(story.ok, false);
      assert.equal(story.kind, "empty");
      const chat = await callDeepSeek(turns, "persona", 180, {});
      assert.equal(chat.ok, true, "chat replies keep clipped text");
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

  console.log("classifyHttpFailure");
  const httpResponse = (status) => ({ status, headers: { get: () => null } });
  it("402 insufficient balance is auth, not unknown", () => {
    // A dead balance does not heal on its own — it must land on auth's long
    // cooldown, otherwise the chain retries a provably dead provider twice a
    // minute and pays the round-trip on every reply.
    const failure = classifyHttpFailure(httpResponse(402), "Insufficient Balance");
    assert.equal(failure.kind, "auth");
    assert.equal(getCooldownMs(failure), 600000);
  });
  it("401/403 stay auth", () => {
    assert.equal(classifyHttpFailure(httpResponse(401), "").kind, "auth");
    assert.equal(classifyHttpFailure(httpResponse(403), "").kind, "auth");
  });
  it("other 4xx stay unknown on the short cooldown", () => {
    const failure = classifyHttpFailure(httpResponse(404), "");
    assert.equal(failure.kind, "unknown");
    assert.equal(getCooldownMs(failure), 30000);
  });
  it("429 and 5xx are unaffected", () => {
    assert.equal(classifyHttpFailure(httpResponse(429), "").kind, "rate_limit");
    assert.equal(classifyHttpFailure(httpResponse(503), "").kind, "server");
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
  it("day boundary is Taipei midnight, not UTC", () => {
    // 2026-09-05 16:30Z = 2026-09-06 00:30 in Taipei — already the next day
    // locally, while UTC still calls it the 5th.
    assert.equal(todayString(Date.parse("2026-09-05T16:30:00Z")), "2026-09-06");
    assert.equal(todayString(Date.parse("2026-09-05T15:30:00Z")), "2026-09-05");
  });
  it("count resets when the last count was on an earlier Taipei day", () => {
    resetRateLimiter();
    const yesterday = Date.parse("2026-09-05T10:00:00Z"); // 09-05 18:00 台灣
    const today = Date.parse("2026-09-05T16:30:00Z"); //     09-06 00:30 台灣
    checkAndIncrement("tz-guild", 2, yesterday);
    checkAndIncrement("tz-guild", 2, yesterday);
    assert.equal(checkAndIncrement("tz-guild", 2, yesterday).allowed, false);
    const r = checkAndIncrement("tz-guild", 2, today);
    assert.equal(r.allowed, true, "new Taipei day should start a fresh count");
    assert.equal(r.remaining, 1);
  });
  it("count survives a restart (persisted to disk)", () => {
    resetRateLimiter();
    checkAndIncrement("persist-guild", 3);
    checkAndIncrement("persist-guild", 3);
    // resetForTests only drops the in-memory map — the next read reloads the
    // file, which is what a real process restart does.
    delete require.cache[require.resolve("../src/ai/rate-limiter")];
    const reloaded = require("../src/ai/rate-limiter");
    assert.equal(reloaded.getUsage("persist-guild").count, 2);
    const r = reloaded.checkAndIncrement("persist-guild", 3);
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 0, "restart must not hand back a fresh quota");
    assert.equal(reloaded.checkAndIncrement("persist-guild", 3).allowed, false);
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
  // DeepSeek's peak window (UTC Mon-Fri 01-04 / 06-10) bills double, so the
  // owner-key entry drops behind the flat-rate fallback for those hours.
  const PEAK = new Date("2026-09-10T07:00:00Z");   // 週四 15:00 台北 — 尖峰
  const OFF_PEAK = new Date("2026-09-10T13:00:00Z"); // 週四 21:00 台北 — 離峰

  it("off-peak keeps DeepSeek at the head of the chain", () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    const { chain } = buildGuildChain("free-guild-offpeak", briefTier, {}, OFF_PEAK);
    assert.ok(chain[0].label.startsWith("deepseek:"), `expected DeepSeek first, got ${chain[0].label}`);
  });

  it("peak demotes the owner-key DeepSeek entry to the tail", () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    const { chain } = buildGuildChain("free-guild-peak", briefTier, {}, PEAK);
    // KIMI_ENABLED differs between prod and this smoke env, so assert the
    // contract (DeepSeek no longer leads, and the flat-rate fallback runs
    // before it) rather than a fixed head label.
    assert.ok(
      !chain[0].label.startsWith("deepseek:"),
      `DeepSeek must not lead at peak, got ${chain[0].label}`,
    );
    assert.ok(
      chain.findIndex((e) => e.label.startsWith("openai:")) <
        chain.findIndex((e) => e.label.startsWith("deepseek:")),
      "the flat-rate fallback must be tried before DeepSeek at peak",
    );
    assert.ok(
      chain[chain.length - 1].label.startsWith("deepseek:"),
      `DeepSeek must stay reachable at the tail, got ${chain[chain.length - 1].label}`,
    );
    assert.equal(
      chain.filter((e) => e.label.startsWith("deepseek:")).length,
      1,
      "demotion must move the entry, not duplicate it",
    );
  });

  it("peak does not burn the free guild's daily DeepSeek quota", () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    for (let i = 0; i < 25; i += 1) {
      buildGuildChain("quota-guild", briefTier, {}, PEAK);
    }
    // The counter is untouched, so the guild still has its full allowance the
    // moment peak ends.
    assert.equal(checkAndIncrement("quota-guild", 20).allowed, true);
  });

  it("a guild's OWN key is never demoted at peak", () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    setGuildApiKey("peak-keyed-guild", "sk-guildkey");
    const { chain } = buildGuildChain("peak-keyed-guild", standardTier, {}, PEAK);
    assert.ok(
      chain[0].label.includes(":guild"),
      `a guild paying with its own key keeps DeepSeek first, got ${chain[0].label}`,
    );
  });

  // Tier → model is asserted through the env config, not a hardcoded id: as of
  // 2026-09-21 both DEEPSEEK_MODEL and DEEPSEEK_MODEL_FREE are deepseek-flash
  // (the only current id that takes images; v4-pro averaged 20.4s and blew the
  // 25s timeout on 27% of prod calls). The wiring — premium reads
  // DEEPSEEK_MODEL, free reads DEEPSEEK_MODEL_FREE — is what must hold, so this
  // keeps testing even if the ids diverge again.
  it("guild with own key on standard tier gets the premium model with :guild label", () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    setGuildApiKey("keyed-guild", "sk-guildkey");
    const { chain } = buildGuildChain("keyed-guild", standardTier);
    const dsEntry = chain.find((e) => e.label.startsWith("deepseek:"));
    assert.ok(dsEntry, "should have a DeepSeek entry");
    assert.ok(dsEntry.label.includes(":guild"), `expected :guild suffix, got ${dsEntry.label}`);
    assert.ok(
      dsEntry.label.includes(process.env.DEEPSEEK_MODEL || "deepseek-flash"),
      `expected DEEPSEEK_MODEL, got ${dsEntry.label}`,
    );
    assert.equal(chain[0], dsEntry);
    assert.equal(chain[1].label.split(":")[0], "kimi");
  });
  it("guild with own key on brief tier gets the free-tier model", () => {
    resetKeyCache();
    resetCircuitState();
    setGuildApiKey("keyed-guild", "sk-mykey");
    const { chain } = buildGuildChain("keyed-guild", briefTier);
    const dsEntry = chain.find((e) => e.label.startsWith("deepseek:"));
    assert.ok(dsEntry);
    assert.ok(
      dsEntry.label.includes(process.env.DEEPSEEK_MODEL_FREE || "deepseek-flash"),
      `expected DEEPSEEK_MODEL_FREE, got ${dsEntry.label}`,
    );
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
  await itAsync("callGemini reserves reasoning headroom", async () => {
    let requestBody;
    const originalFetch = global.fetch;
    global.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "嗨" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 700 },
        }),
      };
    };
    try {
      await callGemini([{ role: "user", content: "hi" }], "persona", 180);
      assert.equal(
        requestBody.generationConfig.maxOutputTokens,
        180 + GEMINI_REASONING_HEADROOM,
        "Gemini bills thoughtsTokenCount against maxOutputTokens too",
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

  // ── vision (DeepSeek multimodal) ───────────────────────────────────
  console.log("vision");

  const imageAttachment = (over = {}) => ({
    url: "https://cdn.discordapp.com/attachments/1/2/cat.png",
    contentType: "image/png",
    name: "cat.png",
    size: 1024,
    ...over,
  });
  const fakeMessage = (attachments) => ({
    attachments: new Map(attachments.map((a, i) => [String(i), a])),
  });

  it("accepts the four formats DeepSeek supports, rejects the rest", () => {
    assert.equal(resolveImageType(imageAttachment()), "image/png");
    assert.equal(
      resolveImageType(imageAttachment({ contentType: "image/jpeg; charset=binary" })),
      "image/jpeg",
    );
    // Known image type outside DeepSeek's list must NOT be rescued by its
    // extension — sending it 400s the whole reply.
    assert.equal(
      resolveImageType(imageAttachment({ contentType: "image/svg+xml", name: "a.png" })),
      null,
    );
    // contentType can be null on attachments from a fetched/partial message.
    assert.equal(
      resolveImageType(imageAttachment({ contentType: null, name: "photo.WEBP" })),
      "image/webp",
    );
    assert.equal(resolveImageType(imageAttachment({ contentType: null, name: "clip.mp4" })), null);
  });

  it("skips oversized attachments instead of stalling the call", () => {
    const images = collectVisionImages(
      fakeMessage([imageAttachment({ size: VISION_MAX_BYTES + 1 })]),
    );
    assert.deepEqual(images, []);
  });

  it("caps how many images ride along", () => {
    const many = Array.from({ length: VISION_MAX_IMAGES + 3 }, () => imageAttachment());
    assert.equal(collectVisionImages(fakeMessage(many)).length, VISION_MAX_IMAGES);
  });

  it("falls back to the replied-to message's image, but only when the @ has none", () => {
    const referenced = fakeMessage([imageAttachment({ url: "https://cdn/ref.png" })]);
    const own = fakeMessage([imageAttachment({ url: "https://cdn/own.png" })]);
    assert.equal(collectVisionImages(own, referenced)[0].url, "https://cdn/own.png");
    assert.equal(collectVisionImages(fakeMessage([]), referenced)[0].url, "https://cdn/ref.png");
    assert.deepEqual(collectVisionImages(fakeMessage([]), null), []);
  });

  it("tells blind providers not to pretend they can see", () => {
    const note = buildImageNote(2);
    assert.match(note, /2 張圖片/);
    assert.match(note, /看不到/);
    assert.equal(buildImageNote(0), "");
  });

  it("swaps the blind note for the seeing note on the vision turn only", () => {
    const turn = buildUserTurn(
      { author: { username: "阿翔" } },
      "這張是什麼",
      buildImageNote(1),
    );
    const turns = [
      { role: "user", content: "群組脈絡" },
      { role: "assistant", content: "嗯…" },
      { role: "user", content: turn },
    ];
    const withImages = attachImagesToTurns(turns, [{ url: "https://cdn/cat.png" }]);

    // History stays untouched: re-sending old images would re-bill them.
    assert.equal(withImages[0].content, "群組脈絡");
    assert.equal(withImages[1].content, "嗯…");

    const content = withImages[2].content;
    assert.equal(content[0].type, "text");
    assert.match(content[0].text, /這張是什麼/);
    assert.ok(!content[0].text.includes("看不到"), "vision turn must drop the blind note");
    assert.match(content[0].text, /直接看圖/);
    assert.deepEqual(content[1], {
      type: "image_url",
      image_url: { url: "https://cdn/cat.png" },
    });
  });

  it("leaves turns as plain strings when there is no image", () => {
    const turns = [{ role: "user", content: "哈囉" }];
    assert.equal(attachImagesToTurns(turns, [])[0].content, "哈囉");
    assert.equal(attachImagesToTurns(turns, undefined)[0].content, "哈囉");
  });

  it("puts the vision entry at the head and keeps the blind chain behind it", () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    const images = [{ url: "https://cdn/cat.png", type: "image/png" }];
    const { chain } = buildGuildChain("vision-guild", briefTier, {}, OFF_PEAK, images);
    assert.equal(chain[0].label, `deepseek:${DEEPSEEK_VISION_MODEL}:vision`);
    assert.equal(chain[0].options.timeoutMs, VISION_TIMEOUT_MS);
    // Thinking on burns the budget on reasoning_content and returns empty.
    assert.deepEqual(chain[0].options.thinking, { type: "disabled" });
    assert.equal(chain[0].options.reasoningHeadroom, 0);
    assert.ok(chain.length > 1, "text providers must remain as blind fallbacks");
  });

  it("keeps vision first even at peak, where text DeepSeek is demoted", () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    const images = [{ url: "https://cdn/cat.png", type: "image/png" }];
    const { chain } = buildGuildChain("vision-peak-guild", briefTier, {}, PEAK, images);
    assert.equal(chain[0].label, `deepseek:${DEEPSEEK_VISION_MODEL}:vision`);
  });

  it("adds no vision entry when the message has no image", () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    const { chain } = buildGuildChain("no-image-guild", briefTier, {}, OFF_PEAK, []);
    assert.ok(!chain[0].label.endsWith(":vision"));
  });

  await itAsync("inlines downloaded bytes as base64, never the CDN link", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    try {
      const images = await loadVisionImages(fakeMessage([imageAttachment()]));
      assert.equal(images.length, 1);
      assert.equal(images[0].dataUrl, "data:image/png;base64,AQID");
      const content = attachImagesToTurns(
        [{ role: "user", content: "看圖" }],
        images,
      )[0].content;
      assert.equal(content[1].image_url.url, "data:image/png;base64,AQID");
    } finally {
      global.fetch = originalFetch;
    }
  });

  await itAsync("a failed download costs her eyes, not the reply", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({ ok: false, status: 403, headers: { get: () => null } });
    try {
      const images = await loadVisionImages(fakeMessage([imageAttachment()]));
      // No bytes → no vision entry → the blind text chain answers as usual.
      assert.deepEqual(images, []);
      const { chain } = buildGuildChain("dl-fail-guild", briefTier, {}, OFF_PEAK, images);
      assert.ok(!chain[0].label.endsWith(":vision"));
    } finally {
      global.fetch = originalFetch;
    }
  });

  await itAsync("drops a body that lies about its size", async () => {
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      headers: { get: () => null }, // no content-length
      arrayBuffer: async () => new Uint8Array(VISION_MAX_BYTES + 1).buffer,
    });
    try {
      assert.deepEqual(await loadVisionImages(fakeMessage([imageAttachment()])), []);
    } finally {
      global.fetch = originalFetch;
    }
  });

  await itAsync("sends image_url blocks to the vision model", async () => {
    resetKeyCache();
    resetRateLimiter();
    resetCircuitState();
    const images = [
      { url: "https://cdn/cat.png", type: "image/png", dataUrl: "data:image/png;base64,AQID" },
    ];
    const { chain } = buildGuildChain("vision-call-guild", briefTier, {}, OFF_PEAK, images);
    const originalFetch = global.fetch;
    let requestBody;
    global.fetch = async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        headers: { get: () => null },
        json: async () => ({
          choices: [{ message: { content: "是貓咪…" }, finish_reason: "stop" }],
        }),
      };
    };
    try {
      const result = await chain[0].call(
        [{ role: "user", content: buildUserTurn({ author: { username: "阿翔" } }, "這張是什麼", buildImageNote(1)) }],
        "persona",
        180,
      );
      assert.equal(result.ok, true);
      assert.equal(requestBody.model, DEEPSEEK_VISION_MODEL);
      const content = requestBody.messages.at(-1).content;
      assert.ok(Array.isArray(content), "vision turn must be a content-block array");
      assert.equal(content.at(-1).image_url.url, "data:image/png;base64,AQID");
      assert.deepEqual(requestBody.thinking, { type: "disabled" });
      // System persona still goes as a plain string.
      assert.equal(typeof requestBody.messages[0].content, "string");
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
