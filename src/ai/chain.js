const {
  AI_PROVIDER_FORCE,
  AI_LONG_TERM_MEMORY_ENABLED,
  AI_FREE_DAILY_LIMIT,
  EMOJI_TRUSTED_GUILD_IDS,
  OPENAI_API_KEY,
  OPENAI_MODEL,
  STORY_OPENAI_TIMEOUT_MS,
  GEMINI_API_KEY,
  GEMINI_MODEL,
  GROQ_API_KEY,
  GROQ_MODELS,
  KIMI_API_KEY,
  KIMI_ENABLED,
  KIMI_MODEL,
  DEEPSEEK_API_KEY,
  DEEPSEEK_MODEL,
  DEEPSEEK_MODEL_FREE,
  DEEPSEEK_PREMIUM_GUILD_IDS,
  DEEPSEEK_REASONING_HEADROOM,
  RECAP_KIMI_TIMEOUT_MS,
  RECAP_DEEPSEEK_TIMEOUT_MS,
  RECAP_DEEPSEEK_REASONING_HEADROOM,
  RECAP_GEMINI_TIMEOUT_MS,
} = require("../config");
const { trimDescription, sanitizeName } = require("../utils");
const { getTierConfig, TIER_REQUIRES_KEY } = require("../tier-config");
const { buildUserTurn } = require("./persona");
const { getChannelAIHistory, recordAITurn } = require("./memory");
const {
  fetchGroupContext,
  buildGroupContextBlock,
  buildReplyContextBlock,
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
  callKimi,
  callOpenAI,
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

// Fallback chain shared by all guilds. Luna first: Groq/Gemini models in
// env are currently 404, and DeepSeek v4-pro chat hits the 25s abort when
// hidden reasoning runs long (same prompt size, more thinking).
function buildFallbackChain() {
  const chain = [];
  const only = AI_PROVIDER_FORCE;
  if (OPENAI_API_KEY && (!only || only === "openai" || only === "luna")) {
    chain.push({
      label: `openai:${OPENAI_MODEL}`,
      call: (turns, persona, maxTokens) => callOpenAI(turns, persona, maxTokens),
    });
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

const FALLBACK_CHAIN = buildFallbackChain();

function buildAIProviderChain() {
  const chain = [];
  const only = AI_PROVIDER_FORCE;
  if (DEEPSEEK_API_KEY && (!only || only === "deepseek")) {
    chain.push({ label: `deepseek:${DEEPSEEK_MODEL}`, call: callDeepSeek });
  }
  if (KIMI_ENABLED && KIMI_API_KEY && (!only || only === "kimi")) {
    chain.push({ label: `kimi:${KIMI_MODEL}`, call: callKimi });
  }
  return [...chain, ...FALLBACK_CHAIN];
}

// Full default chain — used for startup log and backwards-compat export.
const AI_PROVIDER_CHAIN = buildAIProviderChain();

// Daily recaps have a task-specific latency budget because generation starts
// one minute before publication. Keep Groq/Llama completely out of this chain:
// a recap should wait for the higher-quality providers instead of silently
// changing voice. DeepSeek remains first; a same-model no-think entry is
// second so a thinking-empty day still publishes from DeepSeek.
function buildRecapProviderChain() {
  const chain = [];
  const only = AI_PROVIDER_FORCE;
  if (DEEPSEEK_API_KEY && (!only || only === "deepseek")) {
    const thinkingOptions = {
      timeoutMs: RECAP_DEEPSEEK_TIMEOUT_MS,
      reasoningHeadroom: RECAP_DEEPSEEK_REASONING_HEADROOM,
      thinking: { type: "enabled" },
      reasoningEffort: "medium",
    };
    chain.push({
      label: `deepseek:${DEEPSEEK_MODEL}`,
      options: thinkingOptions,
      call: (turns, persona, maxTokens) =>
        callDeepSeek(turns, persona, maxTokens, thinkingOptions),
    });
    const directOptions = {
      timeoutMs: RECAP_DEEPSEEK_TIMEOUT_MS,
      reasoningHeadroom: 0,
      thinking: { type: "disabled" },
    };
    chain.push({
      label: `deepseek:${DEEPSEEK_MODEL}:direct`,
      options: directOptions,
      call: (turns, persona, maxTokens) =>
        callDeepSeek(turns, persona, maxTokens, directOptions),
    });
  }
  if (KIMI_ENABLED && KIMI_API_KEY && (!only || only === "kimi")) {
    const options = { timeoutMs: RECAP_KIMI_TIMEOUT_MS };
    chain.push({
      label: `kimi:${KIMI_MODEL}`,
      options,
      call: (turns, persona, maxTokens) =>
        callKimi(turns, persona, maxTokens, options),
    });
  }
  if (GEMINI_API_KEY && (!only || only === "gemini")) {
    const options = { timeoutMs: RECAP_GEMINI_TIMEOUT_MS };
    chain.push({
      label: `gemini:${GEMINI_MODEL}`,
      options,
      call: (turns, persona, maxTokens) =>
        callGemini(turns, persona, maxTokens, options),
    });
  }
  return chain;
}

const RECAP_PROVIDER_CHAIN = buildRecapProviderChain();

// Bedtime stories used to sit on the 25s chat chain; v4-pro thinking
// regularly aborted and Groq (now 404) was the only thing still publishing.
// Luna goes first so 22:00 does not wait out a doomed DeepSeek call.
function buildStoryProviderChain() {
  const chain = [];
  const only = AI_PROVIDER_FORCE;
  if (OPENAI_API_KEY && (!only || only === "openai" || only === "luna")) {
    const options = { timeoutMs: STORY_OPENAI_TIMEOUT_MS };
    chain.push({
      label: `openai:${OPENAI_MODEL}`,
      options,
      call: (turns, persona, maxTokens) =>
        callOpenAI(turns, persona, maxTokens, options),
    });
  }
  if (DEEPSEEK_API_KEY && (!only || only === "deepseek")) {
    const options = {
      timeoutMs: RECAP_DEEPSEEK_TIMEOUT_MS,
      reasoningHeadroom: 0,
      thinking: { type: "disabled" },
    };
    chain.push({
      label: `deepseek:${DEEPSEEK_MODEL}:direct`,
      options,
      call: (turns, persona, maxTokens) =>
        callDeepSeek(turns, persona, maxTokens, options),
    });
  }
  return chain;
}

const STORY_PROVIDER_CHAIN = buildStoryProviderChain();

// Per-guild chain: DeepSeek first, then Kimi when enabled, then
// shared fallback. Guilds with their own API key use that key for DeepSeek;
// whitelisted guilds use the owner's key; free guilds (brief only) use the
// owner's key with a daily rate limit.
function buildGuildChain(guildId, tierConfig, providerOptions = {}) {
  const only = AI_PROVIDER_FORCE;
  const deepSeekOptions = providerOptions.deepSeek || {};

  // Kimi is the second-choice provider. KIMI_ENABLED=false removes it entirely
  // while the account has insufficient balance, without deleting its key.
  const kimiSecondary = (KIMI_ENABLED && KIMI_API_KEY && (!only || only === "kimi"))
    ? [{ label: `kimi:${KIMI_MODEL}`, call: callKimi }]
    : [];

  if (only === "kimi") {
    return { chain: kimiSecondary, rateLimited: false };
  }
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
            ...deepSeekOptions,
          }),
      };
      return { chain: [entry, ...kimiSecondary, ...FALLBACK_CHAIN], rateLimited: false };
    }
    if (isWhitelisted && DEEPSEEK_API_KEY) {
      const entry = {
        label: `deepseek:${DEEPSEEK_MODEL}`,
        call: (turns, persona, maxTokens) =>
          callDeepSeek(turns, persona, maxTokens, deepSeekOptions),
      };
      return { chain: [entry, ...kimiSecondary, ...FALLBACK_CHAIN], rateLimited: false };
    }
    // No key and not whitelisted — shouldn't happen (command blocks it),
    // but fall through to flash as safety net
  }

  // brief → flash model
  if (!DEEPSEEK_API_KEY) {
    return { chain: [...kimiSecondary, ...FALLBACK_CHAIN], rateLimited: false };
  }

  // Free guild (brief) — check daily rate limit
  if (!hasOwnKey && !isWhitelisted) {
    const rateCheck = checkAndIncrement(guildId, AI_FREE_DAILY_LIMIT);
    if (!rateCheck.allowed) {
      console.log(`[ai] guild=${guildId} hit daily DeepSeek limit (${AI_FREE_DAILY_LIMIT}), using fallback only`);
      return { chain: [...kimiSecondary, ...FALLBACK_CHAIN], rateLimited: true };
    }
  }

  const entry = {
    label: `deepseek:${DEEPSEEK_MODEL_FREE}`,
    call: (turns, persona, maxTokens) =>
      callDeepSeek(turns, persona, maxTokens, {
        model: DEEPSEEK_MODEL_FREE,
        reasoningHeadroom: 0,
        ...deepSeekOptions,
      }),
  };
  return { chain: [entry, ...kimiSecondary, ...FALLBACK_CHAIN], rateLimited: false };
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

