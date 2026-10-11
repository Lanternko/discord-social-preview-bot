// Time limits on stored data: the daily sweep that prunes old turn-log
// entries and erases the data of guilds the bot left.
//
// Guild data is erased GUILD_DATA_RETENTION_DAYS after the bot leaves, not
// when guildDelete fires:
//   - a kick followed by a re-invite (permissions fix, wrong bot removed)
//     shouldn't cost the server months of memory;
//   - a wrongly-fired departure is then harmless — the sweep re-checks that
//     the bot is really still gone before it deletes anything;
//   - guilds that left while the bot was offline never emit guildDelete, so
//     they are found by comparing the stores against the guild list instead.

const { GUILD_DATA_RETENTION_DAYS } = require("./config");
const { pruneExpiredDistillTurns } = require("./ai/memory");
const { eraseGuildData, listStoredGuildIds, describeErasure } = require("./data-erasure");
const {
  markGuildDeparted,
  clearGuildDeparture,
  listDepartures,
} = require("./guild-departure-store");
const { unregisterJob } = require("./scheduler");

const DAY_MS = 24 * 60 * 60 * 1000;
const GUILD_DATA_RETENTION_MS = GUILD_DATA_RETENTION_DAYS * DAY_MS;
const SWEEP_INTERVAL_MS = DAY_MS;

// The guild list is only trustworthy once the gateway has delivered it. An
// outage leaves guilds in the cache (marked unavailable), so "not in the
// cache" means the bot really isn't a member.
function knowsItsGuilds(client) {
  return Boolean(client?.isReady?.() && client.guilds.cache.size > 0);
}

// Start the clock for guilds we hold data for but are no longer in.
function markMissingGuilds(client, now = Date.now()) {
  if (!knowsItsGuilds(client)) return [];
  const marked = [];
  for (const guildId of listStoredGuildIds()) {
    if (client.guilds.cache.has(guildId)) continue;
    if (markGuildDeparted(guildId, now)) marked.push(guildId);
  }
  return marked;
}

// Erase guilds whose grace period ran out; forget departures that came back.
function sweepDepartedGuilds(client, now = Date.now(), retentionMs = GUILD_DATA_RETENTION_MS) {
  if (!knowsItsGuilds(client)) return { erased: [], returned: [] };
  const erased = [];
  const returned = [];
  for (const { guildId, leftAt } of listDepartures()) {
    if (client.guilds.cache.has(guildId)) {
      clearGuildDeparture(guildId);
      returned.push(guildId);
      continue;
    }
    if (now - leftAt < retentionMs) continue;
    const result = eraseGuildData(guildId);
    for (const schedule of result.removedSchedules) unregisterJob(schedule.id);
    clearGuildDeparture(guildId);
    erased.push(guildId);
    console.log(`[retention] erased guild=${guildId} left=${new Date(leftAt).toISOString()} ${describeErasure(result)}`);
  }
  return { erased, returned };
}

function runRetentionSweep(client) {
  try {
    const turns = pruneExpiredDistillTurns();
    if (turns > 0) console.log(`[retention] pruned ${turns} expired turn-log entries`);
    const marked = markMissingGuilds(client);
    if (marked.length > 0) {
      console.log(`[retention] ${marked.length} guild(s) no longer joined, erasing in ${GUILD_DATA_RETENTION_DAYS}d: ${marked.join(",")}`);
    }
    sweepDepartedGuilds(client);
  } catch (err) {
    console.warn(`[retention] sweep failed: ${err?.stack || err}`);
  }
}

let sweepTimer = null;

function startRetentionSweep(client) {
  if (sweepTimer) return;
  runRetentionSweep(client);
  sweepTimer = setInterval(() => runRetentionSweep(client), SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

function stopRetentionSweep() {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}

module.exports = {
  GUILD_DATA_RETENTION_MS,
  markMissingGuilds,
  sweepDepartedGuilds,
  runRetentionSweep,
  startRetentionSweep,
  stopRetentionSweep,
};
