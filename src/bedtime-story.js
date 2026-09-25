const { updateSchedule } = require("./schedule-store");
const { trimDescription, sanitizeName } = require("./utils");
const { collectFromMessage } = require("./ai/vision");

const BEDTIME_LOOKBACK_MS = 18 * 60 * 60 * 1000;
const MAX_INGREDIENTS = 8;
// Preceding lines shown with each ingredient. A line lifted out of its thread
// loses the joke — 「專家都用vscode 寫黃文的」 is only funny next to SAB's
// 「預設讀 txt 的軟體是 vscode」 right before it.
const CONTEXT_LINES = 2;
const CONTEXT_WINDOW_MS = 10 * 60 * 1000;
// Someone else talking within this window (either side) = a back-and-forth,
// which makes better story material than a line nobody answered.
const EXCHANGE_WINDOW_MS = 5 * 60 * 1000;
// One busy thread (a game-stats argument) once filled 4 of 8 slots with
// near-identical number talk. Cap the recency fill per channel.
const MAX_RECENT_PER_CHANNEL = 2;

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

function messageTimestamp(message) {
  return message?.createdTimestamp || message?.createdAt?.getTime?.() || 0;
}

// What's left of a message once links, custom emoji, mentions and symbols are
// gone. 26% of 30 nights' ingredients were 「圖片或附件」/[連結]/emoji/@ — the
// story model can't build anything on those.
function storyText(message) {
  const raw = (message?.content || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const text = raw.replace(/https?:\/\/\S+/g, "[連結]").trim();
  const substance = text
    .replace(/\[連結\]/g, "")
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/<(@[!&]?|#)\d+>/g, "")
    .replace(/[\p{P}\p{S}\p{Z}\p{Extended_Pictographic}\u200d\ufe0f]/gu, "");
  if ([...substance].length < 2) return "";
  return trimDescription(text, 90);
}

function sameChannel(a, b) {
  const idA = a?.channel?.id ?? a?.channelId ?? a?.channel?.name;
  const idB = b?.channel?.id ?? b?.channelId ?? b?.channel?.name;
  return idA === idB;
}

function storyContext(message, humans) {
  const at = messageTimestamp(message);
  return humans
    .filter((m) => m !== message && sameChannel(m, message))
    .filter((m) => {
      const t = messageTimestamp(m);
      return t < at && at - t <= CONTEXT_WINDOW_MS;
    })
    .sort((a, b) => messageTimestamp(b) - messageTimestamp(a))
    .map((m) => ({ m, text: storyText(m) }))
    .filter((entry) => entry.text)
    .slice(0, CONTEXT_LINES)
    .reverse()
    .map((entry) => `${messageDisplayName(entry.m)}：${entry.text}`);
}

function hasExchange(message, humans) {
  const at = messageTimestamp(message);
  const authorId = message.author?.id;
  return humans.some(
    (m) =>
      m.author?.id !== authorId &&
      sameChannel(m, message) &&
      Math.abs(messageTimestamp(m) - at) <= EXCHANGE_WINDOW_MS,
  );
}

// An ingredient is either real text or an image the vision step can describe.
// Stickers, bare links, emoji and embeds are dropped.
function selectStoryIngredients(messages, channelStats, limit = MAX_INGREDIENTS) {
  const humans = messages.filter((m) => !m.author?.bot);
  const usable = humans.filter(
    (m) => storyText(m) || collectFromMessage(m).length > 0,
  );

  const reacted = [];
  const reactedAuthors = new Set();
  const ranked = [...usable]
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

  const recent = [...usable]
    .map((m) => ({ message: m, exchange: hasExchange(m, humans) }))
    .sort(
      (a, b) =>
        Number(b.exchange) - Number(a.exchange) ||
        messageTimestamp(b.message) - messageTimestamp(a.message),
    )
    .map((entry) => entry.message)
    .filter((m, _i, all) => {
      const sameCh = all.filter((other) => sameChannel(other, m));
      return sameCh.indexOf(m) < MAX_RECENT_PER_CHANNEL;
    })
    .slice(0, 10);

  const seen = new Set();
  const ingredients = [];
  for (const message of [...reacted, ...recent]) {
    const preview = storyText(message);
    const key = preview ? `${message.author?.id || "unknown"}:${preview}` : message;
    if (seen.has(key)) continue;
    seen.add(key);
    ingredients.push({
      authorName: messageDisplayName(message),
      channelName: sanitizeName(message.channel?.name || "未知頻道"),
      preview,
      context: storyContext(message, humans),
      images: collectFromMessage(message).slice(0, 1),
      reactions: messageReactionCount(message),
    });
    if (ingredients.length >= limit) break;
  }

  const activeChannels = (channelStats || [])
    .slice(0, 4)
    .map((c) => `#${sanitizeName(c.name)}（${c.count} 則）`);

  return { ingredients, activeChannels };
}

const STORY_CRAFT_MOVES = [
  "開場直接從一句對話或一個動作進去，不要先交代時間、地點、天氣或人物長相。",
  "情緒有一半用白話直說（「他很緊張」）或用動作演，不要整篇都是心跳、胸口、氣味。",
  "指名一個真實存在的東西（真的歌手、店家、地名、遊戲），不要用「某個知名歌手」這種虛指。",
];

const STORY_CRAFT_MOVE_COUNT = 2;

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

// ── Prompt blocks ───────────────────────────────────────────────────────
// The spec (how to write a story) and the ingredients (what tonight's story is
// made of) are separate concerns AND belong in different role slots. The
// scheduled task feeds both as one user turn; the chat skill puts only the
// spec into the system prompt (personaSuffix) and lets the group-context block
// chain.js already injects serve as its ingredients. Keep them apart.
//
// `mode` is "scheduled" (nightly task) or "chat" (someone asked in 一般聊天).
// Only the framing differs — the craft rules themselves are shared, because a
// good story is a good story whichever way she was asked.
function buildStoryCraftBlock({
  guildName,
  mode = "scheduled",
  hasExtraMaterial = false,
  rng = Math.random,
} = {}) {
  const chat = mode === "chat";

  // The chat opener carries an explicit veto. Detection is a loose keyword
  // match (src/ai/skills/story.js) — it fires on ANY message mentioning 故事,
  // including 「剛剛那個故事很好笑」. Recall lives in the regex, precision lives
  // here: she reads the request and decides. Without this clause a loose
  // matcher would turn every passing mention of 故事 into a 400-字 story.
  const opener = chat
    ? "（系統提示：這則訊息裡出現了「故事」，所以下面附上講故事的規格。先自己判斷對方是不是真的要你講一個故事：如果他只是在聊到、評論、或問起某個故事（例如「剛剛那個故事很好笑」「這個故事結局很扯」），就把下面整段規格當作不存在，照平常聊天的樣子回他，不要寫故事、不要下標題。確定是要你講故事，才照下面的規格寫，不要用平常聊天的語氣隨便編。"
    : `（系統提示：現在是「${guildName || "這個伺服器"}」的睡前故事時間。`;

  const invent = chat
    ? "自己發明這個故事。不要套固定世界觀（營火、便利商店、太空歌劇、郵局、社團、都市傳說、夢境聊天室、假新聞播報、古董店、舊貨鋪、修理鋪都不要當預設場景），除非素材自己指向那個地方。"
    : "自己發明今晚的故事。不要套固定世界觀（營火、便利商店、太空歌劇、郵局、社團、都市傳說、夢境聊天室、假新聞播報、古董店、舊貨鋪、修理鋪都不要當預設場景），除非今晚素材自己指向那個地方。";

  // Where the two real messages come from. Scheduled gets a curated buffet
  // block appended below; chat reads the 【最近群組對話】 turn chain.js injects
  // — whose own header says "不要直接複述", so this lifts that for this turn
  // only (same move target-context.js makes for imitation).
  // One strong line beats two forced together: blind tests (2026-09-25) scored
  // every story that glued two unrelated lines 2/5 (「後門和良善沒有關聯」).
  const pickRule = "挑一則單獨看就懂、有情境的當主軸；只有另一個人的某一則跟它真的接得上時才加第二則，接不上就只用一則。其餘完全忽略。";
  const sourceRule = chat
    ? `- 整個故事只有一個場景、一條主線。從上面【最近群組對話】裡${pickRule}（那份紀錄平常標著「不要直接複述」，只有在你確定要寫故事、真的動筆寫的時候不算——就是要你拿它當材料；判斷成不用寫故事的話，「不要直接複述」照舊。）`
    : `- 整個故事只有一個場景、一條主線。從素材裡${pickRule}`;

  const inspirationRule = chat
    ? "- 可以用群聊內容當靈感，但不要做今日回顧，不要流水帳。"
    : "- 可以用今天的群聊素材當靈感，但不要做今日回顧，不要流水帳。";

  const endingRule = chat
    ? "- 故事在哪裡結束就停。不要加結語、不要問大家覺得怎麼樣、不要接回聊天話題。"
    : "- 故事在哪裡結束就停。不要為了睡前時段硬接到睡覺、晚安或枕頭。";

  const movesHeader = chat
    ? "【這次要用的寫法】只做下面這幾條，其他別硬套："
    : "【今晚要用的寫法】只做下面這幾條，其他別硬套：";

  return [
    opener,
    invent,
    "",
    "寫作要求：",
    "- 第一行必須是 Markdown 標題：`## ` 加上具體標題（例如 `## 會替人照相的魔法鏡`）。標題裡不要出現「床邊故事」四個字，也不要寫「睡前故事」「今日故事」。故事本文裡提不提都可以。",
    "- 寫一個 150～300 字的原創短故事，目標是好笑，不是奇幻。",
    sourceRule,
    "- 動筆前先想清楚這個梗到底好笑在哪（誰吐槽誰、誰說了暴論、哪裡荒謬；有附前文的，笑點常常在前文和這句的落差）。整個故事就圍著這個梗，情節只負責把它鋪出來，觀眾看得懂就好，不用把笑點講破。",
    "- 素材可能是歌詞、迷因、動漫台詞，或在接別人的梗，不是字面意思。看不出它在接什麼的就不要挑，更不要照字面寫成劇情（例如把一句歌詞寫成真的在做菜）。",
    "- 最後一句交給角色說出口，回扣前面出現過的東西；不要用旁白總結、不要下雙關結論。",
    "- 不要寫否認再被抓包的橋段（「我沒說過」「你剛剛明明說了」）：素材就是那個人真的說過的話，讓他否認只會變成來回鬼打牆，不好笑。",
    "- 因果要講得通：轉折必須是前面已經出現的人、話或東西造成的，讀者回頭看會覺得「啊，原來是這樣」。不准有東西自己動起來、自動跳出、突然發光，不准靠魔法或巧合收尾，也不要留懸念或沒交代的伏筆。",
    ...(chat && hasExtraMaterial
      ? [
          "- 除了這個頻道的對話，上面還有一塊【這個群最近的其他材料】：別的房間最近在聊什麼、群友各自的取向。主線可以整個長在那些材料上——不必侷限在這個頻道剛剛的話題。兩則要融進主線的真實訊息仍然從【最近群組對話】挑，但場景、角色的愛好、支線細節都可以取自那塊材料（例如某人喜歡的遊戲、某個房間在吵的東西）。",
        ]
      : []),
    "- 挑反應數高的、或原句本身就好笑的。單獨拿出來看不出梗的別挑（純數字、比分、時間、「0.0」這種），那是當下在場才好笑的東西，寫進故事只會變成兩個人對著數字吵架。",
    "- 登場人物 2～5 人（含被點名的群友）。不要一個人獨角戲，也不要擠進一堆路人。",
    "- 用到的每一則都要讓看過原訊息的人對得上號，但不必逐字貼原句。梗在詞本身（諧音、錯字、自創詞）就照原樣寫；梗在情境就用演的，讓它自然發生在對話或動作裡，同一個梗不要再引用一次。",
    "- 不准消音：黃腔、髒話、綽號、諧音都照原樣，不要收成暗示或代稱（示範一下這條的意思，這兩句是舊例子不是今晚的素材，不要寫進故事：素材若寫「口交牛肉麵」就照寫，不要收成湯、暗示、某碗麵；「很會運氣了」不要收成運氣）。可以改寫情節，不能裝沒看過。",
    "- 主要物品要少而貫穿：出場的重要物品或角色，大多要再被用到或呼應。",
    "- 角色可以借群友暱稱，讓角色之間有互動和對話。不要編造現實隱私。",
    inspirationRule,
    "- 只有住址、電話、真實姓名這類個資才抽象。",
    "- 排版：標題下一行空白，之後 2～5 段，每段之間空一行。",
    "- 全文用繁體中文（台灣用語），不要出現簡體字。",
    endingRule,
    "",
    movesHeader,
    ...pickStoryCraftMoves(STORY_CRAFT_MOVES, STORY_CRAFT_MOVE_COUNT, rng).map(
      (move) => `- ${move}`,
    ),
    "）",
  ].join("\n");
}

// An image ingredient only exists once the vision step has described it; an
// undescribed one (vision off / failed) has nothing to say and is skipped.
function ingredientSaid(item) {
  const image = item.imageCaption ? `（貼了一張圖：${item.imageCaption}）` : "";
  if (item.preview && image) return `${item.preview} ${image}`;
  return item.preview || image;
}

// The scheduled task's curated buffet. Chat has no equivalent — its ingredients
// are the group-context turn — so this is scheduled-only by construction.
function buildStoryIngredientsBlock({ ingredients = [], activeChannels = [] } = {}) {
  const lines = [];

  if (activeChannels.length > 0) {
    lines.push(`【今晚熱鬧的房間】${activeChannels.join("、")}`);
    lines.push("");
  }

  if (ingredients.length > 0) {
    lines.push("【可用靈感素材】（主軸挑一則，第二則要真的接得上才加；用了就要認得出是哪一則。「貼了一張圖」是你看過那張圖寫下的描述）");
    for (const item of ingredients) {
      const said = ingredientSaid(item);
      if (!said) continue;
      const reacted = item.reactions > 0 ? `，反應 ${item.reactions}` : "";
      lines.push(`- ${item.authorName} 在 #${item.channelName}：${said}${reacted}`);
      if (item.context?.length) {
        lines.push(`  （前文：${item.context.join("／")}）`);
      }
    }
  } else {
    lines.push("【可用靈感素材】今天聊天素材很少，請自己創作一個安靜但有趣的小故事。");
  }

  return lines.join("\n");
}

function buildBedtimeStoryPrompt({
  guildName,
  messages = [],
  channelStats = [],
  schedule = {},
  now = new Date(),
  rng = Math.random,
  selection = null,
}) {
  const dateKey = localDateKey(now, schedule?.timezone || "Asia/Taipei");
  // The scheduler passes a selection whose images were already described
  // (async vision step); tests and the fallback path let us select here.
  const { ingredients: selected, activeChannels } =
    selection || selectStoryIngredients(messages, channelStats);
  const ingredients = selected.filter((item) => ingredientSaid(item));

  const prompt = [
    buildStoryCraftBlock({ guildName, mode: "scheduled", rng }),
    "",
    buildStoryIngredientsBlock({ ingredients, activeChannels }),
  ].join("\n");

  return {
    prompt,
    dateKey,
    ingredientCount: ingredients.length,
    buffet: ingredients.map(
      (item) => `${item.authorName}/#${item.channelName}:${ingredientSaid(item)}`,
    ),
  };
}

module.exports = {
  BEDTIME_LOOKBACK_MS,
  localDateKey,
  messagePreview,
  storyText,
  selectStoryIngredients,
  markBedtimeStoryUsed,
  sanitizeBedtimeTitle,
  buildBedtimeStoryPrompt,
  buildStoryCraftBlock,
  buildStoryIngredientsBlock,
  STORY_CRAFT_MOVES,
  pickStoryCraftMoves,
};
