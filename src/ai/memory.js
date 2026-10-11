const fs = require("node:fs");
const path = require("node:path");
const { AI_MEMORY_TTL_MS, AI_TURN_LOG_RETENTION_DAYS } = require("../config");

// Map<channelId, { turns: Array<{role, content}>, lastActivity: timestamp }>
const aiConversationHistory = new Map();

const DISTILL_LOG_PATH = path.join(__dirname, "..", "..", "data", "ai-turn-log.json");
const DISTILL_LOG_BAK_PATH = DISTILL_LOG_PATH + ".bak";
const DISTILL_LOG_MAX_TURNS_PER_CHANNEL = 500;
const AI_TURN_LOG_RETENTION_MS = AI_TURN_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

let distillLogCache = null;

function loadDistillLog() {
  if (distillLogCache !== null) return distillLogCache;
  try {
    const raw = fs.readFileSync(DISTILL_LOG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    distillLogCache = parsed && typeof parsed === "object" ? parsed : { channels: {} };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[ai-memory] failed to read ${DISTILL_LOG_PATH}: ${err.message}`);
    }
    distillLogCache = { channels: {} };
  }
  if (!distillLogCache.channels || typeof distillLogCache.channels !== "object") {
    distillLogCache.channels = {};
  }
  return distillLogCache;
}

function saveDistillLog() {
  const data = distillLogCache ?? { channels: {} };
  fs.mkdirSync(path.dirname(DISTILL_LOG_PATH), { recursive: true });
  try {
    fs.copyFileSync(DISTILL_LOG_PATH, DISTILL_LOG_BAK_PATH);
  } catch (_) {
    // no existing file to back up
  }
  const tmp = DISTILL_LOG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DISTILL_LOG_PATH);
}

function cleanContent(content) {
  if (!content || typeof content !== "string") return "";
  return content.replace(CONTROL_CHARS_RE, " ").trim();
}

function recordDistillTurn(channelId, role, content, meta = {}) {
  if (!channelId || !role) return;
  const clean = cleanContent(content);
  if (!clean) return;

  const data = loadDistillLog();
  const now = Date.now();
  const entry = data.channels[channelId] || {
    guildId: meta.guildId || null,
    turns: [],
    lastActivity: null,
  };
  if (meta.guildId) entry.guildId = meta.guildId;
  entry.turns.push({
    role,
    content: clean,
    at: now,
    userId: meta.userId || null,
    displayName: meta.displayName || null,
  });
  entry.lastActivity = now;
  if (entry.turns.length > DISTILL_LOG_MAX_TURNS_PER_CHANNEL) {
    entry.turns = entry.turns.slice(-DISTILL_LOG_MAX_TURNS_PER_CHANNEL);
  }
  data.channels[channelId] = entry;
  saveDistillLog();
}

// saveDistillLog copies the previous file to .bak first, so after removing
// turns the .bak still has them. Overwrite it with the trimmed state.
function scrubDistillLogBackup() {
  try {
    fs.copyFileSync(DISTILL_LOG_PATH, DISTILL_LOG_BAK_PATH);
  } catch (_) {
    // nothing saved yet — no backup to scrub
  }
}

// Erasure: one member's turns in one guild, plus 西寶's reply to each (the
// pair is recorded back to back, and the reply quotes/answers them). The
// short-term prompt history of the touched channels goes too — its turns
// carry no user id to filter on.
function deleteUserTurns(guildId, userId) {
  if (!guildId || !userId) return 0;
  const data = loadDistillLog();
  let removed = 0;
  for (const [channelId, entry] of Object.entries(data.channels)) {
    if (entry.guildId !== guildId || !Array.isArray(entry.turns)) continue;
    const kept = [];
    let dropReply = false;
    for (const turn of entry.turns) {
      const theirs = turn.userId === userId;
      if (theirs || (dropReply && turn.role === "assistant")) {
        removed += 1;
        dropReply = theirs;
        continue;
      }
      dropReply = false;
      kept.push(turn);
    }
    if (kept.length === entry.turns.length) continue;
    aiConversationHistory.delete(channelId);
    if (kept.length === 0) delete data.channels[channelId];
    else entry.turns = kept;
  }
  if (removed > 0) {
    saveDistillLog();
    scrubDistillLogBackup();
  }
  return removed;
}

function deleteGuildTurns(guildId) {
  if (!guildId) return 0;
  const data = loadDistillLog();
  let removed = 0;
  for (const [channelId, entry] of Object.entries(data.channels)) {
    if (entry.guildId !== guildId) continue;
    removed += (entry.turns || []).length;
    delete data.channels[channelId];
    aiConversationHistory.delete(channelId);
  }
  if (removed > 0) {
    saveDistillLog();
    scrubDistillLogBackup();
  }
  return removed;
}

function listDistillLogGuildIds() {
  const ids = new Set();
  for (const entry of Object.values(loadDistillLog().channels)) {
    if (entry.guildId) ids.add(entry.guildId);
  }
  return [...ids];
}

// The per-channel cap only bites in busy channels; a quiet one would keep
// its raw text forever. This is the time bound.
function pruneExpiredDistillTurns(maxAgeMs = AI_TURN_LOG_RETENTION_MS, now = Date.now()) {
  const data = loadDistillLog();
  const cutoff = now - maxAgeMs;
  let removed = 0;
  for (const [channelId, entry] of Object.entries(data.channels)) {
    const turns = Array.isArray(entry.turns) ? entry.turns : [];
    const kept = turns.filter((t) => typeof t.at === "number" && t.at >= cutoff);
    if (kept.length === turns.length) continue;
    removed += turns.length - kept.length;
    if (kept.length === 0) delete data.channels[channelId];
    else entry.turns = kept;
  }
  if (removed > 0) {
    saveDistillLog();
    scrubDistillLogBackup();
  }
  return removed;
}

function cleanupAIConversationHistory() {
  const now = Date.now();
  for (const [channelId, entry] of aiConversationHistory.entries()) {
    if (now - entry.lastActivity > AI_MEMORY_TTL_MS) {
      aiConversationHistory.delete(channelId);
    }
  }
}

function getChannelAIHistory(channelId) {
  cleanupAIConversationHistory();
  const entry = aiConversationHistory.get(channelId);
  return entry ? entry.turns : [];
}

function recordAITurn(channelId, role, content, maxTurns, meta = {}) {
  const now = Date.now();
  let entry = aiConversationHistory.get(channelId);
  if (!entry) {
    entry = { turns: [], lastActivity: now };
    aiConversationHistory.set(channelId, entry);
  }
  entry.turns.push({ role, content });
  entry.lastActivity = now;
  const maxEntries = maxTurns * 2;
  if (entry.turns.length > maxEntries) {
    entry.turns = entry.turns.slice(-maxEntries);
  }
  recordDistillTurn(channelId, role, content, meta);
}

const AI_MEMORY_SWEEP_INTERVAL_MS = Math.max(
  60_000,
  Math.floor(AI_MEMORY_TTL_MS / 4),
);

let sweepTimer = null;

function startMemorySweepTimer() {
  if (sweepTimer) return sweepTimer;
  sweepTimer = setInterval(cleanupAIConversationHistory, AI_MEMORY_SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === "function") sweepTimer.unref();
  return sweepTimer;
}

function stopMemorySweepTimer() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function resetDistillLogCacheForTests() {
  distillLogCache = { channels: {} };
}

module.exports = {
  DISTILL_LOG_PATH,
  DISTILL_LOG_MAX_TURNS_PER_CHANNEL,
  aiConversationHistory,
  cleanupAIConversationHistory,
  getChannelAIHistory,
  recordAITurn,
  recordDistillTurn,
  deleteUserTurns,
  deleteGuildTurns,
  listDistillLogGuildIds,
  pruneExpiredDistillTurns,
  AI_TURN_LOG_RETENTION_MS,
  AI_MEMORY_SWEEP_INTERVAL_MS,
  startMemorySweepTimer,
  stopMemorySweepTimer,
  resetDistillLogCacheForTests,
};
