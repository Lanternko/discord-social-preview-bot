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

  const reacted = [];
  const reactedAuthors = new Set();
  const ranked = [...nonBot]
    .map((m) => ({ message: m, reactions: messageReactionCount(m) }))
    .filter((entry) => entry.reactions > 0)
    .sort((a, b) => b.reactions - a.reactions);
  for (const entry of ranked) {
    const authorId = entry.message.author?.id || "unknown";
    if (reactedAuthors.has(authorId)) continue;
    reactedAuthors.add(authorId);
    reacted.push(entry.message);
    if (reacted.length >= 4) break;
  }

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

// 每晚只挑幾條，不要全套上去 —— 全部照做會變成另一種公式。
const STORY_CRAFT_MOVES = [
  "開場直接從一句對話或一個動作進去，不要先交代時間、地點、天氣或人物長相。",
  "結局不要靠主角想通了、成長了、和好了來收；讓別人、意外、或某個東西替他決定。",
  "情緒有一半用白話直說（「他很緊張」）或用動作演，不要整篇都是心跳、胸口、氣味。",
  "放一段互相打臉的敘述：同一件事有人記得不一樣，或有人當場否認前面說過的話。",
  "留一個沒有回收的小線頭：某個東西出現過、被提過，最後就擱在那裡沒人處理。",
  "指名一個真實存在的東西（真的歌手、店家、地名、遊戲），不要用「某個知名歌手」這種虛指。",
];

const STORY_CRAFT_MOVE_COUNT = 3;

function pickStoryCraftMoves(moves, count, rng = Math.random) {
  const pool = [...moves];
  const picked = [];
  while (picked.length < count && pool.length > 0) {
    const index = Math.floor(rng() * pool.length) % pool.length;
    picked.push(pool.splice(index, 1)[0]);
  }
  return picked;
}

const TITLE_PREFIX_RE = /^(床邊故事|睡前故事|今日故事)\s*[｜|:\-—–／/]?\s*/;

function sanitizeBedtimeTitle(text) {
  if (!text || typeof text !== "string") return text;
  const lines = text.split(/\r?\n/);
  let first = lines[0].trim();
  first = first.replace(/^\*{1,3}\s*/, "").replace(/\s*\*{1,3}$/, "");
  first = first.replace(/^#+\s*/, "");
  first = first.replace(TITLE_PREFIX_RE, "").trim();
  if (!first) return text;
  lines[0] = `## ${first}`;
  return lines.join("\n");
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
  rng = Math.random,
}) {
  const dateKey = localDateKey(now, schedule?.timezone || "Asia/Taipei");
  const { ingredients, activeChannels } = selectStoryIngredients(
    messages,
    channelStats,
  );

  const lines = [
    `（系統提示：現在是「${guildName || "這個伺服器"}」的睡前故事時間。`,
    "自己發明今晚的故事。不要套固定世界觀（營火、便利商店、太空歌劇、郵局、社團、都市傳說、夢境聊天室、假新聞播報、古董店、舊貨鋪、修理鋪都不要當預設場景），除非今晚素材自己指向那個地方。",
    "",
    "寫作要求：",
    "- 第一行必須是 Markdown 標題：`## ` 加上具體標題（例如 `## 會替人照相的魔法鏡`）。標題裡不要出現「床邊故事」四個字，也不要寫「睡前故事」「今日故事」。故事本文裡提不提都可以。",
    "- 寫一個 180～420 字的原創短故事，有趣、有一個小轉折或誤會。",
    "- 整個故事只有一個場景、一條主線。從素材裡挑剛好兩則、且來自兩個不同的人，融進主線；其餘完全忽略。",
    "- 挑反應數高的、或原句本身就好笑的。單獨拿出來看不出梗的別挑（純數字、比分、時間、「0.0」這種），那是當下在場才好笑的東西，寫進故事只會變成兩個人對著數字吵架。",
    "- 登場人物 2～5 人（含被點名的群友）。不要一個人獨角戲，也不要擠進一堆路人。",
    "- 用到的每一則都要讓看過原訊息的人對得上號，但不必逐字貼原句。梗在詞本身（諧音、錯字、自創詞）就照原樣寫；梗在情境就用演的，讓它自然發生在對話或動作裡，同一個梗不要再引用一次。",
    "- 不准消音：黃腔、髒話、綽號、諧音都照原樣，不要收成暗示或代稱（示範一下這條的意思，這兩句是舊例子不是今晚的素材，不要寫進故事：素材若寫「口交牛肉麵」就照寫，不要收成湯、暗示、某碗麵；「很會運氣了」不要收成運氣）。可以改寫情節，不能裝沒看過。",
    "- 主要物品要少而貫穿：出場的重要物品或角色，大多要再被用到或呼應。",
    "- 角色可以借群友暱稱，讓角色之間有互動和對話。不要編造現實隱私。",
    "- 可以用今天的群聊素材當靈感，但不要做今日回顧，不要流水帳。",
    "- 只有住址、電話、真實姓名這類個資才抽象。",
    "- 排版：標題下一行空白，之後 2～5 段，每段之間空一行。",
    "- 故事在哪裡結束就停。不要為了睡前時段硬接到睡覺、晚安或枕頭。",
    "",
    "【今晚要用的寫法】只做下面這幾條，其他別硬套：",
    ...pickStoryCraftMoves(STORY_CRAFT_MOVES, STORY_CRAFT_MOVE_COUNT, rng).map(
      (move) => `- ${move}`,
    ),
    "）",
    "",
  ];

  if (activeChannels.length > 0) {
    lines.push(`【今晚熱鬧的房間】${activeChannels.join("、")}`);
    lines.push("");
  }

  if (ingredients.length > 0) {
    lines.push("【可用靈感素材】（挑兩個不同人的各一則，用了就要認得出是哪一則）");
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
  sanitizeBedtimeTitle,
  buildBedtimeStoryPrompt,
  STORY_CRAFT_MOVES,
  pickStoryCraftMoves,
};
