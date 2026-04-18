const {
  AI_PROVIDER_FORCE,
  AI_MAX_REPLY_CHARS,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GROQ_API_KEY,
  GROQ_MODELS,
  CEREBRAS_API_KEY,
  CEREBRAS_MODEL,
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL,
} = require("../config");
const { trimDescription } = require("../utils");
const { buildUserTurn } = require("./persona");
const { getChannelAIHistory, recordAITurn } = require("./memory");
const {
  callGemini,
  callGroq,
  callCerebras,
  callDeepSeek,
} = require("./providers");

// Build the provider fallback chain once at startup. Each entry has a label
// (for logging) and a call fn that returns string|null.
//
// Default priority order (paid/reliable → free → last resort):
//   1. DeepSeek (paid, fastest reliable, V3 flagship — user-paid so prefer it)
//   2. Cerebras (Qwen 235B free 1M TPD but queue_exceeded is common)
//   3. Groq models in GROQ_MODELS order (70B → 8B fallback)
//   4. Gemini (last resort, billing trap history)
function buildAIProviderChain() {
  const chain = [];
  const only = AI_PROVIDER_FORCE;

  if (DEEPSEEK_API_KEY && (!only || only === "deepseek")) {
    chain.push({ label: `deepseek:${DEEPSEEK_MODEL}`, call: callDeepSeek });
  }
  if (CEREBRAS_API_KEY && (!only || only === "cerebras")) {
    chain.push({ label: `cerebras:${CEREBRAS_MODEL}`, call: callCerebras });
  }
  if (GROQ_API_KEY && (!only || only === "groq")) {
    for (const model of GROQ_MODELS) {
      chain.push({ label: `groq:${model}`, call: (turns) => callGroq(turns, model) });
    }
  }
  if (GEMINI_API_KEY && (!only || only === "gemini")) {
    chain.push({ label: `gemini:${GEMINI_MODEL}`, call: callGemini });
  }
  return chain;
}

const AI_PROVIDER_CHAIN = buildAIProviderChain();

async function generateAIReply(message, userText) {
  if (AI_PROVIDER_CHAIN.length === 0) return null;

  const userTurn = buildUserTurn(message, userText);
  const history = getChannelAIHistory(message.channelId);
  const turns = [...history, { role: "user", content: userTurn }];

  for (const provider of AI_PROVIDER_CHAIN) {
    const raw = await provider.call(turns);
    if (raw) {
      const trimmed = trimDescription(raw, AI_MAX_REPLY_CHARS);
      recordAITurn(message.channelId, "user", userTurn);
      recordAITurn(message.channelId, "assistant", trimmed);
      console.log(
        `[ai] used ${provider.label} len=${raw.length} history_before=${history.length}`,
      );
      return trimmed;
    }
  }
  console.warn(
    `[ai] chain exhausted (${AI_PROVIDER_CHAIN.length} providers tried), falling back to hardcoded reply`,
  );
  return null;
}

module.exports = {
  AI_PROVIDER_CHAIN,
  buildAIProviderChain,
  generateAIReply,
};
