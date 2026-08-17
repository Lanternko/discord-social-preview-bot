const { updateSchedule } = require("./schedule-store");
const { trimDescription, sanitizeName } = require("./utils");

const BEDTIME_LOOKBACK_MS = 18 * 60 * 60 * 1000;
const MAX_INGREDIENTS = 8;

function localDateKey(now = new Date(), timeZone = "Asia/Taipei") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function messageReactionCount(message) {
  if (!message?.reactions?.cache) return 0;
  let total = 0;
  for (const reaction of message.reactions.cache.values()) {
    total += reaction.count || 0;
  }
  return total;
}

function messageDisplayName(message) {
  return sanitizeName(
    message?.member?.displayName ||
      message?.author?.globalName ||
      message?.author?.username ||
      "未知",
  );
}

function messagePreview(message) {
  const raw = (message?.content || "").replace(/\s+/g, " ").trim();
  if (raw) {
    const withoutUrls = raw.replace(/https?:\/\/\S+/g, "[連結]").trim();
    return trimDescription(withoutUrls, 90);
  }

  const sticker = message?.stickers?.first?.();
  if (sticker?.name) return `貼圖：${sanitizeName(sticker.name)}`;

  if (message?.attachments?.size > 0) return "圖片或附件";
  if (message?.embeds?.length > 0) return "嵌入連結";
  return "";
}

function selectStoryIngredients(messages, channelStats, limit = MAX_INGREDIENTS) {
  const nonBot = messages
    .filter((m) => !m.author?.bot)
    .filter((m) => messagePreview(m));

  const reacted = [...nonBot]
    .map((m) => ({ message: m, reactions: messageReactionCount(m) }))
    .filter((entry) => entry.reactions > 0)
    .sort((a, b) => b.reactions - a.reactions)
    .slice(0, 4)
    .map((entry) => entry.message);

  const recent = [...nonBot]
    .sort((a, b) => {
      const atA = a.createdTimestamp || a.createdAt?.getTime?.() || 0;
      const atB = b.createdTimestamp || b.createdAt?.getTime?.() || 0;
      return atB - atA;
    })
    .slice(0, 10);

  const seen = new Set();
  const ingredients = [];
  for (const message of [...reacted, ...recent]) {
    const preview = messagePreview(message);
    const key = `${message.author?.id || "unknown"}:${preview}`;
    if (!preview || seen.has(key)) continue;
    seen.add(key);
    ingredients.push({
      authorName: messageDisplayName(message),
      channelName: sanitizeName(message.channel?.name || "未知頻道"),
      preview,
      reactions: messageReactionCount(message),
    });
    if (ingredients.length >= limit) break;
  }

  const activeChannels = (channelStats || [])
    .slice(0, 4)
    .map((c) => `#${sanitizeName(c.name)}（${c.count} 則）`);

  return { ingredients, activeChannels };
}

function markBedtimeStoryUsed(schedule, dateKey) {
  if (!schedule?.id || !dateKey) return null;
  return updateSchedule(schedule.id, {
    lastStoryDate: dateKey,
  });
}

function buildBedtimeStoryPrompt({
  guildName,
  messages = [],
  channelStats = [],
  schedule = {},
  now = new Date(),
}) {
  const dateKey = localDateKey(now, schedule?.timezone || "Asia/Taipei");
  const { ingredients, activeChannels } = selectStoryIngredients(
    messages,
    channelStats,
  );

  const lines = [
    `（系統提示：現在是「${guildName || "這個伺服器"}」的睡前故事時間。`,
    "自己發明今晚的故事。不要套固定世界觀（營火、便利商店、太空歌劇、郵局、社團、都市傳說、夢境聊天室、假新聞播報都不要當預設場景），除非今晚素材自己指向那個地方。",
    "",
    "寫作要求：",
    "- 寫一個 180～420 字的原創短故事，有趣、有一個小轉折或誤會。",
    "- 整個故事只有一個場景、一條主線。從素材裡挑 2～3 則融進主線，其餘完全忽略。",
    "- 用到的每一則都要讓看過原訊息的人對得上號：留下原句裡最好認的專有物或碎片（「很會運氣了」不能收成「運氣」；「牛肉麵」不能收成「湯」）。可以改寫情節，不能蒸發辨識點。",
    "- 主要物品要少而貫穿：出場的重要物品或角色，後面都要再被用到或呼應。",
    "- 角色可以借群友暱稱，讓角色之間有互動和對話。不要冒犯，不要編造現實隱私。",
    "- 可以用今天的群聊素材當靈感，但不要做今日回顧，不要流水帳。",
    "- 只有真的吵架、個資才抽象成道具或天氣。黃色玩笑可以含蓄，但專有名詞要留著。",
    "- 排版要好讀：2～5 段，每段之間空一行。",
    "- 故事在哪裡結束就停。不要為了睡前時段硬接到睡覺、晚安或枕頭。）",
    "",
  ];

  if (activeChannels.length > 0) {
    lines.push(`【今晚熱鬧的房間】${activeChannels.join("、")}`);
    lines.push("");
  }

  if (ingredients.length > 0) {
    lines.push("【可用靈感素材】（挑 2～3 則，用了就要認得出是哪一則）");
    for (const item of ingredients) {
      const reacted = item.reactions > 0 ? `，反應 ${item.reactions}` : "";
      lines.push(
        `- ${item.authorName} 在 #${item.channelName}：${item.preview}${reacted}`,
      );
    }
  } else {
    lines.push("【可用靈感素材】今天聊天素材很少，請自己創作一個安靜但有趣的小故事。");
  }

  return {
    prompt: lines.join("\n"),
    dateKey,
    ingredientCount: ingredients.length,
    buffet: ingredients.map(
      (item) => `${item.authorName}/#${item.channelName}:${item.preview}`,
    ),
  };
}

module.exports = {
  BEDTIME_LOOKBACK_MS,
  localDateKey,
  messagePreview,
  selectStoryIngredients,
  markBedtimeStoryUsed,
  buildBedtimeStoryPrompt,
};
