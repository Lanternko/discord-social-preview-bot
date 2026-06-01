const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "..", "..", "data", "guild-api-keys.json");

let cache = null;

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[ai-key] failed to read ${STORE_PATH}: ${err.message}`);
    }
    cache = {};
  }
  return cache;
}

function save() {
  const data = cache ?? {};
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

function getGuildApiKey(guildId) {
  if (!guildId) return null;
  const data = load();
  return data[guildId]?.deepseekApiKey || null;
}

function setGuildApiKey(guildId, apiKey) {
  if (!guildId) throw new Error("guildId required");
  if (!apiKey || typeof apiKey !== "string") throw new Error("apiKey required");
  const data = load();
  data[guildId] = { deepseekApiKey: apiKey };
  save();
}

function removeGuildApiKey(guildId) {
  if (!guildId) return false;
  const data = load();
  if (!data[guildId]) return false;
  delete data[guildId];
  save();
  return true;
}

function hasGuildApiKey(guildId) {
  if (!guildId) return false;
  const data = load();
  return !!data[guildId]?.deepseekApiKey;
}

function resetCacheForTests() {
  cache = null;
}

module.exports = {
  STORE_PATH,
  getGuildApiKey,
  setGuildApiKey,
  removeGuildApiKey,
  hasGuildApiKey,
  resetCacheForTests,
};
