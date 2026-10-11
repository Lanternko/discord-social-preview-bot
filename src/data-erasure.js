// Erasing stored data, for one member (/memory forget-me, forget-user) or a
// whole guild (the bot was removed — see data-retention.js). Each store owns
// its own delete; this file only knows which stores hold what, so a new
// store with per-guild data has exactly one place to be added.
//
// Not covered, on purpose: ai-daily-usage.json (per-guild counters with no
// member data, dropped on the next day's write) and bot.log (rotated out by
// logrotate, docs/deploy.md).

const userProfiles = require("./user-profile-store");
const guildProfiles = require("./guild-profile-store");
const familiarity = require("./familiarity");
const turnLog = require("./ai/memory");
const schedules = require("./schedule-store");
const tiers = require("./tier-store");
const languages = require("./language-store");
const aiChat = require("./ai-chat-store");
const guildKeys = require("./ai/guild-key-store");

// knownNames: display names the member goes by, only used to find their
// lines in excerpts stored before those carried a user id.
function eraseUserData(guildId, userId, knownNames = []) {
  if (!guildId || !userId) return { any: false };
  const profileEntry = userProfiles.getUserProfile(guildId, userId);
  const familiarityEntry = familiarity.deleteUserFamiliarity(guildId, userId);
  const names = [...knownNames, profileEntry?.name, familiarityEntry?.name];

  const erased = {
    profile: userProfiles.deleteUserProfile(guildId, userId) ? 1 : 0,
    aliasEvidence: userProfiles.removeAliasEvidenceBySpeaker(guildId, userId),
    turns: turnLog.deleteUserTurns(guildId, userId),
    familiarity: familiarityEntry ? 1 : 0,
    pendingLines: guildProfiles.removeUserFromPendingContexts(guildId, userId, names),
  };
  // Every profile save leaves the pre-erasure file in .bak.
  userProfiles.scrubBackup();
  guildProfiles.scrubBackup();
  erased.any = Object.values(erased).some((n) => n > 0);
  return erased;
}

// One row per store holding per-guild data: how to list the guilds it knows
// and how to drop one. `erase` returns a count (or boolean) of what went.
const GUILD_STORES = [
  { name: "userProfiles", list: userProfiles.listGuildIds, erase: userProfiles.deleteGuildUserProfiles },
  { name: "guildProfile", list: guildProfiles.listGuildIds, erase: guildProfiles.deleteGuildProfile },
  { name: "familiarity", list: familiarity.listGuildIds, erase: familiarity.deleteGuildFamiliarity },
  { name: "turns", list: turnLog.listDistillLogGuildIds, erase: turnLog.deleteGuildTurns },
  { name: "tier", list: tiers.listGuildIds, erase: tiers.deleteGuildTier },
  { name: "language", list: languages.listGuildIds, erase: languages.deleteGuildLanguage },
  { name: "aiChat", list: aiChat.listGuildIds, erase: aiChat.deleteGuildAiChatMode },
  { name: "apiKey", list: guildKeys.listGuildIds, erase: guildKeys.removeGuildApiKey },
];

// Returns the removed schedule rows too: their cron jobs are live in the
// scheduler and the caller has to stop them.
function eraseGuildData(guildId) {
  if (!guildId) return { any: false, removedSchedules: [] };
  const erased = {};
  for (const store of GUILD_STORES) erased[store.name] = Number(store.erase(guildId)) || 0;
  const removedSchedules = schedules.removeGuildSchedules(guildId);
  erased.schedules = removedSchedules.length;
  userProfiles.scrubBackup();
  guildProfiles.scrubBackup();
  erased.any = Object.values(erased).some((n) => n > 0);
  return { ...erased, removedSchedules };
}

// Every guild id any store still holds data for.
function listStoredGuildIds() {
  const ids = new Set(schedules.listGuildIds());
  for (const store of GUILD_STORES) for (const id of store.list()) ids.add(id);
  return [...ids];
}

// "profile=1 turns=12" — the non-zero counts, for the log line.
function describeErasure(erased) {
  return Object.entries(erased)
    .filter(([key, n]) => key !== "any" && typeof n === "number" && n > 0)
    .map(([key, n]) => `${key}=${n}`)
    .join(" ");
}

module.exports = {
  eraseUserData,
  eraseGuildData,
  listStoredGuildIds,
  describeErasure,
};
