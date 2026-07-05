// Fetches the past 24 h of messages from ALL text channels in a guild and
// builds recap stats for the scheduler's `daily_recap` task type.

const { ChannelType } = require("discord.js");
const { formatGroupMessage } = require("./ai/group-context");

const MAX_FETCH_PER_CHANNEL = 200;
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

// Surrounding messages attached to each top-reacted message so the recap
// model can tell WHAT was funny — a sticker or a one-liner like「好小…」is
// meaningless without the conversation around it. Pulled from the already
// fetched 24 h pool, so this costs zero extra Discord API calls.
const RECAP_CONTEXT_BEFORE = 4;
const RECAP_CONTEXT_AFTER = 2;
const RECAP_CONTEXT_LINE_MAX = 120;

// ── Fetch ───────────────────────────────────────────────────────────────

async function fetchChannelMessages(channel, lookbackMs = LOOKBACK_MS) {
  const cutoff = new Date(Date.now() - lookbackMs);
  const messages = [];
  let lastId = null;

  while (messages.length < MAX_FETCH_PER_CHANNEL) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    let batch;
    try {
      batch = await channel.messages.fetch(options);
    } catch {
      // No permission or channel issue — skip silently.
      break;
    }

    if (batch.size === 0) break;

    let reachedCutoff = false;
    for (const msg of batch.values()) {
      if (msg.createdAt < cutoff) {
        reachedCutoff = true;
        break;
      }
      messages.push(msg);
    }

    if (reachedCutoff) break;
    lastId = batch.last().id;
  }

  return messages;
}

async function fetchGuildMessages(guild, lookbackMs = LOOKBACK_MS) {
  // Gather all text-based channels the bot can see.
  const textChannels = guild.channels.cache.filter(
    (ch) =>
      (ch.type === ChannelType.GuildText ||
        ch.type === ChannelType.GuildAnnouncement) &&
      ch.viewable,
  );

  const allMessages = [];
  const channelStats = [];

  for (const [, channel] of textChannels) {
    const msgs = await fetchChannelMessages(channel, lookbackMs);
    if (msgs.length > 0) {
      allMessages.push(...msgs);
      const humanCount = msgs.filter((m) => !m.author?.bot).length;
      if (humanCount > 0) {
        channelStats.push({ name: channel.name, id: channel.id, count: humanCount });
      }
    }
  }

  // Sort channels by activity for the prompt.
  channelStats.sort((a, b) => b.count - a.count);

  console.log(
    `[daily-recap] scanned ${textChannels.size} channels, ${allMessages.length} total messages across ${channelStats.length} active channels`,
  );

  return { messages: allMessages, channelStats };
}

// ── Stats ───────────────────────────────────────────────────────────────

// What the reacted message itself "said" — sticker names and attachment kind
// beat the old opaque「（圖片/貼圖/嵌入）」placeholder.
function buildMessagePreview(m) {
  if (m.content) {
    return m.content.length > 60 ? m.content.slice(0, 60) + "…" : m.content;
  }
  if (m.stickers?.size > 0) {
    const names = m.stickers.map((s) => s.name).join("、");
    return `（貼圖：${names}）`;
  }
  if (m.attachments?.size > 0) return "（圖片/附件）";
  return "（嵌入/連結）";
}

// Surrounding messages from the same channel, chronological, with the target
// marked so the model knows which line got the reactions.
function buildMessageContext(target, channelMessagesAsc) {
  const idx = channelMessagesAsc.findIndex((m) => m.id === target.id);
  if (idx === -1) return [];
  const start = Math.max(0, idx - RECAP_CONTEXT_BEFORE);
  const end = Math.min(channelMessagesAsc.length, idx + RECAP_CONTEXT_AFTER + 1);

  const lines = [];
  for (let i = start; i < end; i++) {
    const m = channelMessagesAsc[i];
    let line = formatGroupMessage(m);
    if (!line) continue;
    if (line.length > RECAP_CONTEXT_LINE_MAX) {
      line = line.slice(0, RECAP_CONTEXT_LINE_MAX) + "…";
    }
    if (i === idx) line += "　← 就是這句拿到反應";
    lines.push(line);
  }
  return lines;
}

