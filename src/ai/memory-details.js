// Second tier of long-term memory: picking which DETAILS (see the detail pool
// in user-profile-store.js) a reply gets to see. The outline is always in the
// system prompt; details are the long tail, so they only come in when
//   - the message touches them (token overlap with the person's own pool), or
//   - someone asks what 西寶 remembers about a person (recall intent) — then
//     the whole pool, newest first.
// Pure string work, no API call. Injected as a user-role turn (not the system
// prompt): it changes per message, and detail text derives from chat text.

const { detailsOf, textTokens } = require("../user-profile-store");
const { sanitizeName } = require("../utils");

const RELEVANT_MAX = 3;
const RECALL_MAX = 15;

// Bigrams that say nothing about WHICH detail is meant: function words, and
// the descriptive scaffolding the extractor wraps every detail in (常聊／喜歡／
// 提到…). Without this, 「你喜歡什麼」 would match every 「喜歡X」 detail.
const STOP_TOKENS = new Set([
  "西寶", "什麼", "怎麼", "這個", "那個", "一下", "一個", "自己", "我們", "你們",
  "他們", "覺得", "知道", "記得", "沒有", "可以", "不是", "就是", "時候", "現在",
  "今天", "然後", "因為", "所以", "還是", "如果", "喜歡", "常聊", "常常", "經常",
  "會用", "使用", "話題", "聊天", "提到", "分享", "討論", "對話", "群組", "表示",
  "有時", "偶爾", "常會", "會說", "說話", "語氣", "互動", "一起", "很多", "比較",
  "可能", "一直", "真的", "好像", "應該", "不會", "不要", "已經", "還有", "這樣",
  "那樣", "怎樣", "有點", "東西", "大家", "時間", "最近", "每天", "一樣", "好玩",
  "感覺", "問題", "為什", "麼樣", "要不", "不要", "幹嘛", "哈哈", "今晚", "明天",
  "the", "and", "you", "lol",
]);

function detectMemoryRecallIntent(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.normalize("NFC");
  // 「你記得我嗎」「你還認識他嗎」
  if (/你(還)?(記得|記住|認識|了解|瞭解)(我|他|她)/.test(t)) return true;
  // 「你記得 XX 哪些事」— 知道 is left out: 「你知道明天要幹嘛」 is not recall.
  if (/(記得|記住|了解|瞭解)[^\s，。？?！!]{0,10}?(哪些|多少|什麼事)/.test(t)) return true;
  // 「你對我有什麼印象」「關於 XX 的記憶」
  if (/(對|關於)[^\s，。？?！!]{1,10}?(有)?(什麼|哪些)?(印象|記憶)/.test(t)) return true;
  // 「我是怎樣的人」「XX 是個什麼樣的人」
  if (/是(一個|個)?(怎樣|怎麼樣|什麼樣|甚麼樣)的人/.test(t)) return true;
  return false;
}

// Tokens shared by most of a person's pool describe the person in general,
// not one detail — dropped as an in-pool stoplist (IDF-style).
function poolCommonTokens(tokenSets) {
  if (tokenSets.length < 4) return new Set();
  const df = new Map();
  for (const set of tokenSets) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  const limit = tokenSets.length * 0.4;
  return new Set([...df].filter(([, n]) => n > limit).map(([t]) => t));
}

// Details whose wording overlaps the message, best first. Recall-first: one
// shared bigram counts (proper nouns like 大阪 are a single bigram), the
// stoplists keep function words out, and a false hit only costs a line the
// model is told to use only if natural. ascii words weigh double.
function selectRelevantDetails(details, query, max = RELEVANT_MAX) {
  const q = [...textTokens(query)].filter((t) => !STOP_TOKENS.has(t));
  if (q.length === 0 || !details?.length) return [];
  const sets = details.map((d) => textTokens(d.text));
  const common = poolCommonTokens(sets);
  const scored = [];
  details.forEach((d, i) => {
    let score = 0;
    for (const t of q) {
      if (common.has(t) || !sets[i].has(t)) continue;
      score += /^[a-z0-9]/.test(t) ? 2 : 1;
    }
    if (score >= 1) scored.push({ d, score });
  });
  scored.sort((a, b) => b.score - a.score || (b.d.lastSeenAt ?? 0) - (a.d.lastSeenAt ?? 0));
  return scored.slice(0, max).map((s) => s.d);
}

function newestDetails(details, max = RECALL_MAX) {
  return [...(details || [])].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)).slice(0, max);
}

// Details already said by the outline (same wording) add nothing.
function notInOutline(details, outlineText) {
  const outline = outlineText || "";
  return details.filter((d) => !outline.includes(d.text));
}

// One person's slice of the detail tier for this message: everything on a
// recall question, otherwise only what the message touches.
function pickDetails(entry, query, { recall = false, outlineText = "", now = Date.now() } = {}) {
  const pool = notInOutline(detailsOf(entry, now), outlineText);
  if (pool.length === 0) return [];
  return recall ? newestDetails(pool) : selectRelevantDetails(pool, query);
}

// people: [{ name, details, recall, self }]
function buildMemoryDetailsBlock(people) {
  const withDetails = (people || []).filter((p) => p.details?.length > 0);
  if (withDetails.length === 0) return "";
  const recall = withDetails.some((p) => p.recall);
  const lines = [
    recall
      ? "## 你對這些人記得的細節（他在問你記得什麼）"
      : "## 你記得的相關細節",
    recall
      ? "這是長期記憶裡的細節庫，比平常的印象摘要更細。挑幾個具體、有梗的講，用你自己的口吻，不要整串念出來；" +
        "這裡沒有的事不要編。條目是你過去的觀察，不一定還成立，可以用「之前」「好像」帶。"
      : "這幾條細節跟這則訊息有關。只在自然的時候帶到，不用硬提，也不要說出「我記得你的資料」這種話。",
  ];
  for (const p of withDetails) {
    lines.push(`- ${p.self ? "（說話者）" : ""}${sanitizeName(p.name || "未知")}：`);
    for (const d of p.details) lines.push(`  - ${d.text}`);
  }
  return lines.join("\n");
}

// Short addendum for a group-compare snippet: the best-supported details the
// outline doesn't already say.
function topDetailsText(entry, max = 2, outlineText = "") {
  const pool = notInOutline(detailsOf(entry), outlineText);
  const ranked = [...pool].sort((a, b) =>
    (b.evidence?.length ?? 0) - (a.evidence?.length ?? 0) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  return ranked.slice(0, max).map((d) => d.text).join("；");
}

module.exports = {
  RELEVANT_MAX,
  RECALL_MAX,
  detectMemoryRecallIntent,
  selectRelevantDetails,
  pickDetails,
  buildMemoryDetailsBlock,
  topDetailsText,
};
