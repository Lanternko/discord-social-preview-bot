const { AI_PERSONA, DEEPSEEK_PREMIUM_GUILD_IDS } = require("./config");
const { getGuildTier } = require("./tier-store");
const { isGuildKeyUsable } = require("./ai/guild-key-store");
const { getGuildLanguage } = require("./language-store");
const {
  DEFAULT_LANGUAGE,
  languageSpec,
  buildLanguagePersonaBlock,
} = require("./reply-language");

// Hardcoded tier metadata. Numbers aligned in todo.md under 西寶 AI 分級.
// Internal keys are English (brief/standard/detailed); Discord UI shows 入門/標準/精細.
//
// Sentence ranges per category (Phase 2 — Option 1):
// previous Phase 1 only swapped the headline SENTENCE_MIN/MAX; sub-rules had
// hardcoded numbers (A 2~3, A+ 5~6, B 1~2, E ≤4) which the model prioritised
// over the tier headline. Shadow-deploy confirmed detailed tier did not
// actually expand. So each category gets its own tier-aware range now.
//
// C 「不認識的人」故意不 tier 化（一句「我不太認識耶」不該多講）。
const TIERS = {
  brief: {
    tier: "brief",
    memoryMaxTurns: 8,
    maxReplyChars: 300,
    maxTokens: 180,
    sentenceMin: 1,
    sentenceMax: 4,
    aMin: 2,
    aMax: 3,
    aPlusMin: 3,
    aPlusMax: 4,
    bMin: 1,
    bMax: 2,
    eMax: 4,
    groupContext: "none",
    groupContextCount: 0,
    vision: false,
  },
  standard: {
    tier: "standard",
    memoryMaxTurns: 40,
    maxReplyChars: 1200,
    maxTokens: 900,
    sentenceMin: 2,
    sentenceMax: 8,
    aMin: 3,
    aMax: 5,
    aPlusMin: 6,
    aPlusMax: 8,
    bMin: 2,
    bMax: 3,
    eMax: 8,
    groupContext: "recent_non_bot_messages",
    groupContextCount: 15,
    vision: false,
  },
  detailed: {
    tier: "detailed",
    memoryMaxTurns: 60,
    maxReplyChars: 2000,
    maxTokens: 1200,
    sentenceMin: 3,
    sentenceMax: 15,
    aMin: 5,
    aMax: 8,
    aPlusMin: 10,
    aPlusMax: 15,
    bMin: 3,
    bMax: 5,
    eMax: 15,
    groupContext: "recent_non_bot_messages",
    groupContextCount: 15,
    vision: true,
  },
};

const TIER_UI_LABELS = {
  brief: "入門",
  standard: "標準",
  detailed: "精細",
};

const TIER_DESCRIPTIONS = {
  brief: "flash 模型，1~4 句快速回覆",
  standard: "pro 模型，2~8 句一般聊天",
  detailed: "pro 模型，3~15 句詳細回答 + 群組上下文",
};

const TIER_REQUIRES_KEY = {
  brief: false,
  standard: true,
  detailed: true,
};

// Substitutes every placeholder the persona template understands. Unknown
// placeholders pass through unchanged — caller-provided `AI_PERSONA` overrides
// may or may not use them. The language block is appended rather than
// templated so a custom persona without {LANGUAGE} still switches language.
function buildPersonaFromTemplate(template, tier, language = DEFAULT_LANGUAGE) {
  const replacements = {
    "{LANGUAGE}": languageSpec(language).promptName,
    "{SENTENCE_MIN}": tier.sentenceMin,
    "{SENTENCE_MAX}": tier.sentenceMax,
    "{A_MIN}": tier.aMin,
    "{A_MAX}": tier.aMax,
    "{A_PLUS_MIN}": tier.aPlusMin,
    "{A_PLUS_MAX}": tier.aPlusMax,
    "{B_MIN}": tier.bMin,
    "{B_MAX}": tier.bMax,
    "{E_MAX}": tier.eMax,
  };
  let out = template;
  for (const [key, value] of Object.entries(replacements)) {
    out = out.split(key).join(String(value));
  }
  return out + buildLanguagePersonaBlock(language);
}

// The stored tier is what the guild chose; the effective tier is what it can
// pay for right now. A paid tier whose key DeepSeek rejects runs as 入門 until
// the key works again — the stored choice is left alone so it comes back by
// itself, with no admin having to re-run /ai-tier.
function getEffectiveTier(guildId) {
  const tierKey = getGuildTier(guildId);
  if (!TIER_REQUIRES_KEY[tierKey]) return tierKey;
  if (DEEPSEEK_PREMIUM_GUILD_IDS.includes(guildId)) return tierKey;
  return isGuildKeyUsable(guildId) ? tierKey : "brief";
}

function getTierConfig(guildId) {
  const chosen = getGuildTier(guildId);
  const tierKey = getEffectiveTier(guildId);
  const base = TIERS[tierKey];
  return {
    ...base,
    ...(tierKey !== chosen ? { demotedFrom: chosen } : {}),
    label: TIER_UI_LABELS[tierKey],
    persona: buildPersonaFromTemplate(AI_PERSONA, base, getGuildLanguage(guildId)),
  };
}

module.exports = {
  TIERS,
  TIER_UI_LABELS,
  TIER_DESCRIPTIONS,
  TIER_REQUIRES_KEY,
  buildPersonaFromTemplate,
  getEffectiveTier,
  getTierConfig,
};
