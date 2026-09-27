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

// A key DeepSeek rejects (401 invalid / 402 out of balance) stays on file but
// stops counting as usable, so the guild drops back to the free tier instead of
// silently riding the owner-paid fallback. 402 heals on its own once the guild
// tops up, so after KEY_RECHECK_MS the key gets one more real call; success
// clears the mark, another rejection re-arms it (without a second notice).
const KEY_RECHECK_MS = 6 * 60 * 60 * 1000;

function isGuildKeyUsable(guildId, now = Date.now()) {
  if (!hasGuildApiKey(guildId)) return false;
  const rejectedAt = load()[guildId].rejectedAt;
  return !rejectedAt || now - rejectedAt >= KEY_RECHECK_MS;
}

function getGuildKeyRejection(guildId) {
  const entry = guildId ? load()[guildId] : null;
  if (!entry?.rejectedAt) return null;
  return { at: entry.rejectedAt, status: entry.rejectedStatus ?? null };
}

// Returns true only on the transition usable → rejected, which is when the
// guild should be told once.
function markGuildKeyRejected(guildId, status, now = Date.now()) {
  if (!hasGuildApiKey(guildId)) return false;
  const entry = load()[guildId];
  const isNew = !entry.rejectedAt;
  entry.rejectedAt = now;
  entry.rejectedStatus = status ?? null;
  if (isNew) entry.noticePending = true;
  save();
  return isNew;
}

function clearGuildKeyRejection(guildId) {
  const entry = guildId ? load()[guildId] : null;
  if (!entry?.rejectedAt && !entry?.noticePending) return false;
  delete entry.rejectedAt;
  delete entry.rejectedStatus;
  delete entry.noticePending;
  save();
  return true;
}

function consumeGuildKeyNotice(guildId) {
  const entry = guildId ? load()[guildId] : null;
  if (!entry?.noticePending) return false;
  delete entry.noticePending;
  save();
  return true;
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
  KEY_RECHECK_MS,
  isGuildKeyUsable,
  getGuildKeyRejection,
  markGuildKeyRejected,
  clearGuildKeyRejection,
  consumeGuildKeyNotice,
  resetCacheForTests,
};
