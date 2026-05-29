const {
  AI_TIMEOUT_MS,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GROQ_API_KEY,
  CEREBRAS_API_KEY,
  CEREBRAS_MODEL,
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

const CEREBRAS_QUEUE_RETRY_DELAY_MS = 1500;
async function callCerebras(turns, persona, maxTokens) {
  const body = {
    model: CEREBRAS_MODEL,
    messages: buildOpenAIMessages(turns, persona),
    temperature: 0.9,
    top_p: 0.95,
    max_tokens: maxTokens,
  };
  const label = `cerebras:${CEREBRAS_MODEL}`;

  return withAbortTimeout(AI_TIMEOUT_MS, label, async (signal) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CEREBRAS_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      logRateHeaders(label, response);

      if (response.ok) {
        const payload = await response.json();
        const text = payload?.choices?.[0]?.message?.content?.trim();
        if (!text) {
          const finishReason = payload?.choices?.[0]?.finish_reason ?? "unknown";
          console.warn(`[ai] ${label} empty response, finishReason=${finishReason}`);
          return fail("empty", { detail: finishReason });
        }
        if (attempt > 0) console.log(`[ai] ${label} succeeded on retry`);
        return ok(text);
      }

      const errText = await response.text().catch(() => "");
      const isQueueExceeded =
        response.status === 429 &&
        (errText.includes("queue_exceeded") || errText.includes("high traffic"));

      if (isQueueExceeded && attempt === 0) {
        console.log(
          `[ai] ${label} queue_exceeded, retrying in ${CEREBRAS_QUEUE_RETRY_DELAY_MS}ms`,
        );
        await new Promise((resolve) => setTimeout(resolve, CEREBRAS_QUEUE_RETRY_DELAY_MS));
        continue;
      }

      if (isQueueExceeded) {
        console.warn(`[ai] ${label} queue_exceeded after retry`);
        return fail("queue_exceeded", { status: 429 });
      }

      const f = classifyHttpFailure(response, errText);
      console.warn(`[ai] ${label} http ${response.status} kind=${f.kind}: ${errText.slice(0, 200)}`);
      return f;
    }
    return fail("unknown", { detail: "cerebras exhausted retry loop" });
  });
}

async function callDeepSeek(turns, persona, maxTokens) {
  const body = {
    model: DEEPSEEK_MODEL,
    messages: buildOpenAIMessages(turns, persona),
    temperature: 0.9,
    top_p: 0.95,
    max_tokens: maxTokens + DEEPSEEK_REASONING_HEADROOM,
  };
  const label = `deepseek:${DEEPSEEK_MODEL}`;

  return withAbortTimeout(AI_TIMEOUT_MS, label, async (signal) => {
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
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

module.exports = {
  ok,
  fail,
  parseRetryAfterMs,
  classifyHttpFailure,
  withAbortTimeout,
  logRateHeaders,
  callGemini,
  callGroq,
  callCerebras,
  callDeepSeek,
};
