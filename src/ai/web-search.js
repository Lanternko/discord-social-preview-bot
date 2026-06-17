// Web search for 西寶 — Tavily backend, exposed to DeepSeek via OpenAI
// tool-calling. DeepSeek's API has NO native web access (only the consumer app
// does), so this module is the actual "go online" half: the model decides WHEN
// to look something up (emits a `web_search` tool call), and we run the Tavily
// query here and feed the snippets back. Only DeepSeek/Groq (OpenAI-compatible)
// can call it; Gemini fallback answers without search.
//
// Quota is double-capped (per-guild + global daily) so a free Tavily key can't
// be drained. Caps reuse rate-limiter with `web:` prefixed keys so they don't
// collide with the DeepSeek free-tier counter.

const {
  TAVILY_API_KEY,
  WEB_SEARCH_MAX_RESULTS,
  WEB_SEARCH_DAILY_LIMIT_GUILD,
  WEB_SEARCH_DAILY_LIMIT_GLOBAL,
  WEB_SEARCH_TIMEOUT_MS,
} = require("../config");
const { checkAndIncrement } = require("./rate-limiter");

// OpenAI-compatible tool spec handed to DeepSeek. Terse on purpose — the model
// only needs to know it CAN look things up and must pass a focused query, not
// the whole sentence. The "閒聊時不要用" line keeps 西寶 from searching banter.
const WEB_SEARCH_TOOL = {
  type: "function",
  function: {
    name: "web_search",
    description:
      "查網路上的即時／事實資訊（新聞、現況、比賽結果、你不確定或可能過時的東西）。純閒聊、講感受、開玩笑、對方只是在跟你互動時不要用。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "精簡的搜尋關鍵字（不是整句話），用最可能查到答案的語言",
        },
      },
      required: ["query"],
    },
  },
};

function isWebSearchEnabled() {
  return Boolean(TAVILY_API_KEY);
}

// Format Tavily's JSON into a compact text block for the tool result. Pure so
// it's unit-testable without a network call.
function formatTavilyResults(payload, query) {
  const out = [];
  const answer = (payload?.answer || "").trim();
  if (answer) out.push(`摘要：${answer}`);

  const results = Array.isArray(payload?.results) ? payload.results : [];
  results.slice(0, WEB_SEARCH_MAX_RESULTS).forEach((r, i) => {
    const title = (r?.title || "").trim();
    const content = (r?.content || "").replace(/\s+/g, " ").trim().slice(0, 400);
    const url = (r?.url || "").trim();
    const parts = [`[${i + 1}] ${title}`.trim()];
    if (content) parts.push(content);
    if (url) parts.push(`(${url})`);
    out.push(parts.join("\n"));
  });

  if (out.length === 0) return `（找不到「${query}」的相關結果）`;
  return out.join("\n\n");
}

async function runWebSearch(query, guildId) {
  const cleanQuery = String(query || "").replace(/\s+/g, " ").trim().slice(0, 300);
  if (!cleanQuery) return "（沒有提供搜尋關鍵字）";
  if (!TAVILY_API_KEY) return "（沒設定搜尋功能，沒辦法上網查）";

  // Double daily cap — global first so one guild can't starve others by racing,
  // then per-guild. Both use the shared rate-limiter under web: keys.
  if (!checkAndIncrement("web:global", WEB_SEARCH_DAILY_LIMIT_GLOBAL).allowed) {
    console.log("[web-search] global daily limit hit");
    return "（今天整體的搜尋次數用完了，晚點再查）";
  }
  if (guildId && !checkAndIncrement(`web:${guildId}`, WEB_SEARCH_DAILY_LIMIT_GUILD).allowed) {
    console.log(`[web-search] guild=${guildId} daily limit hit`);
    return "（這個群今天的搜尋次數用完了）";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: TAVILY_API_KEY,
        query: cleanQuery,
        search_depth: "basic",
        include_answer: true,
        max_results: WEB_SEARCH_MAX_RESULTS,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.warn(`[web-search] tavily http ${response.status}: ${errText.slice(0, 200)}`);
      return `（搜尋失敗：${response.status}）`;
    }
    const payload = await response.json();
    console.log(
      `[web-search] query="${cleanQuery}" results=${payload?.results?.length ?? 0}`,
    );
    return formatTavilyResults(payload, cleanQuery);
  } catch (err) {
    if (err?.name === "AbortError") {
      console.warn(`[web-search] timed out after ${WEB_SEARCH_TIMEOUT_MS}ms`);
      return "（搜尋逾時了）";
    }
    console.warn(`[web-search] failed: ${err.message}`);
    return `（搜尋出錯了：${err.message}）`;
  } finally {
    clearTimeout(timer);
  }
}

// Dispatcher passed into the provider tool loop. Bakes guildId in for quota so
// the provider layer stays ignorant of guild context.
function makeToolCallHandler(guildId) {
  return async (name, args) => {
    if (name === "web_search") return runWebSearch(args?.query, guildId);
    return `（未知的工具：${name}）`;
  };
}

module.exports = {
  WEB_SEARCH_TOOL,
  isWebSearchEnabled,
  runWebSearch,
  formatTavilyResults,
  makeToolCallHandler,
};
