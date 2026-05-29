const fs = require("node:fs");
const path = require("node:path");

const STORE_PATH = path.join(__dirname, "..", "data", "guild-profiles.json");
const BAK_PATH = STORE_PATH + ".bak";

const OBSERVATION_MAX_LEN = 120;
const PROFILE_MAX_LEN = 500;
const PROFILE_PROMPT_MAX_LEN = 300;
const CONTEXT_SNAPSHOT_MAX_LEN = 2000;
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
      console.warn(`[guild-profiles] failed to read ${STORE_PATH}: ${err.message}`);
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
  } catch (_) {}
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

function makeEmptyEntry(guildName) {
  return {
    name: guildName || "未知",
    observations: [],
    pendingContexts: [],
    lastExtractedAt: null,
    profile: null,
    profileAt: null,
    updatedAt: null,
  };
}

function getGuildProfile(guildId) {
  if (!guildId) return null;
  const data = load();
  return data[guildId] ?? null;
}

function appendPendingContext(guildId, guildName, contextLines) {
  if (!guildId) return;
  if (!Array.isArray(contextLines) || contextLines.length === 0) return;

  const data = load();
  const entry = data[guildId] || makeEmptyEntry(guildName);
  if (guildName) entry.name = guildName;
  if (!entry.pendingContexts) entry.pendingContexts = [];

  const snapshot = contextLines.join("\n").slice(0, CONTEXT_SNAPSHOT_MAX_LEN);
  entry.pendingContexts.push({ text: snapshot, at: Date.now() });
  entry.updatedAt = Date.now();
  data[guildId] = entry;
  save();
}

function getPendingContexts(guildId) {
  const entry = getGuildProfile(guildId);
  return entry?.pendingContexts ?? [];
}

function clearPendingContexts(guildId) {
  if (!guildId) return;
  const data = load();
  const entry = data[guildId];
  if (!entry) return;
  entry.pendingContexts = [];
  entry.lastExtractedAt = Date.now();
  entry.updatedAt = Date.now();
  save();
}

function appendObservations(guildId, guildName, observations) {
  if (!guildId) return;
  if (!Array.isArray(observations) || observations.length === 0) return;

  const data = load();
  const entry = data[guildId] || makeEmptyEntry(guildName);
  if (guildName) entry.name = guildName;

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
  data[guildId] = entry;
  save();
}

function setConsolidatedProfile(guildId, profileText) {
  if (!guildId) return;
  const data = load();
  const entry = data[guildId];
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

function buildGuildProfileBlock(entry) {
  if (!entry?.profile) return "";
  const summary = entry.profile.slice(0, PROFILE_PROMPT_MAX_LEN);
  return `\n\n## 這個群的長期印象\n這是你對目前 Discord 群的輕量印象，只能用來理解氣氛，不要直接複述。\n- 摘要：${summary}`;
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
  CONTEXT_SNAPSHOT_MAX_LEN,
  getGuildProfile,
  appendPendingContext,
  getPendingContexts,
  clearPendingContexts,
  appendObservations,
  setConsolidatedProfile,
  buildGuildProfileBlock,
  flush,
  resetCacheForTests,
};
