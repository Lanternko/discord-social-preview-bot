// When the bot left each guild, so its data can be erased after a grace
// period instead of on the spot (see data-retention.js for why).
// data/guild-departures.json: { [guildId]: leftAtMs }

const fs = require("node:fs");
const path = require("node:path");

const STORE_PATH = path.join(__dirname, "..", "data", "guild-departures.json");

let cache = null;

function load() {
  if (cache !== null) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[retention] failed to read ${STORE_PATH}: ${err.message}`);
    }
    cache = {};
  }
  return cache;
}

function save() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cache ?? {}, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

// Keeps the first departure time: re-marking a guild that is already
// counting down must not restart its clock.
function markGuildDeparted(guildId, now = Date.now()) {
  if (!guildId) return false;
  const data = load();
  if (guildId in data) return false;
  data[guildId] = now;
  save();
  return true;
}

function clearGuildDeparture(guildId) {
  const data = load();
  if (!guildId || !(guildId in data)) return false;
  delete data[guildId];
  save();
  return true;
}

function listDepartures() {
  return Object.entries(load()).map(([guildId, leftAt]) => ({ guildId, leftAt }));
}

function resetCacheForTests() {
  cache = null;
}

module.exports = {
  STORE_PATH,
  markGuildDeparted,
  clearGuildDeparture,
  listDepartures,
  resetCacheForTests,
};
