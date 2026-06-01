const fs = require("node:fs");
const path = require("node:path");
const { AI_MEMORY_TTL_MS } = require("../config");

// Map<channelId, { turns: Array<{role, content}>, lastActivity: timestamp }>
const aiConversationHistory = new Map();

const DISTILL_LOG_PATH = path.join(__dirname, "..", "..", "data", "ai-turn-log.json");
const DISTILL_LOG_BAK_PATH = DISTILL_LOG_PATH + ".bak";
const DISTILL_LOG_MAX_TURNS_PER_CHANNEL = 500;
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
  AI_MEMORY_SWEEP_INTERVAL_MS,
  startMemorySweepTimer,
  stopMemorySweepTimer,
  resetDistillLogCacheForTests,
};
