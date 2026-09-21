// 「講個故事」 skill — natural-language access to the nightly bedtime-story spec.
//
// Without this, asking 西寶 for a story in ordinary chat gets a story written
// by her chat persona: 2-3 sentences, no title, no craft rules. The nightly
// task's spec (## title, 180-420 字, one scene, two real messages woven in) is
// the version we actually tuned — this makes the same spec reachable by asking.
//
// The spec goes in as a personaSuffix (system role) rather than a user turn:
// it is an instruction about HOW to write, same category as the persona, and
// keeping it out of the user turns leaves the group-context block free to be
// exactly what it is — the ingredients.

const {
  buildStoryCraftBlock,
  sanitizeBedtimeTitle,
} = require("../../bedtime-story");
const { buildStoryMaterial } = require("../story-ingredients");

// A story is 180-420 字 plus a title, which does not fit 入門's 180-token /
// 300-char budget — she would be cut off mid-sentence. These are FLOORS, not
// overrides: a tier already allowing more keeps its own limit.
const STORY_MIN_TOKENS = 900;
const STORY_MIN_REPLY_CHARS = 1200;

// Detection is deliberately LOOSE: the mechanical layer only decides whether
// the pack is worth LOADING, and 西寶 herself decides whether to USE it. That
// split exists because natural language has more ways to ask for a story than a
// regex can enumerate — the first live test missed on 「講一個關於X的故事」
// (2026-09-21) because the verb and 故事 were not neighbours. A tight matcher
// fails silently and unrecoverably; a loose one costs ~2KB of system prompt on
// messages that merely mention 故事, and the craft block's opt-out clause turns
// the false positives back into ordinary chat replies.
//
// Consequence: there are NO negative patterns here. 「剛剛那個故事很好笑」 loads
// the pack and she ignores it, which is exactly the intended behaviour.
const STORY_KEYWORD_RE = /故事|\bstory\b|\bstories\b/i;

function matchStory(text) {
  if (!text || typeof text !== "string") return false;
  return STORY_KEYWORD_RE.test(text.normalize("NFC"));
}

// The pack loads on a bare mention of 故事, so the output is often an ordinary
// chat reply. Forcing `## ` onto the first line of THAT would be worse than the
// bug this normalisation fixes, so it only runs on something already shaped
// like a story: a short title line, a blank line, then body.
function looksLikeStory(text) {
  if (!text || typeof text !== "string") return false;
  const lines = text.split(/\r?\n/);
  if (lines.length < 3) return false;
  if (lines[1].trim() !== "") return false;
  const first = lines[0].trim();
  if (!first) return false;
  if (/^(#|\*)/.test(first)) return true;
  // An unmarked title: short, and not a sentence.
  return first.length <= 30 && !/[。！？!?,，]/.test(first);
}

function normalizeStoryOutput(text) {
  return looksLikeStory(text) ? sanitizeBedtimeTitle(text) : text;
}

module.exports = {
  id: "story",
  label: "說故事",
  match: matchStory,
  async build({ message } = {}) {
    // Gathered per call, not per message: the fetch only happens once the
    // keyword matched, so ordinary chat never pays for it.
    const extraUserContext = await buildStoryMaterial(message);
    return {
      extraUserContext,
      personaSuffix: buildStoryCraftBlock({
        guildName: message?.guild?.name,
        mode: "chat",
        hasExtraMaterial: Boolean(extraUserContext),
      }),
      minTokens: STORY_MIN_TOKENS,
      minReplyChars: STORY_MIN_REPLY_CHARS,
      postProcess: normalizeStoryOutput,
    };
  },
  STORY_MIN_TOKENS,
  STORY_MIN_REPLY_CHARS,
  looksLikeStory,
  normalizeStoryOutput,
};
