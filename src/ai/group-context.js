// Fetches recent channel messages so 西寶 can see what the group is talking
// about, not just the message that @ed her. Without this she has no idea what
// "起床重睡" or any sticker means because she only ever sees the @-message.
//
// The block is injected as a per-call user-role context turn (NOT recorded into
// conv memory), so each call gets a fresh window without bloating history.

async function fetchGroupContext(channel, count, beforeMessageId, botUserId) {
  if (!channel || count <= 0) return [];

  let messages;
  try {
    // Overshoot the fetch a bit so bot/empty messages can be filtered out
    // without coming up short. Discord caps fetch at 100.
    messages = await channel.messages.fetch({
      limit: Math.min(count + 5, 100),
      before: beforeMessageId,
    });
  } catch (err) {
    console.warn(`[group-context] fetch failed: ${err.message}`);
    return [];
  }

  const formatted = [];
  // discord.js Collection iterates newest-first; filter, cap, then reverse to
  // chronological so the model reads them in the order they were sent.
  for (const m of messages.values()) {
    if (botUserId && m.author?.id === botUserId) continue;
    const line = formatGroupMessage(m);
    if (!line) continue;
    formatted.push({
      line,
      userId: m.author?.id ?? null,
      displayName:
        m.member?.displayName ||
        m.author?.globalName ||
        m.author?.username ||
        null,
      // Identity of the underlying Discord message, so downstream personal-
      // memory scooping can dedup by messageId instead of by text.
      messageId: m.id ?? null,
      at: m.createdTimestamp ?? null,
    });
    if (formatted.length >= count) break;
  }
  formatted.reverse();
  return formatted;
}

const { sanitizeName } = require("../utils");

function formatGroupMessage(m) {
  const name = sanitizeName(
    m.member?.displayName ||
    m.author?.globalName ||
    m.author?.username,
  );

  const parts = [];
  if (m.content) parts.push(m.content);

  if (m.stickers?.size > 0) {
    const names = m.stickers.map((s) => s.name).join(", ");
    parts.push(`(貼圖：${names})`);
  }

  if (m.attachments?.size > 0) {
    parts.push("(附件)");
  }

  if (m.reactions?.cache?.size > 0) {
    const rxns = m.reactions.cache
      .filter((r) => r.count > 0)
      .map((r) => `${r.emoji.name}×${r.count}`)
      .join(", ");
    if (rxns) parts.push(`(react：${rxns})`);
  }

  if (parts.length === 0) return null;
  return `[${name}]: ${parts.join(" ")}`;
}

function buildGroupContextBlock(entries) {
  if (!entries || entries.length === 0) return "";
  const lines = entries.map((e) => (typeof e === "string" ? e : e.line));
  return `\n\n## 最近群組對話 (供你了解 context, 不要直接複述)\n${lines.join("\n")}`;
}

// Renders the message a reply points at into a context turn. The bot's own
// scheduled posts (recap / bedtime story) never enter conv memory and are
// filtered out of group context, so when someone REPLIES to one this is the
// only way 西寶 sees what she's being asked about. `isSelf` makes her own
// authorship explicit so she owns the post instead of playing dumb.
function buildReplyContextBlock({ content, authorName, isSelf } = {}) {
  const text = (content || "").trim();
  if (!text) return "";
  const who = isSelf ? "你自己稍早" : `${authorName || "某人"}稍早`;
  return `## 對方正在回覆的訊息\n（${who}說過：「${text}」。對方這句話是在回應這段，請據此理解，別當作沒看過。）`;
}

module.exports = {
  fetchGroupContext,
  formatGroupMessage,
  buildGroupContextBlock,
  buildReplyContextBlock,
};
