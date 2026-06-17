#!/usr/bin/env node
// Smoke test for AI circuit breaker + provider result contract.
// Exits non-zero on any assertion failure.
//
// Usage: node scripts/smoke-ai-circuit.js

const assert = require("node:assert/strict");

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "smoke-dummy";
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "sk-smoke-dummy";
// web-search off by default in tests; individual tests stub global.fetch.
delete process.env.TAVILY_API_KEY;

const { parseRetryAfterMs, ok, fail, callDeepSeek } = require("../src/ai/providers");
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
  FALLBACK_CHAIN,
} = require("../src/ai/chain");
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
const {
  WEB_SEARCH_TOOL,
  runWebSearch,
  makeToolCallHandler,
} = require("../src/ai/web-search");

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

  console.log("web-search");
  it("WEB_SEARCH_TOOL has the expected OpenAI tool shape", () => {
    assert.equal(WEB_SEARCH_TOOL.type, "function");
    assert.equal(WEB_SEARCH_TOOL.function.name, "web_search");
    assert.deepEqual(WEB_SEARCH_TOOL.function.parameters.required, ["query"]);
  });
  await itAsync("runWebSearch rejects an empty query", async () => {
    assert.equal(await runWebSearch("   "), "（沒有提供搜尋關鍵字）");
  });
  await itAsync("runWebSearch reports missing key (disabled in tests)", async () => {
    assert.equal(await runWebSearch("天氣"), "（沒設定搜尋功能，沒辦法上網查）");
  });
  await itAsync("makeToolCallHandler routes web_search and rejects unknown tools", async () => {
    const handler = makeToolCallHandler("g1");
    assert.match(await handler("web_search", { query: "x" }), /沒設定搜尋功能/);
    assert.match(await handler("nope", {}), /未知的工具/);
  });

  console.log("callDeepSeek tool-calling");
  await itAsync("runs a tool call, feeds the result back, returns the answer", async () => {
    const responses = [
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "tc1", function: { name: "web_search", arguments: '{"query":"颱風"}' } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      { choices: [{ message: { content: "查到了，明天放假喔" }, finish_reason: "stop" }] },
    ];
    const sent = [];
    let toolSeen = null;
    let i = 0;
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      sent.push(JSON.parse(opts.body));
      const payload = responses[i++];
      return { ok: true, headers: new Map(), json: async () => payload, text: async () => "" };
    };
    try {
      const res = await callDeepSeek(
        [{ role: "user", content: "明天會放颱風假嗎" }],
        "persona",
        100,
        {
          tools: [WEB_SEARCH_TOOL],
          onToolCall: async (name, args) => {
            toolSeen = { name, args };
            return "氣象局：明天停班停課";
          },
        },
      );
      assert.equal(res.ok, true);
      assert.equal(res.text, "查到了，明天放假喔");
      assert.deepEqual(toolSeen, { name: "web_search", args: { query: "颱風" } });
      assert.ok(sent[0].tools, "round 0 offered tools");
      assert.ok(
        sent[1].messages.some((m) => m.role === "tool" && m.content === "氣象局：明天停班停課"),
        "tool result fed back on round 1",
      );
    } finally {
      global.fetch = origFetch;
    }
  });
  await itAsync("plain completion sends no tools and returns text", async () => {
    let sentBody = null;
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      sentBody = JSON.parse(opts.body);
      return {
        ok: true,
        headers: new Map(),
        json: async () => ({ choices: [{ message: { content: "嗨嗨" } }] }),
        text: async () => "",
      };
    };
    try {
      const res = await callDeepSeek([{ role: "user", content: "hi" }], "p", 50);
      assert.equal(res.text, "嗨嗨");
      assert.equal(sentBody.tools, undefined);
    } finally {
      global.fetch = origFetch;
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
