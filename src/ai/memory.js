const { AI_MEMORY_TTL_MS } = require("../config");

// Map<channelId, { turns: Array<{role, content}>, lastActivity: timestamp }>
const aiConversationHistory = new Map();

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

function recordAITurn(channelId, role, content, maxTurns) {
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

module.exports = {
  aiConversationHistory,
  cleanupAIConversationHistory,
  getChannelAIHistory,
  recordAITurn,
  AI_MEMORY_SWEEP_INTERVAL_MS,
  startMemorySweepTimer,
  stopMemorySweepTimer,
};
