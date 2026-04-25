// Fetches recent channel messages so 西寶 can see what the group is talking
// about, not just the message that @ed her. Without this she has no idea what
// "起床重睡" or any sticker means because she only ever sees the @-message.
//
// The block is appended to the per-call system prompt (NOT recorded into conv
// memory), so each call gets a fresh window without bloating history.

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
    formatted.push(line);
    if (formatted.length >= count) break;
  }
  formatted.reverse();
  return formatted;
}

function formatGroupMessage(m) {
  const name =
    m.member?.displayName ||
    m.author?.globalName ||
    m.author?.username ||
    "未知";

  const parts = [];
  if (m.content) parts.push(m.content);

  if (m.stickers?.size > 0) {
    const names = m.stickers.map((s) => s.name).join(", ");
    parts.push(`(貼圖：${names})`);
  }

  if (m.attachments?.size > 0) {
    parts.push("(附件)");
  }

  if (parts.length === 0) return null;
  return `[${name}]: ${parts.join(" ")}`;
}

function buildGroupContextBlock(lines) {
  if (!lines || lines.length === 0) return "";
  return `\n\n## 最近群組對話 (供你了解 context, 不要直接複述)\n${lines.join("\n")}`;
}

module.exports = {
  fetchGroupContext,
  formatGroupMessage,
  buildGroupContextBlock,
};
