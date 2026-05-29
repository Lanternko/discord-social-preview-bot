const { AI_PERSONA } = require("./config");
const { getGuildTier } = require("./tier-store");

// Hardcoded tier metadata. Numbers aligned in todo.md under 西寶人格分級.
// Internal keys are English (brief/standard/detailed); Discord UI shows 簡短/標準/精細.
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
    groupContextCount: 10,
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
  brief: "簡短",
  standard: "標準",
  detailed: "精細",
};

// Substitutes every placeholder the persona template understands. Unknown
// placeholders pass through unchanged — caller-provided `AI_PERSONA` overrides
// may or may not use them.
function buildPersonaFromTemplate(template, tier) {
  const replacements = {
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
  return out;
}

function getTierConfig(guildId) {
  const tierKey = getGuildTier(guildId);
  const base = TIERS[tierKey];
  return {
    ...base,
    label: TIER_UI_LABELS[tierKey],
    persona: buildPersonaFromTemplate(AI_PERSONA, base),
  };
}

module.exports = {
  TIERS,
  TIER_UI_LABELS,
  buildPersonaFromTemplate,
  getTierConfig,
};
