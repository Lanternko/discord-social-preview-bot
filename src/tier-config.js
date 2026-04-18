const { AI_PERSONA } = require("./config");
const { getGuildTier } = require("./tier-store");

// Hardcoded tier metadata. Numbers aligned in todo.md under 西寶人格分級.
// Internal keys are English (brief/standard/detailed); Discord UI shows 簡短/標準/精細.
const TIERS = {
  brief: {
    tier: "brief",
    memoryMaxTurns: 8,
    maxReplyChars: 300,
    maxTokens: 180,
    sentenceMin: 1,
    sentenceMax: 4,
    groupContext: "none",
    groupContextCount: 0,
    vision: false,
  },
  standard: {
    tier: "standard",
    memoryMaxTurns: 20,
    maxReplyChars: 700,
    maxTokens: 420,
    sentenceMin: 2,
    sentenceMax: 8,
    groupContext: "none",
    groupContextCount: 0,
    vision: false,
  },
  detailed: {
    tier: "detailed",
    memoryMaxTurns: 40,
    maxReplyChars: 1200,
    maxTokens: 720,
    sentenceMin: 3,
    sentenceMax: 15,
    groupContext: "recent_non_bot_messages",
    groupContextCount: 15,
    vision: true,
  },
};

const TIER_UI_LABELS = {
  brief: "簡短",
  standard: "標準",
  detailed: "精細",
};

function buildPersonaFromTemplate(template, sentenceMin, sentenceMax) {
  return template
    .split("{SENTENCE_MIN}")
    .join(String(sentenceMin))
    .split("{SENTENCE_MAX}")
    .join(String(sentenceMax));
}

function getTierConfig(guildId) {
  const tier = getGuildTier(guildId);
  const base = TIERS[tier];
  return {
    ...base,
    label: TIER_UI_LABELS[tier],
    persona: buildPersonaFromTemplate(
      AI_PERSONA,
      base.sentenceMin,
      base.sentenceMax,
    ),
  };
}

module.exports = {
  TIERS,
  TIER_UI_LABELS,
  buildPersonaFromTemplate,
  getTierConfig,
};
