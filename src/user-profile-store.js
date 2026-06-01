const fs = require("node:fs");
const path = require("node:path");
const { sanitizeName } = require("./utils");

const STORE_PATH = path.join(__dirname, "..", "data", "user-profiles.json");
const BAK_PATH = STORE_PATH + ".bak";

const OBSERVATION_MAX_LEN = 120;
const PROFILE_MAX_LEN = 500;
const PENDING_TEXT_MAX_LEN = 500;
const RECENT_OBSERVATIONS_PROMPT_COUNT = 3;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

let cache = null;

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[user-profiles] failed to read ${STORE_PATH}: ${err.message}`);
    }
    cache = {};
  }
  return cache;
}

function save() {
  const data = cache ?? {};
  const dir = path.dirname(STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.copyFileSync(STORE_PATH, BAK_PATH);
  } catch (_) {
    // no existing file to back up — fine
  }
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

function clampConfidence(val) {
  if (typeof val !== "number" || !Number.isFinite(val)) return 0.5;
  return Math.max(0, Math.min(1, val));
}

function sanitizeObservationText(text) {
  if (!text || typeof text !== "string") return null;
  const clean = text.replace(CONTROL_CHARS_RE, " ").replace(/ {2,}/g, " ").trim();
  if (!clean) return null;
  return clean.slice(0, OBSERVATION_MAX_LEN);
}

function makeEmptyEntry(displayName) {
  return {
    name: sanitizeName(displayName),
    observations: [],
    pendingInteractions: [],
    lastExtractedAt: null,
    profile: null,
    profileAt: null,
    updatedAt: null,
  };
}

function capText(text, limit) {
  if (!text || typeof text !== "string") return "";
  return text.replace(CONTROL_CHARS_RE, " ").trim().slice(0, limit);
}

function appendPendingInteraction(guildId, userId, displayName, userText, assistantText) {
  if (!guildId || !userId) return;
  const data = load();
  if (!data[guildId]) data[guildId] = {};
  const entry = data[guildId][userId] || makeEmptyEntry(displayName);
  if (displayName) entry.name = sanitizeName(displayName);
  if (!entry.pendingInteractions) entry.pendingInteractions = [];
  entry.pendingInteractions.push({
    userText: capText(userText, PENDING_TEXT_MAX_LEN),
    assistantText: capText(assistantText, PENDING_TEXT_MAX_LEN),
    at: Date.now(),
  });
  entry.updatedAt = Date.now();
  data[guildId][userId] = entry;
  save();
}

function getPendingInteractions(guildId, userId) {
  const entry = getUserProfile(guildId, userId);
  return entry?.pendingInteractions ?? [];
}

function clearPending(guildId, userId) {
  if (!guildId || !userId) return;
  const data = load();
  const entry = data[guildId]?.[userId];
  if (!entry) return;
  entry.pendingInteractions = [];
  entry.lastExtractedAt = Date.now();
  entry.updatedAt = Date.now();
  save();
}

function getUserProfile(guildId, userId) {
  if (!guildId || !userId) return null;
  const data = load();
  return data[guildId]?.[userId] ?? null;
}

function appendObservations(guildId, userId, displayName, observations) {
  if (!guildId || !userId) return;
  if (!Array.isArray(observations) || observations.length === 0) return;

  const data = load();
  if (!data[guildId]) data[guildId] = {};

  const entry = data[guildId][userId] || makeEmptyEntry(displayName);

  if (displayName) entry.name = sanitizeName(displayName);

  const now = Date.now();
  for (const obs of observations) {
    const text = sanitizeObservationText(obs.text);
    if (!text) continue;
    entry.observations.push({
      text,
      at: typeof obs.at === "number" ? obs.at : now,
      confidence: clampConfidence(obs.confidence),
    });
  }

  entry.updatedAt = now;
  data[guildId][userId] = entry;
  save();
}

function setConsolidatedProfile(guildId, userId, profileText) {
  if (!guildId || !userId) return;
  const data = load();
  const entry = data[guildId]?.[userId];
  if (!entry) return;

  const clean = (profileText || "")
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, PROFILE_MAX_LEN);

  entry.profile = clean || null;
  entry.profileAt = Date.now();
  entry.observations = [];
  entry.updatedAt = Date.now();
  save();
}

const PROFILE_PROMPT_MAX_LEN = 300;

function buildUserProfileBlock(entry) {
  if (!entry?.profile && !entry?.observations?.length) return "";
  const name = entry.name || "未知";
  const lines = [
    "\n\n## 當前使用者長期記憶",
    "這是你對目前說話者的長期印象，只能當成輕量參考，不要直接複述，也不要假裝百分之百確定。",
    `- 暱稱：${name}`,
  ];

  if (entry.profile) {
    lines.push(`- 摘要：${entry.profile.slice(0, PROFILE_PROMPT_MAX_LEN)}`);
  }

  const recentObservations = (entry.observations || [])
    .slice(-RECENT_OBSERVATIONS_PROMPT_COUNT)
    .map((o) => o.text)
    .filter(Boolean);
  if (recentObservations.length > 0) {
    lines.push("- 最近零散觀察：");
    for (const obs of recentObservations) {
      lines.push(`  - ${obs}`);
    }
  }

  return lines.join("\n");
}

function deleteUserProfile(guildId, userId) {
  if (!guildId || !userId) return false;
  const data = load();
  if (!data[guildId]?.[userId]) return false;
  delete data[guildId][userId];
  if (Object.keys(data[guildId]).length === 0) delete data[guildId];
  save();
  return true;
}

function listUserProfiles(guildId) {
  if (!guildId) return [];
  const data = load();
  const entries = data[guildId] || {};
  return Object.entries(entries).map(([userId, entry]) => ({
    userId,
    ...entry,
  }));
}

function flush() {
  save();
}

function resetCacheForTests() {
  cache = {};
}

module.exports = {
  STORE_PATH,
  OBSERVATION_MAX_LEN,
  PROFILE_MAX_LEN,
  PROFILE_PROMPT_MAX_LEN,
  PENDING_TEXT_MAX_LEN,
  RECENT_OBSERVATIONS_PROMPT_COUNT,
  getUserProfile,
  appendPendingInteraction,
  getPendingInteractions,
  clearPending,
  appendObservations,
  setConsolidatedProfile,
  deleteUserProfile,
  listUserProfiles,
  buildUserProfileBlock,
  flush,
  resetCacheForTests,
};
