const {
  AI_PROVIDER_FORCE,
  AI_LONG_TERM_MEMORY_ENABLED,
  AI_FREE_DAILY_LIMIT,
  EMOJI_TRUSTED_GUILD_IDS,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GROQ_API_KEY,
  GROQ_MODELS,
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL,
  DEEPSEEK_MODEL_FREE,
  DEEPSEEK_PREMIUM_GUILD_IDS,
  DEEPSEEK_REASONING_HEADROOM,
} = require("../config");
const { trimDescription } = require("../utils");
const { getTierConfig, TIER_REQUIRES_KEY } = require("../tier-config");
const { buildUserTurn } = require("./persona");
const { getChannelAIHistory, recordAITurn } = require("./memory");
const {
  fetchGroupContext,
  buildGroupContextBlock,
} = require("./group-context");
const {
  detectImitationIntent,
  resolveTargets,
  fetchUserSamples,
  buildTargetContextBlock,
} = require("./target-context");
const {
  getFamiliarityRoster,
  buildFamiliarityBlock,
} = require("../familiarity");
const {
  getUserProfile,
  buildUserProfileBlock,
  appendPendingInteraction,
  listUserProfiles,
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
const { hasGuildApiKey, getGuildApiKey } = require("./guild-key-store");
const { checkAndIncrement } = require("./rate-limiter");

const PERSONAL_CONTEXT_MEMORY_COUNT = 3;

function getPersonalMemoryContextEntries(groupContextLines, count = PERSONAL_CONTEXT_MEMORY_COUNT) {
  if (!Array.isArray(groupContextLines) || count <= 0) return [];
  return groupContextLines.slice(-count);
}

// Fallback chain (Groq + Gemini) built once at startup — shared by all guilds.
// DeepSeek entry varies per guild (model/key/rate-limit), so it's built per-call.
function buildFallbackChain() {
  const chain = [];
  const only = AI_PROVIDER_FORCE;
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

const FALLBACK_CHAIN = buildFallbackChain();

function buildAIProviderChain() {
  const chain = [];
  const only = AI_PROVIDER_FORCE;
  if (DEEPSEEK_API_KEY && (!only || only === "deepseek")) {
    chain.push({ label: `deepseek:${DEEPSEEK_MODEL}`, call: callDeepSeek });
  }
  return [...chain, ...FALLBACK_CHAIN];
}

// Full default chain — used for startup log and backwards-compat export.
const AI_PROVIDER_CHAIN = buildAIProviderChain();

// Per-guild chain: model is determined by tier (brief=flash, standard/detailed=pro).
// Guilds with their own API key use that key; whitelisted guilds use the owner's key;
// free guilds (brief only) use the owner's key with a daily rate limit.
function buildGuildChain(guildId, tierConfig) {
  const only = AI_PROVIDER_FORCE;
  if (only && only !== "deepseek") {
    return { chain: FALLBACK_CHAIN, rateLimited: false };
  }

  const tierKey = tierConfig?.tier || "brief";
  const needsPro = TIER_REQUIRES_KEY[tierKey];
  const hasOwnKey = hasGuildApiKey(guildId);
  const isWhitelisted = DEEPSEEK_PREMIUM_GUILD_IDS.includes(guildId);

  if (needsPro) {
    // standard/detailed → pro model, requires key or whitelist
    if (hasOwnKey) {
      const guildKey = getGuildApiKey(guildId);
      const entry = {
        label: `deepseek:${DEEPSEEK_MODEL}:guild`,
        call: (turns, persona, maxTokens) =>
          callDeepSeek(turns, persona, maxTokens, {
            apiKey: guildKey,
            model: DEEPSEEK_MODEL,
            reasoningHeadroom: DEEPSEEK_REASONING_HEADROOM,
          }),
      };
      return { chain: [entry, ...FALLBACK_CHAIN], rateLimited: false };
    }
    if (isWhitelisted && DEEPSEEK_API_KEY) {
      const entry = {
        label: `deepseek:${DEEPSEEK_MODEL}`,
        call: callDeepSeek,
      };
      return { chain: [entry, ...FALLBACK_CHAIN], rateLimited: false };
    }
    // No key and not whitelisted — shouldn't happen (command blocks it),
    // but fall through to flash as safety net
  }

  // brief → flash model
  if (!DEEPSEEK_API_KEY) {
    return { chain: FALLBACK_CHAIN, rateLimited: false };
  }

  // Free guild (brief) — check daily rate limit
  if (!hasOwnKey && !isWhitelisted) {
    const rateCheck = checkAndIncrement(guildId, AI_FREE_DAILY_LIMIT);
    if (!rateCheck.allowed) {
      console.log(`[ai] guild=${guildId} hit daily DeepSeek limit (${AI_FREE_DAILY_LIMIT}), using fallback only`);
      return { chain: FALLBACK_CHAIN, rateLimited: true };
    }
  }

  const entry = {
    label: `deepseek:${DEEPSEEK_MODEL_FREE}`,
    call: (turns, persona, maxTokens) =>
      callDeepSeek(turns, persona, maxTokens, {
        model: DEEPSEEK_MODEL_FREE,
        reasoningHeadroom: 0,
      }),
  };
  return { chain: [entry, ...FALLBACK_CHAIN], rateLimited: false };
}

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
  const tierConfig = getTierConfig(message.guildId);
  const { chain: guildChain, rateLimited } = buildGuildChain(message.guildId, tierConfig);
  if (guildChain.length === 0) return null;
  const userTurn = buildUserTurn(message, userText);
  const history = getChannelAIHistory(message.channelId);
  let turns = [...history, { role: "user", content: userTurn }];

  // System-prompt assembly is ordered most-stable → most-volatile so the
  // prefix stays byte-identical across calls and stays cache-eligible
  // (DeepSeek context caching keys on the longest shared prefix). Order:
  //   1. persona template (per AI plan, changes only on /ai-tier)
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

  // Target-aware imitation/mention context: when the request is about a
  // specific person (first-person 我 / @mention / named), surface THAT person's
  // profile and — for an explicit imitation — their real recent messages as
  // verbatim voice samples. Without this the profile block only ever describes
  // the speaker, so imitation degrades to trait-list cosplay (it cosplays the
  // labels instead of matching the voice). See target-context.js. Inserted
  // right before the user turn so it sits closest to the request; the extra
  // sample fetch only runs on imitation intent.
  let targetCtxSize = 0;
  if (message.channel) {
    const imitation = detectImitationIntent(userText);
    const knownProfiles = AI_LONG_TERM_MEMORY_ENABLED
      ? listUserProfiles(message.guildId)
      : [];
    const targets = resolveTargets(
      message,
      userText,
      groupContextLines,
      knownProfiles,
      imitation,
    );
    if (targets.length > 0) {
      const samplesByUser = {};
      if (imitation) {
        for (const t of targets) {
          samplesByUser[t.userId] = await fetchUserSamples(
            message.channel,
            t.userId,
            message.id,
            message.client?.user?.id,
          );
        }
      }
      const enriched = targets.map((t) => ({
        ...t,
        profile: AI_LONG_TERM_MEMORY_ENABLED
          ? getUserProfile(message.guildId, t.userId)?.profile || null
          : null,
      }));
      const targetBlock = buildTargetContextBlock(enriched, {
        samplesByUser,
        imitation,
      });
      if (targetBlock) {
        targetCtxSize = targets.length;
        turns.splice(turns.length - 1, 0, {
          role: "user",
          content: targetBlock,
        });
      }
    }
  }

  const result = await runProviderChain(
    guildChain,
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
    const isPremium = hasGuildApiKey(message.guildId) || DEEPSEEK_PREMIUM_GUILD_IDS.includes(message.guildId);
    console.log(
      `[ai] used ${result.provider.label} tier=${tierConfig.tier} premium=${isPremium} len=${result.text.length} history_before=${history.length} group_ctx=${groupContextSize} target_ctx=${targetCtxSize} roster=${roster.length} profile=${profileBlock ? 1 : 0}`,
    );

    if (AI_LONG_TERM_MEMORY_ENABLED) {
      const guildId = message.guildId;
      const userId = message.author?.id;
      const runChain = (t, p, m) => runProviderChain(guildChain, t, p, m);
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
    `[ai] chain exhausted (${guildChain.length} providers tried${rateLimited ? ", DeepSeek rate-limited" : ""}), falling back to hardcoded reply`,
  );
  return null;
}

module.exports = {
  AI_PROVIDER_CHAIN,
  FALLBACK_CHAIN,
  PERSONAL_CONTEXT_MEMORY_COUNT,
  buildAIProviderChain,
  buildGuildChain,
  getPersonalMemoryContextEntries,
  runProviderChain,
  generateAIReply,
};
