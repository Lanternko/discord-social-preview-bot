// 「你會什麼／指令有哪些／最近更新什麼」 skill — 西寶 answers questions about
// herself from a fixed knowledge base instead of improvising.
//
// Without this, 「你有什麼指令」 gets a persona-voiced guess: invented commands,
// wrong quota numbers, no mention of /ai-key. New guilds are told (by the
// join greeting) to @ her with exactly these questions, so the answer has to
// be right.
//
// Three blocks go into the personaSuffix:
//   1. help-knowledge.md — the static manual, written for members not devs.
//   2. live status for THIS guild — tier, today's quota, schedules. Read from
//      the same stores /ai-tier and /schedule use, so the numbers never drift
//      from what the commands say.
//   3. help-changelog.md — the newest user-facing updates.
//
// Detection is loose on purpose (see docs/skills.md): 「你會什麼」 has too many
// phrasings to enumerate, and the pack's veto clause turns false positives
// (「這遊戲的新功能好爛」) back into ordinary chat.

const fs = require("node:fs");
const path = require("node:path");

const { AI_FREE_DAILY_LIMIT, DEEPSEEK_PREMIUM_GUILD_IDS } = require("../../config");
const { getGuildTier } = require("../../tier-store");
const { TIER_UI_LABELS } = require("../../tier-config");
const { hasGuildApiKey } = require("../guild-key-store");
const { getUsage } = require("../rate-limiter");
const { getGuildSchedules } = require("../../schedule-store");

const KNOWLEDGE_PATH = path.join(__dirname, "help-knowledge.md");
const CHANGELOG_PATH = path.join(__dirname, "help-changelog.md");
const CHANGELOG_ENTRIES = 8;

// Listing commands does not fit 入門's 180-token / 300-char budget. Floors,
// not overrides — a tier that already allows more keeps its own limit.
const HELP_MIN_TOKENS = 600;
const HELP_MIN_REPLY_CHARS = 900;

const HELP_KEYWORD_RE = new RegExp(
  [
    "指令",
    "功能",
    "怎麼用",
    "怎麼設定",
    "使用說明",
    "說明書",
    "(你|妳)?會(做)?(什麼|甚麼|啥)",
    "(能|可以)(做|幹)(什麼|甚麼|啥|嘛)",
    "有什麼用",
    "更新",
    "額度",
    "限額",
    "次數",
    "幾次",
    "多少次",
    "金鑰",
    "api ?key",
    "\\bkey\\b",
    "方案",
    "排程",
    "/ai-",
    "\\bhelp\\b",
    "\\bcommands?\\b",
  ].join("|"),
  "i",
);

function matchHelp(text) {
  if (!text || typeof text !== "string") return false;
  return HELP_KEYWORD_RE.test(text.normalize("NFC"));
}

// Read per call rather than cached at require time: the files are small, and
// an edited changelog then goes live without a restart.
function readKnowledge() {
  return fs.readFileSync(KNOWLEDGE_PATH, "utf8").trim();
}

function readChangelog(limit = CHANGELOG_ENTRIES) {
  return fs
    .readFileSync(CHANGELOG_PATH, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- "))
    .slice(0, limit)
    .join("\n");
}

function describeQuota(guildId) {
  if (hasGuildApiKey(guildId)) return "額度：無限制（這個伺服器設了自己的 DeepSeek 金鑰）";
  if (DEEPSEEK_PREMIUM_GUILD_IDS.includes(guildId)) return "額度：無限制（白名單）";
  const used = getUsage(guildId)?.count ?? 0;
  return `額度：免費，每天 ${AI_FREE_DAILY_LIMIT} 次，問這句之前今天已經用了 ${used} 次`;
}

function describeSchedules(guildId, taskTypes) {
  const schedules = getGuildSchedules(guildId);
  if (schedules.length === 0) return "排程：還沒有排任何排程";
  const items = schedules.map((s) => {
    const label = taskTypes?.[s.taskType]?.label || s.taskType;
    const time = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
    const off = s.enabled === false ? "（已停用）" : "";
    return `${label} 每天 ${time} 在 <#${s.channelId}>${off}`;
  });
  return `排程：${items.join("；")}`;
}

function buildGuildStatusBlock(guild) {
  if (!guild) return "（這是私訊，沒有伺服器設定可以查。）";
  // Lazy: scheduler pulls in the whole AI chain; only the labels are needed.
  const { TASK_TYPES } = require("../../scheduler");
  return [
    `伺服器：${guild.name}`,
    `AI 方案：${TIER_UI_LABELS[getGuildTier(guild.id)] || "入門"}`,
    describeQuota(guild.id),
    describeSchedules(guild.id, TASK_TYPES),
  ].join("\n");
}

function buildHelpBlock({ knowledge, status, changelog }) {
  return [
    "【說明書模式】",
    "先自己判斷：他是不是在問「你」——你的功能、指令、額度、金鑰、方案、排程、最近更新了什麼？如果只是聊天裡碰巧講到這些字（「這遊戲的新功能好爛」「我手機更新了」「你能幹嘛啦笨蛋」這種吐槽），就把下面整段當作不存在，照平常聊天回。",
    "",
    "確定是在問你的話：",
    "- 只根據下面的說明書、這個伺服器的現況、最近更新回答。上面沒寫的就老實說不確定，叫他打 `/help` 或問管理員。不准自己編指令、數字、網址或還沒做的功能。",
    "- 用你平常的語氣講，不要把說明書整份貼出來。只挑他問的那部分；問「你會什麼」這種大問題就挑 3～5 個重點，最後提一句 `/help` 有完整版。",
    "- 指令照原樣寫在反引號裡，例如 `/ai-key set`。",
    "- 他問額度、方案、排程，就用「這個伺服器的現況」裡的真實數字回答。",
    "- 如果有人在聊天裡貼了看起來像 API 金鑰的東西（sk- 開頭那種），先叫他馬上刪掉並去 DeepSeek 後台作廢換新，金鑰要用 `/ai-key set` 輸入。",
    "",
    "<說明書>",
    knowledge,
    "</說明書>",
    "",
    "<這個伺服器的現況>",
    status,
    "</這個伺服器的現況>",
    "",
    "<最近更新（新的在上面）>",
    changelog || "（沒有紀錄）",
    "</最近更新>",
  ].join("\n");
}

module.exports = {
  id: "help",
  label: "功能說明",
  match: matchHelp,
  build({ message } = {}) {
    return {
      personaSuffix: buildHelpBlock({
        knowledge: readKnowledge(),
        status: buildGuildStatusBlock(message?.guild),
        changelog: readChangelog(),
      }),
      minTokens: HELP_MIN_TOKENS,
      minReplyChars: HELP_MIN_REPLY_CHARS,
    };
  },
  HELP_MIN_TOKENS,
  HELP_MIN_REPLY_CHARS,
  buildHelpBlock,
  buildGuildStatusBlock,
  readChangelog,
};
