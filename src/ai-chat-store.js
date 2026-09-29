const fs = require("fs");
const path = require("path");

// Which mentions wake 西寶's chat, per guild.
//   all    — any mention Discord reports: a direct @西寶, a reply to her
//            message (reply pings count as mentions), @everyone / @here.
//   direct — only a direct @西寶 in the message text. For guilds that mostly
//            want previews: replying to a preview to discuss it with a friend
//            shouldn't summon her.
const AI_CHAT_MODES = ["all", "direct"];
const DEFAULT_AI_CHAT_MODE = "all";

const AI_CHAT_STORE_PATH = path.join(
  __dirname,
  "..",
  "data",
  "ai-chat-settings.json",
);

let cache = null;

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(AI_CHAT_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(
        `[ai-chat] failed to read ${AI_CHAT_STORE_PATH}: ${err.message}`,
      );
    }
    cache = {};
  }
  return cache;
}

function save() {
  const settings = cache ?? {};
  fs.mkdirSync(path.dirname(AI_CHAT_STORE_PATH), { recursive: true });
  const tmp = AI_CHAT_STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, AI_CHAT_STORE_PATH);
}

function isValidAiChatMode(mode) {
  return AI_CHAT_MODES.includes(mode);
}

function getGuildAiChatMode(guildId) {
  if (!guildId) return DEFAULT_AI_CHAT_MODE;
  const mode = load()[guildId];
  return isValidAiChatMode(mode) ? mode : DEFAULT_AI_CHAT_MODE;
}

function setGuildAiChatMode(guildId, mode) {
  if (!guildId) throw new Error("guildId required");
  if (!isValidAiChatMode(mode)) throw new Error(`invalid ai chat mode: ${mode}`);
  const settings = load();
  // The default is stored as absence so the file only lists guilds that
  // actually changed something.
  if (mode === DEFAULT_AI_CHAT_MODE) delete settings[guildId];
  else settings[guildId] = mode;
  save();
}

function resetCacheForTests() {
  cache = null;
}

module.exports = {
  AI_CHAT_MODES,
  DEFAULT_AI_CHAT_MODE,
  AI_CHAT_STORE_PATH,
  isValidAiChatMode,
  getGuildAiChatMode,
  setGuildAiChatMode,
  resetCacheForTests,
};
