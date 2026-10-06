const fs = require("node:fs");
const path = require("node:path");
const {
  mergeEvidenceNewest,
  STABLE_TIME_GAP_MS,
  capByPriority,
  carryObservations,
} = require("./user-profile-store");

const STORE_PATH = path.join(__dirname, "..", "data", "guild-profiles.json");
const BAK_PATH = STORE_PATH + ".bak";

const OBSERVATION_MAX_LEN = 120;
const PROFILE_PROMPT_MAX_LEN = 300;
const CONTEXT_SNAPSHOT_MAX_LEN = 2000;
const RECENT_OBSERVATIONS_PROMPT_COUNT = 3;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

// Structured guild profile, same idea as the per-user one: fixed fields of
// short items, each carrying the messages that back it and when it was last
// re-confirmed. The prose summary it replaces was rewritten wholesale every
// consolidation, so topics piled up and never left, and nothing checked what
// the rewrite smuggled in (bot-usage notes, a person's nickname).
const GUILD_FIELDS = [
  { key: "topics", label: "常聊話題", max: 4 },
  { key: "style", label: "互動風格", max: 3 },
  { key: "memes", label: "群內梗", max: 3 },
];
const GUILD_ITEM_TEXT_MAX_LEN = 30;
// Shorter than the user 120 d: a group's topics turn over with seasons,
// patches and whatever game is hot — a person's temperament doesn't.
const GUILD_ITEM_STALE_MS = 60 * 24 * 60 * 60 * 1000;

