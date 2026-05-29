const fs = require("fs");
const path = require("path");

const SCHEDULE_STORE_PATH = path.join(
  __dirname,
  "..",
  "data",
  "schedules.json",
);

const MAX_SCHEDULES_PER_GUILD = 10;

let cache = null;

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(SCHEDULE_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(
        `[schedule-store] failed to read ${SCHEDULE_STORE_PATH}: ${err.message}`,
      );
    }
    cache = [];
  }
  return cache;
}

function save() {
  const data = cache ?? [];
  fs.mkdirSync(path.dirname(SCHEDULE_STORE_PATH), { recursive: true });
  fs.writeFileSync(SCHEDULE_STORE_PATH, JSON.stringify(data, null, 2));
}

function generateId() {
  return Date.now().toString(36);
}

function getAllSchedules() {
  return load();
}

function getGuildSchedules(guildId) {
  return load().filter((s) => s.guildId === guildId);
}

function getScheduleById(id) {
  return load().find((s) => s.id === id);
}

function addSchedule(entry) {
  const schedules = load();
  const guildCount = schedules.filter(
    (s) => s.guildId === entry.guildId,
  ).length;
  if (guildCount >= MAX_SCHEDULES_PER_GUILD) {
    throw new Error(
      `已達上限（每個伺服器最多 ${MAX_SCHEDULES_PER_GUILD} 個排程）`,
    );
  }
  const full = {
    id: generateId(),
    ...entry,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  schedules.push(full);
  save();
  return full;
}

function updateSchedule(id, updates) {
  const schedules = load();
  const entry = schedules.find((s) => s.id === id);
  if (!entry) return null;
  Object.assign(entry, updates);
  save();
  return entry;
}

function removeSchedule(id) {
  const schedules = load();
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  const removed = schedules.splice(idx, 1)[0];
  save();
  return removed;
}

function resetCacheForTests() {
  cache = null;
}

module.exports = {
  SCHEDULE_STORE_PATH,
  MAX_SCHEDULES_PER_GUILD,
  getAllSchedules,
  getGuildSchedules,
  getScheduleById,
  addSchedule,
  updateSchedule,
  removeSchedule,
  resetCacheForTests,
};
