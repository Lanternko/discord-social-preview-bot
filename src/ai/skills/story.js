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

// A story is 180-420 字 plus a title, which does not fit 入門's 180-token /
// 300-char budget — she would be cut off mid-sentence. These are FLOORS, not
// overrides: a tier already allowing more keeps its own limit.
const STORY_MIN_TOKENS = 900;
const STORY_MIN_REPLY_CHARS = 1200;

// Someone TALKING ABOUT a story ("剛剛那個故事很好笑") is not asking for one.
// Checked first because the request pattern below would otherwise match it.
const STORY_REFERENCE_RE =
  /(剛剛|剛才|上面|前面|那個|這個|之前|昨天)\s*的?\s*(床邊|睡前)?故事/;

// 「我剛剛講的故事」/「你寫的那個故事」 — someone referring to a story that
// already exists. The 的 is mandatory: without it 「你講故事」 (a request) would
// be swallowed too.
const STORY_AUTHORED_RE =
  /(我|我們|你|妳|他|她|你們|他們)\s*(剛剛|剛才|之前|昨天|上次)?\s*(講|說|寫|編|念|唸)的\s*(那個|這個)?\s*(床邊|睡前)?故事/;

// Request forms: a verb attached to 故事. Deliberately requires the verb —
// a bare 「故事」 in a sentence is far more often commentary than a request,
// and a false positive here is expensive (she writes 400 字 instead of chatting).
const STORY_VERB = "講|說|來|寫|編|念|唸|聽";
const STORY_COUNTER = "一|個|則|下|點|篇|首";
const STORY_KIND = "床邊|睡前|短篇|小|新的|另一個|另一則";

const STORY_REQUEST_RE = new RegExp(
  `(${STORY_VERB})\\s*(${STORY_COUNTER})*\\s*(${STORY_KIND})*\\s*故事`,
);

// 「講一個關於X的故事」 — the most common shape of a real request, and the one
// the adjacent pattern above misses entirely: the topic sits between the verb
// and 故事, so 講…故事 are never neighbours (2026-09-21, a live miss).
// The gap is bounded, must stay inside one sentence, and must end at 的 —
// Chinese topic phrases always land on 的故事, which is what keeps commentary
// like 「你說的話根本不像故事」 out (no second 的 before 故事).
const STORY_TOPIC_RE = new RegExp(
  `(${STORY_VERB})\\s*(${STORY_COUNTER})*\\s*(?:有關|關於)?[^。！？!?\\n]{0,40}的\\s*(${STORY_KIND})*\\s*故事`,
);

const STORY_EN_RE = /\b(tell|write|give)\b[^.!?]{0,24}\bstory\b|bedtime story/i;

function matchStory(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.normalize("NFC");
  if (STORY_REFERENCE_RE.test(t) || STORY_AUTHORED_RE.test(t)) return false;
  return STORY_REQUEST_RE.test(t) || STORY_TOPIC_RE.test(t) || STORY_EN_RE.test(t);
}

module.exports = {
  id: "story",
  label: "說故事",
  match: matchStory,
  build({ message } = {}) {
    return {
      personaSuffix: buildStoryCraftBlock({
        guildName: message?.guild?.name,
        mode: "chat",
      }),
      minTokens: STORY_MIN_TOKENS,
      minReplyChars: STORY_MIN_REPLY_CHARS,
      postProcess: sanitizeBedtimeTitle,
    };
  },
  STORY_MIN_TOKENS,
  STORY_MIN_REPLY_CHARS,
};