let cache = null;

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[guild-profiles] failed to read ${STORE_PATH}: ${err.message}`);
    }
    cache = {};
  }
  return cache;
}

function save() {
  const data = cache ?? {};
  const dir = path.dirname(STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.copyFileSync(STORE_PATH, BAK_PATH);
  } catch (_) {}
  const tmp = STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

function clampConfidence(val) {
  if (typeof val !== "number" || !Number.isFinite(val)) return 0.5;
  return Math.max(0, Math.min(1, val));
}

function sanitizeObservationText(text) {
  if (!text || typeof text !== "string") return null;
  const clean = text.replace(CONTROL_CHARS_RE, " ").replace(/ {2,}/g, " ").trim();
  if (!clean) return null;
  return clean.slice(0, OBSERVATION_MAX_LEN);
}

function makeEmptyEntry(guildName) {
  return {
    name: guildName || "未知",
    observations: [],
    pendingContexts: [],
    lastExtractedAt: null,
    profile: null,
    profileAt: null,
    updatedAt: null,
  };
}

function getGuildProfile(guildId) {
  if (!guildId) return null;
  const data = load();
  return data[guildId] ?? null;
}

// Rows are group-context rows ({ line, messageId, at, displayName }) or plain
// strings (old callers / tests). Consecutive replies re-fetch mostly the same
// channel window, so a row already sitting in a pending snapshot is dropped —
// otherwise one busy afternoon reads to the extractor like a recurring habit.
function normalizeContextRows(rows) {
  return rows
    .map((r) => (typeof r === "string" ? { line: r } : r))
    .filter((r) => r && typeof r.line === "string" && r.line.trim())
    .map((r) => ({
      text: r.line.replace(CONTROL_CHARS_RE, " ").trim(),
      messageId: r.messageId ? String(r.messageId) : null,
      at: typeof r.at === "number" && Number.isFinite(r.at) ? r.at : null,
      speaker: r.displayName ? String(r.displayName) : null,
    }));
}

function appendPendingContext(guildId, guildName, contextRows) {
  if (!guildId) return;
  if (!Array.isArray(contextRows) || contextRows.length === 0) return;

  const data = load();
  const entry = data[guildId] || makeEmptyEntry(guildName);
  if (guildName) entry.name = guildName;
  if (!entry.pendingContexts) entry.pendingContexts = [];

  const seen = new Set();
  for (const snap of entry.pendingContexts) {
    for (const l of snap.lines || []) if (l.messageId) seen.add(l.messageId);
  }
  const lines = [];
  let chars = 0;
  for (const row of normalizeContextRows(contextRows)) {
    if (row.messageId && seen.has(row.messageId)) continue;
    if (chars + row.text.length > CONTEXT_SNAPSHOT_MAX_LEN) break;
    chars += row.text.length + 1;
    lines.push(row);
  }
  if (lines.length === 0) return;

  entry.pendingContexts.push({
    text: lines.map((l) => l.text).join("\n"),
    lines,
    at: Date.now(),
  });
  entry.updatedAt = Date.now();
  data[guildId] = entry;
  save();
}

function getPendingContexts(guildId) {
  const entry = getGuildProfile(guildId);
  return entry?.pendingContexts ?? [];
}

function clearPendingContexts(guildId) {
  if (!guildId) return;
  const data = load();
  const entry = data[guildId];
  if (!entry) return;
  entry.pendingContexts = [];
  entry.lastExtractedAt = Date.now();
  entry.updatedAt = Date.now();
  save();
}

function appendObservations(guildId, guildName, observations) {
  if (!guildId) return;
  if (!Array.isArray(observations) || observations.length === 0) return;

  const data = load();
  const entry = data[guildId] || makeEmptyEntry(guildName);
  if (guildName) entry.name = guildName;

  const now = Date.now();
  for (const obs of observations) {
    const text = sanitizeObservationText(obs.text);
    if (!text) continue;
    const evidence = mergeEvidenceNewest(obs.evidence || []);
    const existing = entry.observations.find((o) => o.text === text);
    if (existing) {
      existing.evidence = mergeEvidenceNewest(existing.evidence || [], evidence);
      existing.confidence = Math.max(clampConfidence(existing.confidence), clampConfidence(obs.confidence));
      existing.at = now;
      delete existing.carried;
      continue;
    }
    entry.observations.push({
      text,
      at: typeof obs.at === "number" ? obs.at : now,
      confidence: clampConfidence(obs.confidence),
      evidence,
    });
  }

  entry.updatedAt = now;
  data[guildId] = entry;
  save();
}

// A group trait is stable once it shows up at two moments far enough apart —
// message count alone isn't enough here: one lively thread yields a dozen
// messages on the same thing within minutes.
function isGuildStableEvidence(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  const ids = new Set(list.map((e) => e?.messageId).filter(Boolean));
  if (ids.size < 2) return false;
  const ats = list.map((e) => e?.at).filter((v) => typeof v === "number");
  return ats.length >= 2 && Math.max(...ats) - Math.min(...ats) >= STABLE_TIME_GAP_MS;
}

function guildFieldOf(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return GUILD_FIELDS.find((f) => f.key === v || f.label === v) || null;
}

function isGuildItemStale(item, now = Date.now()) {
  const last = typeof item?.lastSeenAt === "number" ? item.lastSeenAt : 0;
  return now - last >= GUILD_ITEM_STALE_MS;
}

// Over-long items are cut at the last clause break rather than mid-word — a
// model that copies a whole prose sentence would otherwise leave「…遊戲實」.
const CLAUSE_BREAK_RE = /[，、；,;]/g;
const CLAUSE_CUT_MIN_LEN = 8;

function capGuildItemText(text) {
  if (text.length <= GUILD_ITEM_TEXT_MAX_LEN) return text;
  const head = text.slice(0, GUILD_ITEM_TEXT_MAX_LEN);
  let cut = -1;
  for (const m of head.matchAll(CLAUSE_BREAK_RE)) cut = m.index;
  return cut >= CLAUSE_CUT_MIN_LEN ? head.slice(0, cut) : head;
}

function sanitizeGuildItems(items) {
  const out = {};
  const now = Date.now();
  for (const f of GUILD_FIELDS) {
    const list = Array.isArray(items?.[f.key]) ? items[f.key] : [];
    const seen = new Set();
    const kept = [];
    for (const it of list) {
      const text = typeof it?.text === "string"
        ? capGuildItemText(it.text.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").replace(/^[-・•*\s]+/, "").trim())
        : "";
      if (!text || seen.has(text)) continue;
      seen.add(text);
      kept.push({
        text,
        evidence: mergeEvidenceNewest(it.evidence || []),
        firstAt: typeof it.firstAt === "number" ? it.firstAt : now,
        lastSeenAt: typeof it.lastSeenAt === "number" ? it.lastSeenAt : now,
        tentative: Boolean(it.tentative),
      });
    }
    out[f.key] = capByPriority(kept, f.max, isGuildStableEvidence);
  }
  return out;
}

function liveGuildItems(items, field, now = Date.now()) {
  return (items?.[field.key] || []).filter((it) => it?.text && !isGuildItemStale(it, now));
}

function guildItemLabel(it) {
  return it.tentative ? `（或許）${it.text}` : it.text;
}

// Field-per-line text; derived at read time so stale items drop out without a
// rewrite. /memory guild shows it verbatim.
function renderGuildProfileText(items, now = Date.now()) {
  if (!items) return "";
  const lines = [];
  for (const f of GUILD_FIELDS) {
    const live = liveGuildItems(items, f, now);
    if (live.length > 0) lines.push(`${f.label}：${live.map(guildItemLabel).join("；")}`);
  }
  return lines.join("\n");
}

function guildProfileTextOf(entry, now = Date.now()) {
  if (!entry) return "";
  if (entry.items) return renderGuildProfileText(entry.items, now);
  return entry.profile || "";
}

// Cited observations are consumed (their evidence now lives on the items
// citing them); uncited ones carry over — see carryObservations.
function setGuildProfileItems(guildId, items, consumed = null) {
  if (!guildId) return;
  const data = load();
  const entry = data[guildId];
  if (!entry) return;
  const now = Date.now();
  const clean = sanitizeGuildItems(items);
  entry.items = clean;
  entry.profile = renderGuildProfileText(clean, now) || null;
  entry.profileAt = now;
  entry.observations = carryObservations(entry.observations, consumed);
  entry.updatedAt = now;
  save();
}

function buildGuildProfileBlock(entry) {
  const now = Date.now();
  const itemLines = [];
  if (entry?.items) {
    for (const f of GUILD_FIELDS) {
      const live = liveGuildItems(entry.items, f, now);
      if (live.length > 0) itemLines.push(`- ${f.label}：${live.map(guildItemLabel).join("；")}`);
    }
  }
  const legacy = !entry?.items && entry?.profile;
  if (itemLines.length === 0 && !legacy && !entry?.observations?.length) return "";
  const lines = [
    "\n\n## 這個群的長期印象",
    "這是你對目前 Discord 群的輕量印象，只能用來理解氣氛，不要直接複述。",
  ];

  if (itemLines.length > 0) {
    lines.push(...itemLines);
  } else if (legacy) {
    lines.push(`- 摘要：${entry.profile.slice(0, PROFILE_PROMPT_MAX_LEN)}`);
  }

  const recentObservations = (entry.observations || [])
    .slice(-RECENT_OBSERVATIONS_PROMPT_COUNT)
    .map((o) => o.text)
    .filter(Boolean);
  if (recentObservations.length > 0) {
    lines.push("- 最近零散觀察：");
    for (const obs of recentObservations) {
      lines.push(`  - ${obs}`);
    }
  }

  return lines.join("\n");
}

function flush() {
  save();
}

function resetCacheForTests() {
  cache = {};
}

module.exports = {
  STORE_PATH,
  OBSERVATION_MAX_LEN,
  PROFILE_PROMPT_MAX_LEN,
  CONTEXT_SNAPSHOT_MAX_LEN,
  RECENT_OBSERVATIONS_PROMPT_COUNT,
  GUILD_FIELDS,
  GUILD_ITEM_TEXT_MAX_LEN,
  GUILD_ITEM_STALE_MS,
  isGuildStableEvidence,
  guildFieldOf,
  isGuildItemStale,
  sanitizeGuildItems,
  renderGuildProfileText,
  guildProfileTextOf,
  setGuildProfileItems,
  getGuildProfile,
  appendPendingContext,
  getPendingContexts,
  clearPendingContexts,
  appendObservations,
  buildGuildProfileBlock,
  flush,
  resetCacheForTests,
};
