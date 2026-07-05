const { updateSchedule } = require("./schedule-store");
const { trimDescription, sanitizeName } = require("./utils");

const BEDTIME_LOOKBACK_MS = 18 * 60 * 60 * 1000;
const RECENT_STORY_SEED_LIMIT = 7;
const MAX_INGREDIENTS = 8;

const STORY_MODES = [
  {
    key: "campfire-rpg",
    label: "營火 RPG 小任務",
    hint: "把今天的素材變成一個小隊任務，有道具、有小轉折，最後大家在營火旁收隊睡覺。",
  },
  {
    key: "convenience-store",
    label: "深夜便利商店奇遇",
    hint: "故事發生在半夜便利商店，把群聊素材變成貨架、客人或神秘商品。",
  },
  {
    key: "dream-chatroom",
    label: "夢境聊天室",
    hint: "把伺服器想像成一間夢裡的聊天室，頻道變房間，訊息變會發光的小紙條。",
  },
  {
    key: "soft-urban-legend",
    label: "可愛版都市傳說",
    hint: "用都市傳說的開頭，但結局必須溫柔、好笑、不可怕。",
  },
  {
    key: "school-club",
    label: "放學後社團小劇場",
    hint: "把今天的素材變成社團活動，大家像在收拾社辦一樣把一天收尾。",
  },
  {
    key: "tiny-space-opera",
    label: "迷你太空歌劇",
    hint: "把群聊素材變成星球、訊號或宇宙任務，規模很大但語氣要笨拙可愛。",
  },
  {
    key: "fake-news-lullaby",
    label: "晚安假新聞播報",
    hint: "用一本正經播報荒謬小新聞的方式開場，慢慢轉成睡前故事。",
  },
  {
    key: "forest-post-office",
    label: "森林郵局",
    hint: "把今天的訊息變成寄給夜晚的信，郵差把信送到月亮或枕頭旁。",
  },
];

function stringHash(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

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

function pickStoryMode(schedule, now = new Date()) {
  const recent = Array.isArray(schedule?.recentStorySeeds)
    ? schedule.recentStorySeeds
    : [];
  const dateKey = localDateKey(now, schedule?.timezone || "Asia/Taipei");
  const base = stringHash(`${schedule?.id || "bedtime"}:${dateKey}`);

  for (let offset = 0; offset < STORY_MODES.length; offset++) {
    const mode = STORY_MODES[(base + offset) % STORY_MODES.length];
    if (!recent.includes(mode.key)) {
      return { mode, dateKey };
    }
  }

  return {
    mode: STORY_MODES[base % STORY_MODES.length],
    dateKey,
  };
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

function markBedtimeStoryUsed(schedule, modeKey, dateKey) {
  if (!schedule?.id || !modeKey) return null;
  const recent = Array.isArray(schedule.recentStorySeeds)
    ? schedule.recentStorySeeds
    : [];
  const nextRecent = [modeKey, ...recent.filter((key) => key !== modeKey)]
    .slice(0, RECENT_STORY_SEED_LIMIT);
  return updateSchedule(schedule.id, {
    recentStorySeeds: nextRecent,
    lastStoryMode: modeKey,
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
  const { mode, dateKey } = pickStoryMode(schedule, now);
  const { ingredients, activeChannels } = selectStoryIngredients(
    messages,
    channelStats,
  );

  const lines = [
    `（系統提示：現在是「${guildName || "這個伺服器"}」的睡前故事時間。`,
    `今晚故事模式：${mode.label}`,
    `模式說明：${mode.hint}`,
    "",
    "寫作要求：",
    "- 寫一個 180～420 字的原創短故事，溫柔但要有趣，不要只是普通心靈雞湯。",
    "- 必須有一個小轉折或好笑的誤會，最後自然收束到晚安。",
    "- 整個故事只有一個場景、一條主線。素材是自助餐不是套餐：挑 1～3 個最有畫面感的融進主線（變成對話、動機或轉折），其餘素材完全忽略——寧可少用，不要硬塞。",
    "- 主要物品要少而貫穿：出場的重要物品或角色，後面都要再被用到或呼應；只出現一次、對主線沒作用的東西就刪掉。背景可以放一兩個不搶戲的小點綴，但不能打斷閱讀。",
    "- 角色可以借群友暱稱（當主角或路人都行），也可以是原創角色；讓角色之間有互動和對話，不要各自獨白。不要冒犯，不要編造現實隱私。",
    "- 可以用今天的群聊素材當靈感，但不要做今日回顧，不要流水帳。",
    "- 如果素材像吵架、敏感議題或個資，只把它抽象成道具或天氣，不要重述。",
    "- 排版要好讀：2～5 段，每段之間空一行。",
    "- 結尾用西寶自己的語氣哄大家睡覺，短短一句就好。）",
    "",
  ];

  if (activeChannels.length > 0) {
    lines.push(`【今晚熱鬧的房間】${activeChannels.join("、")}`);
    lines.push("");
  }

  if (ingredients.length > 0) {
    lines.push("【可用靈感素材】（自助餐：挑 1～3 個就好，不必全用）");
    for (const item of ingredients) {
      const reacted = item.reactions > 0 ? `，反應 ${item.reactions}` : "";
      lines.push(
        `- ${item.authorName} 在 #${item.channelName}：${item.preview}${reacted}`,
      );
    }
  } else {
    lines.push("【可用靈感素材】今天聊天素材很少，請自己創作一個安靜但有趣的小故事。");
  }

  const recent = Array.isArray(schedule?.recentStorySeeds)
    ? schedule.recentStorySeeds
    : [];
  if (recent.length > 0) {
    lines.push("");
    lines.push(`【最近用過的故事模式】${recent.join("、")}，今晚請避免太像。`);
  }

  return {
    prompt: lines.join("\n"),
    modeKey: mode.key,
    dateKey,
  };
}

module.exports = {
  BEDTIME_LOOKBACK_MS,
  RECENT_STORY_SEED_LIMIT,
  STORY_MODES,
  localDateKey,
  pickStoryMode,
  messagePreview,
  selectStoryIngredients,
  markBedtimeStoryUsed,
  buildBedtimeStoryPrompt,
};
