// Emoji reactions for 西寶 AI replies — she writes [反應:名字] and the bot
// reacts to the message she is answering with that emoji.
//
// Flow (mirrors sticker-resolver):
//   1. buildReactionPromptBlock()      — rules for the system prompt (the
//      emoji table itself is already there via buildEmojiPromptBlock)
//   2. extractReactions(text, emojiMap) — pull [反應:…] out of the AI output
//
// Must run BEFORE resolveCustomEmojis: that pass strips every Unicode emoji
// and would turn [反應:👍] into a dangling "[反應:]".
//
// Reaction-only replies (no text) are deliberately NOT offered yet: an @ that
// gets nothing but an emoji reads as being ignored. The prompt asks for text
// every time; the caller handles a reply that ends up empty anyway.
//
// Pure (no discord.js) so the parse logic is unit-testable.

const { resolveEmojiEntry } = require("./emoji-resolver");

// Brackets are REQUIRED (a bare「反應：」is normal prose). Half/fullwidth
// brackets and colons are accepted because the model drifts between them.
const REACTION_TOKEN_RE =
  /[[［【]\s*(?:反應|反应|react|reaction)\s*[:：]\s*([^\]］】\n]{1,64}?)\s*[\]］】]/gi;

// The persona bans Unicode emoji in text, but a 👍 / 😂 reaction is the most
// natural thing a person does — so a short, fixed set is allowed here only.
const UNICODE_REACTIONS = ["👍", "😂", "❤️", "😭", "😮", "🙏", "👀", "🔥", "🤔", "😳"];
const UNICODE_SET = new Set(UNICODE_REACTIONS.map((e) => e.replace(/️/g, "")));

// Not a behavioural cap — restraint lives in the prompt (usually 0-1). This is
// Discord's own ceiling: a message holds at most 20 distinct reactions, so
// anything past it would only 400. Lets her honour "按我五個" literally.
// More reads as spam.
const MAX_REACTIONS = 20;

function resolveReaction(raw, emojiMap) {
  const token = String(raw || "").normalize("NFC").trim();
  if (!token) return null;

  const bare = token.replace(/️/g, "");
  if (UNICODE_SET.has(bare)) {
    const emoji = UNICODE_REACTIONS.find((e) => e.replace(/️/g, "") === bare);
    return { kind: "unicode", key: bare, emoji };
  }

  // <:name:id> / <a:name:id> / :name: / name — all resolve by name against the
  // same map the text emoji use, so she can only react with what she can type.
  const m = token.match(/^<?a?[:：]?([A-Za-z0-9_]+)[:：]?(?:\d{5,25})?>?$/);
  if (!m) return null;
  const resolved = resolveEmojiEntry(m[1], emojiMap);
  if (!resolved) return null;
  return {
    kind: "custom",
    key: resolved.emoji.id,
    name: resolved.name,
    id: resolved.emoji.id,
    animated: !!resolved.emoji.animated,
  };
}

// Returns { text, reactions } — reactions are deduped, capped at
// MAX_REACTIONS, unknown names dropped (logged) rather than left as literal
// "[反應:xxx]" in chat.
function extractReactions(text, emojiMap) {
  const input = String(text ?? "");
  if (!/反應|反应|react/i.test(input)) return { text: input, reactions: [] };

  const reactions = [];
  const seen = new Set();
  REACTION_TOKEN_RE.lastIndex = 0;
  const stripped = input.replace(REACTION_TOKEN_RE, (match, name) => {
    const entry = resolveReaction(name, emojiMap);
    if (!entry) {
      console.log(`[react] dropped unknown [反應:${name.trim()}]`);
    } else if (!seen.has(entry.key) && reactions.length < MAX_REACTIONS) {
      seen.add(entry.key);
      reactions.push(entry);
    }
    return "";
  });

  if (stripped === input) return { text: input, reactions: [] };

  const cleaned = stripped
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .replace(/ +([,，。、！？!?…：])/g, "$1")
    .trim();

  return { text: cleaned, reactions };
}

// What message.react() accepts: the Unicode char, or "name:id" for custom.
function reactionIdentifier(entry) {
  if (!entry) return null;
  return entry.kind === "unicode" ? entry.emoji : `${entry.animated ? "a:" : ""}${entry.name}:${entry.id}`;
}

function buildReactionPromptBlock() {
  return [
    "",
    "",
    "## 按表情（反應）",
    "你可以在對方那則訊息上按表情，就像大家看到好笑的會按 😂 一樣：在回覆裡寫 `[反應:名字]`，系統會幫你按，這段字不會出現在訊息裡。",
    `名字可以是上面群組 emoji 表裡的名字（例如 \`[反應:名字]\` 不用加冒號），或這幾個系統表情：${UNICODE_REACTIONS.join(" ")}（只有按表情能用系統表情，句子裡照樣禁止）。`,
    "規則：**一定還要回文字，不能只按表情不講話**；平常不是每則都要按，對方講到讓你有明顯情緒（好笑、感動、驚訝、被誇）時按 1 個就好，別一次按一排。",
    `對方明確叫你按（「按我一個 XX」「按三個」）就照做，按幾個照他說的，你說按了就真的要寫出標記；Discord 一則訊息最多 ${MAX_REACTIONS} 種，超過才講做不到，別自己編「群規只能按兩個」之類的理由。名字表裡沒有的別硬掰，掰了會直接消失。`,
  ].join("\n");
}

module.exports = {
  REACTION_TOKEN_RE,
  UNICODE_REACTIONS,
  MAX_REACTIONS,
  resolveReaction,
  extractReactions,
  reactionIdentifier,
  buildReactionPromptBlock,
};
