const {
  AI_PROVIDER_FORCE,
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
const { getTierConfig } = require("../tier-config");
const { buildUserTurn } = require("./persona");
const { getChannelAIHistory, recordAITurn } = require("./memory");
const {
  callGemini,
  callGroq,
  callCerebras,
  callDeepSeek,
} = require("./providers");

// Build the provider fallback chain once at startup. Each entry has a label
// (for logging) and a call fn that accepts (turns, persona, maxTokens) and
// returns string|null.
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
      chain.push({
        label: `groq:${model}`,
        call: (turns, persona, maxTokens) =>
          callGroq(turns, model, persona, maxTokens),
      });
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

  const tierConfig = getTierConfig(message.guildId);
  const userTurn = buildUserTurn(message, userText);
  const history = getChannelAIHistory(message.channelId);
  const turns = [...history, { role: "user", content: userTurn }];

  for (const provider of AI_PROVIDER_CHAIN) {
    const raw = await provider.call(turns, tierConfig.persona, tierConfig.maxTokens);
    if (raw) {
      const trimmed = trimDescription(raw, tierConfig.maxReplyChars);
      recordAITurn(message.channelId, "user", userTurn, tierConfig.memoryMaxTurns);
      recordAITurn(message.channelId, "assistant", trimmed, tierConfig.memoryMaxTurns);
      console.log(
        `[ai] used ${provider.label} tier=${tierConfig.tier} len=${raw.length} history_before=${history.length}`,
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
