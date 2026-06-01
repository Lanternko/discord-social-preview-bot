const {
  AI_PROVIDER_FORCE,
  AI_LONG_TERM_MEMORY_ENABLED,
  EMOJI_TRUSTED_GUILD_IDS,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GROQ_API_KEY,
  GROQ_MODELS,
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
  getUserProfile,
  buildUserProfileBlock,
  appendPendingInteraction,
} = require("../user-profile-store");
const {
  maybeExtractObservations,
  maybeGuildExtract,
} = require("./observation-extractor");
const {
  getGuildProfile,
  buildGuildProfileBlock,
  appendPendingContext,
} = require("../guild-profile-store");
const {
  buildEmojiMap,
  resolveCustomEmojis,
  buildEmojiPromptBlock,
} = require("./emoji-resolver");
const {
  callGemini,
  callGroq,
  callDeepSeek,
} = require("./providers");
const {
  isProviderAvailable,
  recordProviderSuccess,
  recordProviderFailure,
} = require("./circuit");

const PERSONAL_CONTEXT_MEMORY_COUNT = 3;

function getPersonalMemoryContextEntries(groupContextLines, count = PERSONAL_CONTEXT_MEMORY_COUNT) {
  if (!Array.isArray(groupContextLines) || count <= 0) return [];
  return groupContextLines.slice(-count);
}

// Build the provider fallback chain once at startup. Each entry has a label
// (for logging) and a call fn that accepts (turns, persona, maxTokens) and
// returns { ok: true, text } | { ok: false, kind, ... }.
//
// Default priority order (paid/reliable → free → last resort):
//   1. DeepSeek (paid, fastest reliable, V3 flagship — user-paid so prefer it)
//   2. Groq models in GROQ_MODELS order (70B → 8B fallback)
//   3. Gemini (last resort, billing trap history)
function buildAIProviderChain() {
  const chain = [];
  const only = AI_PROVIDER_FORCE;

  if (DEEPSEEK_API_KEY && (!only || only === "deepseek")) {
    chain.push({ label: `deepseek:${DEEPSEEK_MODEL}`, call: callDeepSeek });
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
  let turns = [...history, { role: "user", content: userTurn }];

  // System-prompt assembly is ordered most-stable → most-volatile so the
  // prefix stays byte-identical across calls and stays cache-eligible
  // (DeepSeek context caching keys on the longest shared prefix). Order:
  //   1. persona template (per-tier, changes only on /tier)
  //   2. emoji table     (per bot session — memoized, same string every call)
  //   3. familiarity      (per-guild, drifts slowly as talk counts grow)
  //   4. group context    (per-call, fully volatile — MUST be last)
  let persona = tierConfig.persona;

  const emojiMap = buildEmojiMap(
    message.client,
    message.guildId,
    EMOJI_TRUSTED_GUILD_IDS,
  );
  persona += buildEmojiPromptBlock(emojiMap);

  // Familiarity roster lists who in this server has spoken how much. Tied to
  // identity (not topic), so it goes in for ALL tiers including brief — the
  // ~300 token cost buys 西寶 the ability to greet 摯友 vs 剛認識 differently
  // without us hand-curating any list.
  const roster = getFamiliarityRoster(message.guildId);
  if (roster.length > 0) {
    persona += buildFamiliarityBlock(roster);
  }

  let profileBlock = "";
  if (AI_LONG_TERM_MEMORY_ENABLED) {
    const userProfile = getUserProfile(message.guildId, message.author?.id);
    profileBlock = buildUserProfileBlock(userProfile);
    if (profileBlock) persona += profileBlock;

    const guildProfile = getGuildProfile(message.guildId);
    const guildBlock = buildGuildProfileBlock(guildProfile);
    if (guildBlock) persona += guildBlock;
  }

  // Group context is injected as a user-role message (NOT concatenated into
  // the system prompt) so that user-controlled Discord messages don't land in
  // the highest-privilege prompt area. This also improves DeepSeek cache hits
  // because the system prompt suffix is no longer volatile.
  let groupContextSize = 0;
  let groupContextLines = null;
  if (tierConfig.groupContextCount > 0 && message.channel) {
    const ctx = await fetchGroupContext(
      message.channel,
      tierConfig.groupContextCount,
      message.id,
      message.client?.user?.id,
    );
    groupContextSize = ctx.length;
    groupContextLines = ctx;
    const block = buildGroupContextBlock(ctx);
    if (block) {
      turns = [{ role: "user", content: block }, ...turns];
    }
  }

  const result = await runProviderChain(
    AI_PROVIDER_CHAIN,
    turns,
    persona,
    tierConfig.maxTokens,
  );
  if (result) {
    const capped = trimDescription(result.text, tierConfig.maxReplyChars);
    // Record the UNRESOLVED text (`:name:` form) into memory. If we stored the
    // resolved `<:name:id>` syntax, the model would see its own raw IDs next
    // turn and imitate them — mangling the id/colons and producing broken emoji.
    const displayName =
      message.member?.displayName ||
      message.author?.globalName ||
      message.author?.username;
    recordAITurn(message.channelId, "user", userTurn, tierConfig.memoryMaxTurns, {
      guildId: message.guildId,
      userId: message.author?.id,
      displayName,
    });
    recordAITurn(message.channelId, "assistant", capped, tierConfig.memoryMaxTurns, {
      guildId: message.guildId,
      userId: message.client?.user?.id,
      displayName: message.client?.user?.username || "西寶",
    });
    console.log(
      `[ai] used ${result.provider.label} tier=${tierConfig.tier} len=${result.text.length} history_before=${history.length} group_ctx=${groupContextSize} roster=${roster.length} profile=${profileBlock ? 1 : 0}`,
    );

    if (AI_LONG_TERM_MEMORY_ENABLED) {
      const guildId = message.guildId;
      const userId = message.author?.id;
      const runChain = (t, p, m) => runProviderChain(AI_PROVIDER_CHAIN, t, p, m);
      if (guildId && userId) {
        appendPendingInteraction(guildId, userId, displayName, userText, capped);
        maybeExtractObservations(guildId, userId, displayName, runChain).catch(() => {});
      }
      if (guildId && groupContextLines && groupContextLines.length > 0) {
        const guildName = message.guild?.name;
        const ctxStrings = groupContextLines.map((e) => e.line);
        appendPendingContext(guildId, guildName, ctxStrings);
        maybeGuildExtract(guildId, guildName, runChain).catch(() => {});

        const personalContextLines = getPersonalMemoryContextEntries(groupContextLines);
        for (const entry of personalContextLines) {
          if (entry.userId) {
            appendPendingInteraction(
              guildId, entry.userId, entry.displayName,
              entry.line, "",
            );
          }
        }
      }
    }

    return resolveCustomEmojis(capped, emojiMap);
  }

  console.warn(
    `[ai] chain exhausted (${AI_PROVIDER_CHAIN.length} providers tried), falling back to hardcoded reply`,
  );
  return null;
}

module.exports = {
  AI_PROVIDER_CHAIN,
  PERSONAL_CONTEXT_MEMORY_COUNT,
  buildAIProviderChain,
  getPersonalMemoryContextEntries,
  runProviderChain,
  generateAIReply,
};