function buildRecapStats(messages) {
  // Per-channel chronological index for context lookup.
  const byChannel = new Map();
  for (const m of messages) {
    const chId = m.channelId ?? m.channel?.id;
    if (!chId) continue;
    if (!byChannel.has(chId)) byChannel.set(chId, []);
    byChannel.get(chId).push(m);
  }
  for (const list of byChannel.values()) {
    list.sort((a, b) => (a.createdTimestamp ?? 0) - (b.createdTimestamp ?? 0));
  }
  const nonBotMessages = messages.filter((m) => !m.author?.bot);

  // Per-author message count
  const authorMap = new Map();
  for (const msg of nonBotMessages) {
    const id = msg.author.id;
    const name =
      msg.member?.displayName ||
      msg.author?.globalName ||
      msg.author?.username ||
      "未知";
    if (!authorMap.has(id)) {
      authorMap.set(id, { name, count: 0 });
    }
    authorMap.get(id).count++;
  }

  // Messages with reactions (include bot messages — people reacting to 西寶
  // is interesting too)
  // Weighted score: top emoji counts more than spread-out reactions.
  // 70% × 1st + 30% × 2nd + 10% × 3rd
  const REACTION_WEIGHTS = [0.7, 0.3, 0.1];

  const reactedMessages = messages
    .filter((m) => m.reactions.cache.size > 0)
    .map((m) => {
      const reactionList = [];
      const counts = [];
      for (const r of m.reactions.cache.values()) {
        const emojiStr = r.emoji.id ? `[${r.emoji.name}]` : r.emoji.name;
        reactionList.push(`${emojiStr}×${r.count}`);
        counts.push(r.count);
      }
      counts.sort((a, b) => b - a);
      const score = REACTION_WEIGHTS.reduce(
        (sum, w, i) => sum + w * (counts[i] || 0),
        0,
      );
      const totalReactions = counts.reduce((a, b) => a + b, 0);
      const authorName =
        m.member?.displayName ||
        m.author?.globalName ||
        m.author?.username ||
        "未知";
      const channelName = m.channel?.name || "未知頻道";
      return {
        authorName,
        channelName,
        preview: buildMessagePreview(m),
        totalReactions,
        score,
        reactionStr: reactionList.join(" "),
        isBot: m.author?.bot ?? false,
        _msg: m,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(({ _msg, ...entry }) => ({
      ...entry,
      context: buildMessageContext(
        _msg,
        byChannel.get(_msg.channelId ?? _msg.channel?.id) || [],
      ),
    }));

  const topAuthors = [...authorMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  return {
    totalMessages: nonBotMessages.length,
    uniqueAuthors: authorMap.size,
    topReacted: reactedMessages,
    topAuthors,
  };
}

// ── Prompt builder ──────────────────────────────────────────────────────

function buildRecapPrompt(stats, channelStats, guildName) {
  if (stats.totalMessages === 0) {
    return "（系統提示：今天整個伺服器一條訊息都沒有。請用你的風格感嘆今天好安靜，鼓勵大家明天多聊天。簡短就好。）";
  }

  const lines = [
    [
      `（系統提示：以下是「${guildName}」整個伺服器過去 24 小時的聊天統計。請用你平常的風格做一個輕鬆有趣的今日回顧。`,
      "格式要求：",
      "- 引用別人說的話時用 \\` 反引號 \\` 包裹，絕對不要用 * 星號（會變斜體）。",
      "- 你認識這些人，用你平常叫他們的方式稱呼（綽號、簡稱），不要生硬地打全名。",
      "- 不要照搬數據格式，用自然聊天的方式分享。",
      "排版要求：",
      "- 每個段落之間要空一行（兩個換行），不要整段擠在一起。",
      "- 大致分成：開頭總結一段 → 每個熱門訊息各一小段 → 結尾一段。",
      "內容要求：",
      "- 先聊聊今天整體的熱鬧程度，哪個頻道最活躍、誰講最多話。",
      "- 然後分享幾個最受歡迎的訊息（有表情反應的），每個都聊一兩句你的感想。",
      "- 每則熱門訊息下面附有「前後文」，先讀懂當時在聊什麼再寫感想——特別是貼圖或短句，光看那一句猜不出笑點。前後文只是給你理解用的，不要照抄、不要逐條複述。",
      "- 如果看了前後文還是不確定在聊什麼，就老實承認沒看懂、表達好奇就好，不要瞎編劇情。",
      "- 結尾可以有個簡短的感想或期待。）",
    ].join("\n"),
    "",
    "【今日數據】",
    `全伺服器共 ${stats.totalMessages} 條訊息，${stats.uniqueAuthors} 位群友發言`,
  ];

  if (channelStats.length > 0) {
    const top = channelStats.slice(0, 5);
    lines.push(
      `最熱鬧的頻道：${top.map((c) => `#${c.name}（${c.count} 條）`).join("、")}`,
    );
  }

  if (stats.topAuthors.length > 0) {
    lines.push(
      `最活躍的人：${stats.topAuthors.map((a) => `${a.name}（${a.count} 條）`).join("、")}`,
    );
  }

  if (stats.topReacted.length > 0) {
    lines.push("");
    lines.push("【最受歡迎的訊息（按反應熱度排序）】");
    for (let i = 0; i < stats.topReacted.length; i++) {
      const msg = stats.topReacted[i];
      lines.push(
        `${i + 1}. ${msg.authorName} 在 #${msg.channelName}：「${msg.preview}」— ${msg.reactionStr}（共 ${msg.totalReactions} 個反應）`,
      );
      if (msg.context?.length > 0) {
        lines.push("   前後文：");
        for (const ctxLine of msg.context) {
          lines.push(`   ${ctxLine}`);
        }
      }
    }
  } else {
    lines.push("今天沒有人按任何表情反應。");
  }

  return lines.join("\n");
}

module.exports = {
  MAX_FETCH_PER_CHANNEL,
  LOOKBACK_MS,
  RECAP_CONTEXT_BEFORE,
  RECAP_CONTEXT_AFTER,
  fetchChannelMessages,
  fetchGuildMessages,
  buildMessagePreview,
  buildMessageContext,
  buildRecapStats,
  buildRecapPrompt,
};