async function generateAIReply(message, userText, options = {}) {
  const {
    personaOverride = null,
    personaSuffix = "",
    maxReplyChars = null,
    recordMemory = true,
    includeHistory = true,
    includeContext = true,
    includeEmojiPrompt = true,
    resolveEmojis = true,
    providerOptions = {},
  } = options;
  const tierConfig = getTierConfig(message.guildId);
  const { chain: guildChain, rateLimited } = buildGuildChain(
    message.guildId,
    tierConfig,
    providerOptions,
  );
  if (guildChain.length === 0) return null;
  const userTurn = buildUserTurn(message, userText);
  const history = includeHistory ? getChannelAIHistory(message.channelId) : [];
  let turns = [...history, { role: "user", content: userTurn }];

  // System-prompt assembly is ordered most-stable → most-volatile so the
  // prefix stays byte-identical across calls and stays cache-eligible
  // (DeepSeek context caching keys on the longest shared prefix). Order:
  //   1. persona template (per AI plan, changes only on /ai-tier)
  //   2. emoji table     (per bot session — memoized, same string every call)
  //   3. familiarity      (per-guild, drifts slowly as talk counts grow)
  //   4. group context    (per-call, fully volatile — MUST be last)
  let persona = personaOverride || tierConfig.persona;

  const emojiMap = buildEmojiMap(
    message.client,
    message.guildId,
    EMOJI_TRUSTED_GUILD_IDS,
  );
  if (includeEmojiPrompt) persona += buildEmojiPromptBlock(emojiMap);

  // Familiarity roster lists who in this server has spoken how much. Tied to
  // identity (not topic), so it goes in for ALL tiers including brief — the
  // ~300 token cost buys 西寶 the ability to greet 摯友 vs 剛認識 differently
  // without us hand-curating any list.
  const roster = includeContext ? getFamiliarityRoster(message.guildId) : [];
  if (roster.length > 0) {
    persona += buildFamiliarityBlock(roster);
  }

  let profileBlock = "";
  if (AI_LONG_TERM_MEMORY_ENABLED && includeContext) {
    const userProfile = getUserProfile(message.guildId, message.author?.id);
    profileBlock = buildUserProfileBlock(userProfile);
    if (profileBlock) persona += profileBlock;

    const guildProfile = getGuildProfile(message.guildId);
    const guildBlock = buildGuildProfileBlock(guildProfile);
    if (guildBlock) persona += guildBlock;
  }

  // Mode-specific rules are appended last so they can narrow output format
  // without replacing the stable character persona used by normal text chat.
  if (personaSuffix) persona += `\n\n${personaSuffix}`;

  // Group + target context are both injected as user-role turns (NOT in the
  // system prompt) so user-controlled Discord text stays out of the highest-
  // privilege area and the system-prompt suffix stays cache-stable. We FETCH
  // group context here but DEFER injecting it until after target resolution,
  // because an imitation request suppresses it (see below).
  let groupContextSize = 0;
  let groupContextLines = null;
  let groupBlock = "";
  if (includeContext && tierConfig.groupContextCount > 0 && message.channel) {
    const ctx = await fetchGroupContext(
      message.channel,
      tierConfig.groupContextCount,
      message.id,
      message.client?.user?.id,
    );
    groupContextSize = ctx.length;
    groupContextLines = ctx;
    groupBlock = buildGroupContextBlock(ctx);
  }

  // Target-aware imitation/mention context: when the request is about a
  // specific person (first-person 我 / @mention / named), surface THAT person's
  // profile and — for an explicit imitation — their real recent messages as
  // verbatim voice samples. Without this the profile block only ever describes
  // the speaker, so imitation degrades to trait-list cosplay (it cosplays the
  // labels instead of matching the voice). See target-context.js. The extra
  // sample fetch only runs on imitation intent.
  let targetCtxSize = 0;
  let targetBlock = "";
  let imitationActive = false;
  if (includeContext && message.channel) {
    imitationActive = detectImitationIntent(userText);
    const knownProfiles = AI_LONG_TERM_MEMORY_ENABLED
      ? listUserProfiles(message.guildId)
      : [];
    const targets = resolveTargets(
      message,
      userText,
      groupContextLines,
      knownProfiles,
      imitationActive,
    );
    if (targets.length > 0) {
      const samplesByUser = {};
      if (imitationActive) {
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
      targetBlock = buildTargetContextBlock(enriched, {
        samplesByUser,
        imitation: imitationActive,
      });
      if (targetBlock) targetCtxSize = targets.length;
    }
  }

  // Discord reply reference: when the @ is itself a reply to a specific message,
  // that message is the explicit referent of "你剛剛說的" / "這個". Resolve it so
  // 西寶 can see what's being replied to — crucial for replies to her OWN
  // scheduled posts (daily recap / bedtime story), which never enter conv memory
  // and are filtered out of group context (it drops the bot's own messages).
  let replyBlock = "";
  if (
    includeContext &&
    message.reference?.messageId &&
    typeof message.fetchReference === "function"
  ) {
    try {
      const ref = await message.fetchReference();
      const refContent = (ref.content || "").trim();
      if (refContent) {
        const isSelf = ref.author?.id === message.client?.user?.id;
        const authorName = sanitizeName(
          ref.member?.displayName ||
            ref.author?.globalName ||
            ref.author?.username,
        );
        replyBlock = buildReplyContextBlock({
          content: trimDescription(refContent, 500),
          authorName,
          isSelf,
        });
      }
    } catch (err) {
      // Referenced message deleted / unfetchable — skip silently.
      console.log(`[ai] reply reference unresolved: ${err.message}`);
    }
  }

  // Inject group context at the front (topic awareness); target block and reply
  // block right before the user turn (closest to the request). We deliberately
  // KEEP group context on imitation turns: the user wants "imitate me about the
  // current topic" (e.g. comment on the football chat in my voice), so the
  // topic must stay visible. Dropping any ongoing roleplay CHARACTER is the job
  // of the target block's instruction, not of hiding the context.
  if (groupBlock) {
    turns = [{ role: "user", content: groupBlock }, ...turns];
  }
  if (targetBlock) {
    turns.splice(turns.length - 1, 0, { role: "user", content: targetBlock });
  }
  if (replyBlock) {
    turns.splice(turns.length - 1, 0, { role: "user", content: replyBlock });
  }

  const result = await runProviderChain(
    guildChain,
    turns,
    persona,
    tierConfig.maxTokens,
  );
  if (result) {
    const capped = trimDescription(
      result.text,
      maxReplyChars || tierConfig.maxReplyChars,
    );
    // Record the UNRESOLVED text (`:name:` form) into memory. If we stored the
    // resolved `<:name:id>` syntax, the model would see its own raw IDs next
    // turn and imitate them — mangling the id/colons and producing broken emoji.
    const displayName =
      message.member?.displayName ||
      message.author?.globalName ||
      message.author?.username;
    if (recordMemory) {
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
    }
    const isPremium = hasGuildApiKey(message.guildId) || DEEPSEEK_PREMIUM_GUILD_IDS.includes(message.guildId);
    console.log(
      `[ai] used ${result.provider.label} tier=${tierConfig.tier} premium=${isPremium} len=${result.text.length} history_before=${history.length} group_ctx=${groupContextSize} target_ctx=${targetCtxSize} reply_ctx=${replyBlock ? 1 : 0} roster=${roster.length} profile=${profileBlock ? 1 : 0}`,
    );

    if (AI_LONG_TERM_MEMORY_ENABLED && recordMemory) {
      const guildId = message.guildId;
      const userId = message.author?.id;
      const runChain = (t, p, m) => runProviderChain(guildChain, t, p, m);
      if (guildId && userId) {
        appendPendingInteraction(guildId, userId, displayName, userText, capped, {
          messageId: message.id,
          source: "direct",
          at: message.createdTimestamp,
        });
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
              { messageId: entry.messageId, source: "passive", at: entry.at },
            );
          }
        }
      }
    }

    return resolveEmojis ? resolveCustomEmojis(capped, emojiMap) : capped;
  }

  console.warn(
    `[ai] chain exhausted (${guildChain.length} providers tried${rateLimited ? ", DeepSeek rate-limited" : ""}), falling back to hardcoded reply`,
  );
  return null;
}

module.exports = {
  AI_PROVIDER_CHAIN,
  RECAP_PROVIDER_CHAIN,
  STORY_PROVIDER_CHAIN,
  FALLBACK_CHAIN,
  PERSONAL_CONTEXT_MEMORY_COUNT,
  buildAIProviderChain,
  buildRecapProviderChain,
  buildStoryProviderChain,
  buildGuildChain,
  getPersonalMemoryContextEntries,
  runProviderChain,
  generateAIReply,
};
