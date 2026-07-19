// Timer wiring for the personal-memory backlog sweep. Lives outside
// observation-extractor so the extractor never has to import chain.js
// (chain.js requires the extractor — importing back would be circular).
const { AI_LONG_TERM_MEMORY_ENABLED, PROFILE_SWEEP_INTERVAL_MS } = require("../config");
const { buildGuildChain, runProviderChain } = require("./chain");
const { getTierConfig } = require("../tier-config");
const { sweepPendingBacklog } = require("./observation-extractor");

// First pass runs shortly after startup so an existing backlog doesn't wait
// a full interval; steady state is one pass per PROFILE_SWEEP_INTERVAL_MS.
const PROFILE_SWEEP_STARTUP_DELAY_MS = 5 * 60 * 1000;

let startupTimer = null;
let intervalTimer = null;

function buildRunChainForGuild(guildId) {
  const tierConfig = getTierConfig(guildId);
  const { chain } = buildGuildChain(guildId, tierConfig);
  if (chain.length === 0) return null;
  return (turns, persona, maxTokens) =>
    runProviderChain(chain, turns, persona, maxTokens);
}

function runSweep() {
  sweepPendingBacklog(buildRunChainForGuild).catch((err) => {
    console.warn(`[backlog-sweep] pass failed: ${err.message}`);
  });
}

function startProfileSweepTimer() {
  if (!AI_LONG_TERM_MEMORY_ENABLED || PROFILE_SWEEP_INTERVAL_MS <= 0) return;
  if (intervalTimer) return;
  startupTimer = setTimeout(runSweep, PROFILE_SWEEP_STARTUP_DELAY_MS);
  startupTimer.unref?.();
  intervalTimer = setInterval(runSweep, PROFILE_SWEEP_INTERVAL_MS);
  intervalTimer.unref?.();
  console.log(
    `[backlog-sweep] timer started interval=${PROFILE_SWEEP_INTERVAL_MS}ms`,
  );
}

function stopProfileSweepTimer() {
  if (startupTimer) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  if (intervalTimer) {
    clearInterval(intervalTimer);
    intervalTimer = null;
  }
}

module.exports = {
  PROFILE_SWEEP_STARTUP_DELAY_MS,
  buildRunChainForGuild,
  startProfileSweepTimer,
  stopProfileSweepTimer,
};
