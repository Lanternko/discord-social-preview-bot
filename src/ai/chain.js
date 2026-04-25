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
  fetchGroupContext,
  buildGroupContextBlock,
} = require("./group-context");
const {
  getFamiliarityRoster,
  buildFamiliarityBlock,
} = require("../familiarity");
const {
  callGemini,
  callGroq,
  callCerebras,
  callDeepSeek,
} = require("./providers");
const {
  isProviderAvailable,
  recordProviderSuccess,
  recordProviderFailure,
} = require("./circuit");

// Build the provider fallback chain once at startup. Each entry has a label
// (for logging) and a call fn that accepts (turns, persona, maxTokens) and
// returns { ok: true, text } | { ok: false, kind, ... }.
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

async function runProviderChain(chain, turns, persona, maxTokens) {
  for (const provider of chain) {
    if (!isProviderAvailable(provider.label)) {
      console.log(`[ai] skip cooling-down provider=${provider.label}`);
      continue;
    }

    const result = await provider.call(turns, persona, maxTokens);

    if (result && result.ok) {
      recordProviderSuccess(provider.label);
      return { provider, text: result.text };
    }

    const failure = result ?? { kind: "unknown" };
    const cooldownMs = recordProviderFailure(provider.label, failure);
    console.warn(
      `[ai] provider failed label=${provider.label} kind=${failure.kind} cooldownMs=${cooldownMs}`,
    );
  }
  return null;
}

async function generateAIReply(message, userText) {
  if (AI_PROVIDER_CHAIN.length === 0) return null;

  const tierConfig = getTierConfig(message.guildId);
  const userTurn = buildUserTurn(message, userText);
  const history = getChannelAIHistory(message.channelId);
  const turns = [...history, { role: "user", content: userTurn }];

  // Group context is appended to the system prompt for THIS call only — it
  // never lands in conv memory, so each @ gets a fresh window of what the
  // group is actually talking about. Without it 西寶 cannot interpret stickers
  // or cross-talk that happened between people other than her.
  let persona = tierConfig.persona;
  let groupContextSize = 0;
  if (tierConfig.groupContextCount > 0 && message.channel) {
    const ctx = await fetchGroupContext(
      message.channel,
      tierConfig.groupContextCount,
      message.id,
      message.client?.user?.id,
    );
    groupContextSize = ctx.length;
    persona += buildGroupContextBlock(ctx);
  }

  // Familiarity roster lists who in this server has spoken how much. Tied to
  // identity (not topic), so it goes in for ALL tiers including brief — the
  // ~300 token cost buys 西寶 the ability to greet 摯友 vs 剛認識 differently
  // without us hand-curating any list.
  const roster = getFamiliarityRoster(message.guildId);
  if (roster.length > 0) {
    persona += buildFamiliarityBlock(roster);
  }

  const result = await runProviderChain(
    AI_PROVIDER_CHAIN,
    turns,
    persona,
    tierConfig.maxTokens,
  );
  if (result) {
    const trimmed = trimDescription(result.text, tierConfig.maxReplyChars);
    recordAITurn(message.channelId, "user", userTurn, tierConfig.memoryMaxTurns);
    recordAITurn(message.channelId, "assistant", trimmed, tierConfig.memoryMaxTurns);
    console.log(
      `[ai] used ${result.provider.label} tier=${tierConfig.tier} len=${result.text.length} history_before=${history.length} group_ctx=${groupContextSize} roster=${roster.length}`,
    );
    return trimmed;
  }

  console.warn(
    `[ai] chain exhausted (${AI_PROVIDER_CHAIN.length} providers tried), falling back to hardcoded reply`,
  );
  return null;
}

module.exports = {
  AI_PROVIDER_CHAIN,
  buildAIProviderChain,
  runProviderChain,
  generateAIReply,
};
