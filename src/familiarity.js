// Per-guild message-count tally for each user. Surfaces "who's who in this
// server" to 西寶 so she can be more familiar with frequent talkers and
// generic-shy with strangers — without us hand-curating any list.
//
// Storage: in-memory map + debounced 60s flush to data/familiarity.json. We
// can't write on every messageCreate (busy guilds = constant disk IO) and we
// can't only flush on shutdown (crashes lose data) — debounced is the
// compromise. Worst case loss = ~60s of counts.

const fs = require("node:fs");
const path = require("node:path");

const STORE_PATH = path.join(__dirname, "..", "data", "familiarity.json");
const FLUSH_INTERVAL_MS = 60 * 1000;
const ROSTER_LIMIT = 20;

// Tier thresholds, ordered high → low for first-match lookup.
const TIERS = [
  { min: 500, label: "摯友" },
  { min: 100, label: "老朋友" },
  { min: 20, label: "熟人" },
  { min: 5, label: "認識" },
  { min: 1, label: "剛認識" },
];

let cache = null;
let dirty = false;
let flushTimer = null;

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[familiarity] failed to read ${STORE_PATH}: ${err.message}`);
    }
    cache = {};
  }
  return cache;
}

function flush() {
  if (!dirty || cache === null) return;
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(cache, null, 2));
    dirty = false;
  } catch (err) {
    console.warn(`[familiarity] flush failed: ${err.message}`);
  }
}

function startFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

function stopFlushTimer() {
  if (!flushTimer) return;
  clearInterval(flushTimer);
  flushTimer = null;
}

function recordMessage(guildId, userId, displayName) {
  if (!guildId || !userId) return;
  const data = load();
  if (!data[guildId]) data[guildId] = {};
  const entry = data[guildId][userId] || { name: displayName || "未知", count: 0 };
  entry.count += 1;
  if (displayName) entry.name = displayName;
  data[guildId][userId] = entry;
  dirty = true;
  startFlushTimer();
}

function tierLabel(count) {
  for (const t of TIERS) {
    if (count >= t.min) return t.label;
  }
  return null;
}

function getFamiliarityRoster(guildId) {
  if (!guildId) return [];
  const data = load();
  const entries = data[guildId] || {};
  return Object.values(entries)
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, ROSTER_LIMIT)
    .map((e) => ({ name: e.name, count: e.count, tier: tierLabel(e.count) }));
}

function buildFamiliarityBlock(roster) {
  if (!roster || roster.length === 0) return "";

  // Group by tier in canonical order; only emit tiers that have members so
  // 西寶 doesn't see empty buckets.
  const byTier = new Map();
  for (const r of roster) {
    if (!r.tier) continue;
    if (!byTier.has(r.tier)) byTier.set(r.tier, []);
    byTier.get(r.tier).push(r.name);
  }

  const lines = ["## 群友熟悉度 (這個伺服器累積發言計數)"];
  for (const t of TIERS) {
    const names = byTier.get(t.label);
    if (!names || names.length === 0) continue;
    lines.push(`${t.label}（${t.min}+ 訊息）：${names.join("、")}`);
  }
  return "\n\n" + lines.join("\n");
}

function resetCacheForTests() {
  cache = null;
  dirty = false;
  stopFlushTimer();
}

module.exports = {
  STORE_PATH,
  TIERS,
  ROSTER_LIMIT,
  recordMessage,
  getFamiliarityRoster,
  buildFamiliarityBlock,
  tierLabel,
  flush,
  stopFlushTimer,
  resetCacheForTests,
};
