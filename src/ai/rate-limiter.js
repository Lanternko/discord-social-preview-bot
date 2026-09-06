const fs = require("fs");
const path = require("path");

const STORE_PATH = path.join(__dirname, "..", "..", "data", "ai-daily-usage.json");

// Day boundary follows Taipei, not UTC. With UTC the counter reset landed at
// 08:00 local — mid-morning, splitting the day the guilds actually experience.
const DAY_TIMEZONE = "Asia/Taipei";

// en-CA gives YYYY-MM-DD, which sorts and compares as a plain string.
const dayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DAY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function todayString(now = Date.now()) {
  return dayFormatter.format(new Date(now));
}

let counters = null;

function load() {
  if (counters !== null) return counters;
  counters = new Map();
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    if (parsed && typeof parsed === "object") {
      for (const [guildId, entry] of Object.entries(parsed)) {
        if (!entry || typeof entry !== "object") continue;
        const count = Number(entry.count);
        if (!entry.date || !Number.isFinite(count)) continue;
        counters.set(guildId, {
          date: String(entry.date),
          count,
          lastAt: Number(entry.lastAt) || 0,
        });
      }
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[rate-limit] failed to read ${STORE_PATH}: ${err.message}`);
    }
  }
  return counters;
}

// Only today's rows are worth keeping — yesterday's would be discarded on read
// anyway, so dropping them here keeps the file from growing per guild forever.
function save(today) {
  const data = {};
  for (const [guildId, entry] of load()) {
    if (entry.date === today) data[guildId] = entry;
  }
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn(`[rate-limit] failed to write ${STORE_PATH}: ${err.message}`);
  }
}

function checkAndIncrement(guildId, dailyLimit, now = Date.now()) {
  if (!guildId || !dailyLimit || dailyLimit <= 0) {
    return { allowed: true, remaining: Infinity };
  }

  const today = todayString(now);
  const store = load();
  let entry = store.get(guildId);

  // The stored date IS the "last counted at" check the reset hinges on: an
  // entry stamped with any earlier day means the guild's last call was
  // yesterday or before, so the count starts over.
  if (!entry || entry.date !== today) {
    entry = { date: today, count: 0, lastAt: 0 };
    store.set(guildId, entry);
  }

  if (entry.count >= dailyLimit) {
    return { allowed: false, remaining: 0 };
  }

  entry.count += 1;
  entry.lastAt = now;
  save(today);
  return { allowed: true, remaining: dailyLimit - entry.count };
}

function getUsage(guildId, now = Date.now()) {
  if (!guildId) return null;
  const today = todayString(now);
  const entry = load().get(guildId);
  if (!entry || entry.date !== today) return { count: 0, date: today };
  return { count: entry.count, date: entry.date, lastAt: entry.lastAt };
}

function resetForTests() {
  counters = new Map();
}

module.exports = {
  STORE_PATH,
  DAY_TIMEZONE,
  todayString,
  checkAndIncrement,
  getUsage,
  resetForTests,
};
