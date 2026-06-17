const {
  AI_TIMEOUT_MS,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GROQ_API_KEY,
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL,
  DEEPSEEK_REASONING_HEADROOM,
} = require("../config");
const { buildOpenAIMessages, buildGeminiContents } = require("./persona");

function ok(text) {
  return { ok: true, text };
}

function fail(kind, extra = {}) {
  return { ok: false, kind, ...extra };
}

function parseRetryAfterMs(response) {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.floor(seconds * 1000);
  }

  const at = Date.parse(raw);
  if (Number.isFinite(at)) {
    return Math.max(0, at - Date.now());
  }

  return null;
}

function classifyHttpFailure(response, errText) {
  const status = response.status;
  const detail = (errText ?? "").slice(0, 200);
  if (status === 401 || status === 403) {
    return fail("auth", { status, detail });
  }
  if (status === 429) {
    return fail("rate_limit", { status, retryAfterMs: parseRetryAfterMs(response) ?? 60_000, detail });
  }
  if (status >= 500 && status <= 599) {
    return fail("server", { status, detail });
  }
  return fail("unknown", { status, detail });
}

async function withAbortTimeout(timeoutMs, providerLabel, fn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } catch (error) {
    if (error?.name === "AbortError") {
      console.warn(`[ai] ${providerLabel} timed out after ${timeoutMs}ms`);
      return fail("timeout");
    }
    if (error instanceof TypeError) {
      console.warn(`[ai] ${providerLabel} network failed: ${error.message}`);
      return fail("network", { detail: error.message });
    }
    console.warn(`[ai] ${providerLabel} failed: ${error.message}`);
    return fail("unknown", { detail: error.message });
  } finally {
    clearTimeout(timer);
  }
}

function logRateHeaders(label, response) {
  const remainingTokens = response.headers.get("x-ratelimit-remaining-tokens");
  const remainingRequests = response.headers.get("x-ratelimit-remaining-requests");
  if (remainingTokens || remainingRequests) {
    console.log(
      `[ai] ${label} remaining tokens=${remainingTokens ?? "?"} req=${remainingRequests ?? "?"}`,
    );
  }
}

async function callGemini(turns, persona, maxTokens) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL,
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    system_instruction: { parts: [{ text: persona }] },
    contents: buildGeminiContents(turns),
    generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: maxTokens },
  };

  return withAbortTimeout(AI_TIMEOUT_MS, "gemini", async (signal) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      const f = classifyHttpFailure(response, errText);
      console.warn(`[ai] gemini http ${response.status} kind=${f.kind}: ${errText.slice(0, 200)}`);
      return f;
    }

    const payload = await response.json();
    const text = payload?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim();

    if (!text) {
      const finishReason = payload?.candidates?.[0]?.finishReason ?? "unknown";
      console.warn(`[ai] gemini empty response, finishReason=${finishReason}`);
      return fail("empty", { detail: finishReason });
    }
    return ok(text);
  });
}

async function callGroq(turns, model, persona, maxTokens) {
  const body = {
    model,
    messages: buildOpenAIMessages(turns, persona),
    temperature: 0.9,
    top_p: 0.95,
    max_tokens: maxTokens,
  };
  const label = `groq:${model}`;

  return withAbortTimeout(AI_TIMEOUT_MS, label, async (signal) => {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    logRateHeaders(label, response);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      const f = classifyHttpFailure(response, errText);
      console.warn(`[ai] ${label} http ${response.status} kind=${f.kind}: ${errText.slice(0, 200)}`);
      return f;
    }

    const payload = await response.json();
    const text = payload?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      const finishReason = payload?.choices?.[0]?.finish_reason ?? "unknown";
      console.warn(`[ai] ${label} empty response, finishReason=${finishReason}`);
      return fail("empty", { detail: finishReason });
    }
    return ok(text);
  });
}

// Max rounds the model may call tools before it MUST answer. After this many
// rounds we stop offering `tools`, forcing a text reply (and capping latency /
// token spend). Each round is its own AI_TIMEOUT_MS-bounded request.
const MAX_TOOL_ROUNDS = 2;

// `overrides.tools` (OpenAI tool specs) + `overrides.onToolCall(name, args)`
// (async → string) enable web search. When absent, this behaves exactly like a
// plain single-shot chat completion. Only DeepSeek wires tools today.
async function callDeepSeek(turns, persona, maxTokens, overrides = {}) {
  const model = overrides.model || DEEPSEEK_MODEL;
  const apiKey = overrides.apiKey || DEEPSEEK_API_KEY;
  const headroom = overrides.reasoningHeadroom ?? DEEPSEEK_REASONING_HEADROOM;
  const tools = overrides.tools;
  const onToolCall = overrides.onToolCall;
  const label = `deepseek:${model}`;

  const messages = buildOpenAIMessages(turns, persona);

  for (let round = 0; ; round++) {
    const offerTools = Boolean(tools && onToolCall && round < MAX_TOOL_ROUNDS);
    const body = {
      model,
      messages,
      temperature: 0.9,
      top_p: 0.95,
      max_tokens: maxTokens + headroom,
    };
    if (offerTools) body.tools = tools;

    const res = await withAbortTimeout(AI_TIMEOUT_MS, label, async (signal) => {
      const response = await fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      logRateHeaders(label, response);

      if (!response.ok) {
        const errText = await response.text().catch(() => "");
        const f = classifyHttpFailure(response, errText);
        console.warn(`[ai] ${label} http ${response.status} kind=${f.kind}: ${errText.slice(0, 200)}`);
        return f;
      }

      const payload = await response.json();
      return { ok: true, choice: payload?.choices?.[0] };
    });

    if (!res.ok) return res;

    const choice = res.choice;
    const msg = choice?.message;
    const toolCalls = msg?.tool_calls;

    // Model wants to search: run each tool, append results, loop for the answer.
    if (offerTools && Array.isArray(toolCalls) && toolCalls.length > 0) {
      messages.push(msg);
      for (const tc of toolCalls) {
        let result;
        try {
          const args = JSON.parse(tc?.function?.arguments || "{}");
          result = await onToolCall(tc?.function?.name, args);
        } catch (err) {
          result = `（工具呼叫失敗：${err.message}）`;
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: typeof result === "string" ? result : String(result ?? ""),
        });
      }
      console.log(`[ai] ${label} ran ${toolCalls.length} tool call(s) round=${round}`);
      continue;
    }

    const text = msg?.content?.trim();
    if (!text) {
      const finishReason = choice?.finish_reason ?? "unknown";
      console.warn(`[ai] ${label} empty response, finishReason=${finishReason}`);
      return fail("empty", { detail: finishReason });
    }
    return ok(text);
  }
}

module.exports = {
  ok,
  fail,
  parseRetryAfterMs,
  classifyHttpFailure,
  withAbortTimeout,
  logRateHeaders,
  callGemini,
  callGroq,
  callDeepSeek,
};
