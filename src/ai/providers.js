const {
  AI_TIMEOUT_MS,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GROQ_API_KEY,
  KIMI_API_KEY,
  KIMI_MODEL,
  KIMI_BASE_URL,
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL,
  DEEPSEEK_REASONING_HEADROOM,
} = require("../config");
const { buildOpenAIMessages, buildGeminiContents } = require("./persona");

function ok(text, extra = {}) {
  return { ok: true, text, ...extra };
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
  const startedAt = Date.now();
  let outcome = "unknown";
  try {
    const result = await fn(controller.signal);
    outcome = result?.ok ? "ok" : (result?.kind || "unknown");
    return result;
  } catch (error) {
    if (error?.name === "AbortError") {
      outcome = "timeout";
      console.warn(`[ai] ${providerLabel} timed out after ${timeoutMs}ms`);
      return fail("timeout");
    }
    if (error instanceof TypeError) {
      outcome = "network";
      console.warn(`[ai] ${providerLabel} network failed: ${error.message}`);
      return fail("network", { detail: error.message });
    }
    outcome = "unknown";
    console.warn(`[ai] ${providerLabel} failed: ${error.message}`);
    return fail("unknown", { detail: error.message });
  } finally {
    clearTimeout(timer);
    console.log(
      `[ai] provider=${providerLabel} elapsedMs=${Date.now() - startedAt} outcome=${outcome}`,
    );
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

function openAIResponseMeta(payload) {
  const usage = payload?.usage || {};
  return {
    finishReason: payload?.choices?.[0]?.finish_reason,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    reasoningTokens:
      usage?.completion_tokens_details?.reasoning_tokens ?? usage.reasoning_tokens,
  };
}

function geminiResponseMeta(payload) {
  const usage = payload?.usageMetadata || {};
  return {
    finishReason: payload?.candidates?.[0]?.finishReason,
    promptTokens: usage.promptTokenCount,
    completionTokens: usage.candidatesTokenCount,
    reasoningTokens: usage.thoughtsTokenCount,
  };
}

function logResponseMeta(label, meta) {
  const parts = [];
  if (meta?.finishReason) parts.push(`finish_reason=${meta.finishReason}`);
  if (Number.isFinite(meta?.promptTokens)) {
    parts.push(`prompt_tokens=${meta.promptTokens}`);
  }
  if (Number.isFinite(meta?.completionTokens)) {
    parts.push(`completion_tokens=${meta.completionTokens}`);
  }
  if (Number.isFinite(meta?.reasoningTokens)) {
    parts.push(`reasoning_tokens=${meta.reasoningTokens}`);
  }
  if (parts.length > 0) console.log(`[ai] provider=${label} ${parts.join(" ")}`);
}

async function callGemini(turns, persona, maxTokens, overrides = {}) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    GEMINI_MODEL,
  )}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const body = {
    system_instruction: { parts: [{ text: persona }] },
    contents: buildGeminiContents(turns),
    generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: maxTokens },
  };

  const label = `gemini:${GEMINI_MODEL}`;
  const timeoutMs = overrides.timeoutMs ?? AI_TIMEOUT_MS;
  return withAbortTimeout(timeoutMs, label, async (signal) => {
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
    const meta = geminiResponseMeta(payload);
    logResponseMeta(label, meta);
    const text = payload?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim();

    if (!text) {
      const finishReason = payload?.candidates?.[0]?.finishReason ?? "unknown";
      console.warn(`[ai] gemini empty response, finishReason=${finishReason}`);
      return fail("empty", { detail: finishReason });
    }
    return ok(text, { meta });
  });
}

async function callGroq(turns, model, persona, maxTokens, overrides = {}) {
  const body = {
    model,
    messages: buildOpenAIMessages(turns, persona),
    temperature: 0.9,
    top_p: 0.95,
    max_tokens: maxTokens,
  };
  const label = `groq:${model}`;

  const timeoutMs = overrides.timeoutMs ?? AI_TIMEOUT_MS;
  return withAbortTimeout(timeoutMs, label, async (signal) => {
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
    const meta = openAIResponseMeta(payload);
    logResponseMeta(label, meta);
    const text = payload?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      const finishReason = payload?.choices?.[0]?.finish_reason ?? "unknown";
      console.warn(`[ai] ${label} empty response, finishReason=${finishReason}`);
      return fail("empty", { detail: finishReason });
    }
    return ok(text, { meta });
  });
}

async function callKimi(turns, persona, maxTokens, overrides = {}) {
  const body = {
    model: KIMI_MODEL,
    messages: buildOpenAIMessages(turns, persona),
    // kimi-k2.6 is a thinking model: with thinking ON it burns 700-960 hidden
    // reasoning tokens before the visible reply, pushing a real 西寶 imitation
    // call to ~19s and timing out the 25s budget on ~every mention. Disabling
    // thinking drops the SAME call to ~3.5s with the in-voice quality intact.
    // Caveat: non-thinking kimi-k2.6 is model-locked to temperature 0.6
    // (temp:1 → HTTP 400), and no reasoning headroom is needed once it's off.
    temperature: 0.6,
    max_tokens: maxTokens,
    thinking: { type: "disabled" },
  };
  const label = `kimi:${KIMI_MODEL}`;

  const timeoutMs = overrides.timeoutMs ?? AI_TIMEOUT_MS;
  return withAbortTimeout(timeoutMs, label, async (signal) => {
    const response = await fetch(KIMI_BASE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${KIMI_API_KEY}`,
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
    const meta = openAIResponseMeta(payload);
    logResponseMeta(label, meta);
    const text = payload?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      const finishReason = payload?.choices?.[0]?.finish_reason ?? "unknown";
      console.warn(`[ai] ${label} empty response, finishReason=${finishReason}`);
      return fail("empty", { detail: finishReason });
    }
    return ok(text, { meta });
  });
}

async function callDeepSeek(turns, persona, maxTokens, overrides = {}) {
  const model = overrides.model || DEEPSEEK_MODEL;
  const apiKey = overrides.apiKey || DEEPSEEK_API_KEY;
  const headroom = overrides.reasoningHeadroom ?? DEEPSEEK_REASONING_HEADROOM;

  const body = {
    model,
    messages: buildOpenAIMessages(turns, persona),
    temperature: 0.9,
    top_p: 0.95,
    max_tokens: maxTokens + headroom,
  };
  if (overrides.thinking) body.thinking = overrides.thinking;
  if (overrides.reasoningEffort) {
    body.reasoning_effort = overrides.reasoningEffort;
  }
  const label = `deepseek:${model}`;

  const timeoutMs = overrides.timeoutMs ?? AI_TIMEOUT_MS;
  return withAbortTimeout(timeoutMs, label, async (signal) => {
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
    const meta = openAIResponseMeta(payload);
    logResponseMeta(label, meta);
    const text = payload?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      const finishReason = payload?.choices?.[0]?.finish_reason ?? "unknown";
      console.warn(`[ai] ${label} empty response, finishReason=${finishReason}`);
      return fail("empty", { detail: finishReason });
    }
    return ok(text, { meta });
  });
}

module.exports = {
  ok,
  fail,
  parseRetryAfterMs,
  classifyHttpFailure,
  withAbortTimeout,
  logRateHeaders,
  openAIResponseMeta,
  geminiResponseMeta,
  logResponseMeta,
  callGemini,
  callGroq,
  callKimi,
  callDeepSeek,
};
