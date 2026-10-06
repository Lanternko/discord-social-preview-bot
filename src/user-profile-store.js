const fs = require("node:fs");
const path = require("node:path");
const { sanitizeName } = require("./utils");

const STORE_PATH = path.join(__dirname, "..", "data", "user-profiles.json");
const BAK_PATH = STORE_PATH + ".bak";

const OBSERVATION_MAX_LEN = 120;
const PROFILE_MAX_LEN = 500;
const PENDING_TEXT_MAX_LEN = 500;
const PENDING_MAX_COUNT = 60;
const EVIDENCE_MAX_PER_OBSERVATION = 10;
const RECENT_OBSERVATIONS_PROMPT_COUNT = 3;

// Structured profile: fixed fields, each a short dot list. Every item carries
// its own evidence + lastSeenAt, so an impression that stops being confirmed
// fades out on its own instead of being carried forward forever by prose
// rewrites (the old single-string profile was a game of telephone).
const PROFILE_FIELDS = [
  { key: "style", label: "說話風格", max: 3 },
  { key: "topics", label: "常聊話題", max: 4 },
  { key: "interaction", label: "互動偏好", max: 3 },
  { key: "notes", label: "注意", max: 2 },
];
const ITEM_TEXT_MAX_LEN = 40;
const ITEM_STALE_MS = 120 * 24 * 60 * 60 * 1000;
const PROFILE_HISTORY_MAX = 5;
// An observation no consolidation chose to cite is offered again next time,
// at most this many times — then it's dropped, so a trait the model keeps
// passing over can't linger as a perpetual re-consolidation trigger.
const OBSERVATION_MAX_CARRY = 2;

// Two-tier memory: the items above are the OUTLINE (always in the prompt,
// 12 slots). Every observation is also kept in a per-person DETAIL pool —
// the long tail that doesn't fit the outline (a game they play, a trip they
// took). Details only enter the prompt when relevant to the current message
// or when someone asks what 西寶 remembers (see ai/memory-details.js), and
// consolidation distills the outline from them. No LLM call maintains the
// pool: it's upserted as a side effect of appendObservations.
const DETAIL_MAX = 40;
const DETAIL_STALE_MS = 180 * 24 * 60 * 60 * 1000;
// Bigram-Jaccard at or above this = the same trait re-worded by a later
// extraction; its evidence is pooled into the existing detail instead of
// taking a second slot.
const DETAIL_MERGE_SIMILARITY = 0.6;

// The bar an observation (or item) must clear before it may be stated as a
// fact: at least 3 distinct source messages, or 2 distinct messages far
// enough apart in time that it wasn't one burst of the same moment.
const STABLE_MIN_DISTINCT_MESSAGES = 3;
const STABLE_TIME_GAP_MS = 6 * 60 * 60 * 1000;
const CONTROL_CHARS_RE = /[\x00-\x1f\x7f-\x9f]/g;

let cache = null;

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`[user-profiles] failed to read ${STORE_PATH}: ${err.message}`);
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
  } catch (_) {
    // no existing file to back up — fine
  }
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

function makeEmptyEntry(displayName) {
  return {
    name: sanitizeName(displayName),
    observations: [],
    pendingInteractions: [],
    lastExtractedAt: null,
    profile: null,
    profileAt: null,
    updatedAt: null,
  };
}

function capText(text, limit) {
  if (!text || typeof text !== "string") return "";
  return text.replace(CONTROL_CHARS_RE, " ").trim().slice(0, limit);
}

// meta: { messageId, source: "direct"|"passive", at }. Dedup is by Discord
// messageId ONLY — never by text. Repeating the same sentence across messages
// can itself be a personality trait; the same message scooped twice (passive
// group-context re-reads, direct + later passive overlap) is the only certain
// duplicate. Entries without a messageId are never deduped.
function appendPendingInteraction(guildId, userId, displayName, userText, assistantText, meta = {}) {
  if (!guildId || !userId) return false;
  const data = load();
  if (!data[guildId]) data[guildId] = {};
  const entry = data[guildId][userId] || makeEmptyEntry(displayName);
  if (displayName) entry.name = sanitizeName(displayName);
  if (!entry.pendingInteractions) entry.pendingInteractions = [];

  const messageId = meta.messageId ? String(meta.messageId) : null;
  if (messageId && entry.pendingInteractions.some((p) => p.messageId === messageId)) {
    return false;
  }

  entry.pendingInteractions.push({
    userText: capText(userText, PENDING_TEXT_MAX_LEN),
    assistantText: capText(assistantText, PENDING_TEXT_MAX_LEN),
    at: typeof meta.at === "number" && Number.isFinite(meta.at) ? meta.at : Date.now(),
    messageId,
    source: meta.source === "passive" ? "passive" : "direct",
  });
  if (entry.pendingInteractions.length > PENDING_MAX_COUNT) {
    entry.pendingInteractions.splice(
      0,
      entry.pendingInteractions.length - PENDING_MAX_COUNT,
    );
  }
  entry.updatedAt = Date.now();
  data[guildId][userId] = entry;
  save();
  return true;
}

function getPendingInteractions(guildId, userId) {
  const entry = getUserProfile(guildId, userId);
  return entry?.pendingInteractions ?? [];
}

function clearPending(guildId, userId) {
  if (!guildId || !userId) return;
  const data = load();
  const entry = data[guildId]?.[userId];
  if (!entry) return;
  entry.pendingInteractions = [];
  entry.lastExtractedAt = Date.now();
  entry.updatedAt = Date.now();
  save();
}

function getUserProfile(guildId, userId) {
  if (!guildId || !userId) return null;
  const data = load();
  return data[guildId]?.[userId] ?? null;
}

// Evidence items are { messageId, at, source } pointing at the Discord
// messages an observation was derived from. Items without a messageId are
// dropped — they can never satisfy the stability bar, so storing them would
// only fake support.
function sanitizeEvidence(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const messageId = item?.messageId ? String(item.messageId) : null;
    if (!messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    out.push({
      messageId,
      at: typeof item.at === "number" && Number.isFinite(item.at) ? item.at : null,
      source: item.source === "passive" ? "passive" : "direct",
    });
    if (out.length >= EVIDENCE_MAX_PER_OBSERVATION) break;
  }
  return out;
}

function mergeEvidence(existing, incoming) {
  return sanitizeEvidence([...(existing || []), ...(incoming || [])]);
}

// Pooled item evidence keeps the NEWEST messages when it hits the cap — an
// item's support should track what the person does now, not what they did
// the first week.
function mergeEvidenceNewest(...lists) {
  const all = lists.flat().filter(Boolean);
  all.sort((a, b) => (b?.at ?? 0) - (a?.at ?? 0));
  return sanitizeEvidence(all);
}

function isStableEvidence(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  const ids = new Set(list.map((e) => e?.messageId).filter(Boolean));
  if (ids.size >= STABLE_MIN_DISTINCT_MESSAGES) return true;
  if (ids.size >= 2) {
    const ats = list
      .map((e) => (typeof e?.at === "number" ? e.at : null))
      .filter((v) => v !== null);
    if (ats.length >= 2 && Math.max(...ats) - Math.min(...ats) >= STABLE_TIME_GAP_MS) {
      return true;
    }
  }
  return false;
}

function fieldByKeyOrLabel(value) {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return PROFILE_FIELDS.find((f) => f.key === v || f.label === v) || null;
}

function isItemStale(item, now = Date.now()) {
  const last = typeof item?.lastSeenAt === "number" ? item.lastSeenAt : 0;
  return now - last >= ITEM_STALE_MS;
}

function sanitizeItemText(text) {
  if (!text || typeof text !== "string") return null;
  const clean = text
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-・•*\s]+/, "")
    .trim();
  if (!clean) return null;
  return clean.slice(0, ITEM_TEXT_MAX_LEN);
}

function distinctEvidenceCount(evidence) {
  return new Set((evidence || []).map((e) => e?.messageId).filter(Boolean)).size;
}

// Trims a field to `max` by priority, not by list position: stable evidence
// first, then more distinct messages, then most recently confirmed. Models
// echo the old items before adding new ones, so cutting by position always
// sacrificed the newest, best-supported items to unsupported legacy ones —
// a full field could never change. Survivors keep their original order.
function capByPriority(list, max, isStable = isStableEvidence) {
  if (list.length <= max) return list;
  const ranked = list
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) =>
      Number(isStable(b.it.evidence)) - Number(isStable(a.it.evidence))
      || distinctEvidenceCount(b.it.evidence) - distinctEvidenceCount(a.it.evidence)
      || (b.it.lastSeenAt ?? 0) - (a.it.lastSeenAt ?? 0)
      || a.idx - b.idx);
  const keep = new Set(ranked.slice(0, max).map((r) => r.idx));
  return list.filter((_, idx) => keep.has(idx));
}

// Text → set of CJK bigrams + lowercase ascii words. Shared by the detail
// near-dup merge here and relevance retrieval in ai/memory-details.js.
function textTokens(text) {
  const out = new Set();
  const t = String(text || "").normalize("NFC").toLowerCase();
  for (const w of t.match(/[a-z0-9][a-z0-9_.+-]*/g) || []) {
    if (w.length >= 2) out.add(w);
  }
  for (const run of t.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]+/g) || []) {
    if (run.length === 1) continue;
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function tokenSimilarity(a, b) {
  const ta = textTokens(a);
  const tb = textTokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const x of ta) if (tb.has(x)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function isDetailStale(d, now = Date.now()) {
  return now - (typeof d?.lastSeenAt === "number" ? d.lastSeenAt : 0) >= DETAIL_STALE_MS;
}

function sanitizeDetail(d, now = Date.now()) {
  const text = sanitizeObservationText(d?.text);
  if (!text) return null;
  const evidence = sanitizeEvidence(d.evidence);
  const latest = Math.max(0, ...evidence.map((e) => e.at ?? 0));
  return {
    text,
    evidence,
    firstAt: typeof d.firstAt === "number" ? d.firstAt : now,
    lastSeenAt: typeof d.lastSeenAt === "number" ? d.lastSeenAt : (latest || now),
    confidence: clampConfidence(d.confidence),
  };
}

// Folds observations into a detail list: near-duplicates pool evidence,
// new traits get their own row, stale rows drop, and the pool is capped by
// the same priority as outline items (evidence first, then recency).
function upsertDetails(details, observations, now = Date.now()) {
  const list = (details || []).map((d) => sanitizeDetail(d, now)).filter(Boolean);
  for (const obs of observations || []) {
    const incoming = sanitizeDetail(obs, now);
    if (!incoming) continue;
    const latest = Math.max(0, ...incoming.evidence.map((e) => e.at ?? 0));
    const seenAt = latest || (typeof obs.at === "number" ? obs.at : now);
    const match = list.find((d) => d.text === incoming.text
      || tokenSimilarity(d.text, incoming.text) >= DETAIL_MERGE_SIMILARITY);
    if (match) {
      match.evidence = mergeEvidenceNewest(match.evidence, incoming.evidence);
      match.lastSeenAt = Math.max(match.lastSeenAt, seenAt);
      match.confidence = Math.max(match.confidence, incoming.confidence);
      continue;
    }
    list.push({ ...incoming, firstAt: seenAt, lastSeenAt: seenAt });
  }
  return capByPriority(list.filter((d) => !isDetailStale(d, now)), DETAIL_MAX);
}

// The detail pool, seeded on first read for profiles that predate it:
// evidence-backed outline items + pending observations. Read-only — the seed
// is persisted by the next appendObservations.
function detailsOf(entry, now = Date.now()) {
  if (!entry) return [];
  if (Array.isArray(entry.details)) return entry.details.filter((d) => !isDetailStale(d, now));
  const seed = [];
  for (const f of PROFILE_FIELDS) {
    for (const it of entry.items?.[f.key] || []) {
      if ((it?.evidence?.length ?? 0) === 0) continue;
      seed.push({ text: it.text, evidence: it.evidence, at: it.lastSeenAt, confidence: it.tentative ? 0.5 : 0.7 });
    }
  }
  return upsertDetails([], [...seed, ...(entry.observations || [])], now);
}

// Normalises an items map: known fields only, text dedup, per-field cap.
function sanitizeItems(items) {
  const out = {};
  for (const f of PROFILE_FIELDS) {
    const list = Array.isArray(items?.[f.key]) ? items[f.key] : [];
    const seen = new Set();
    const kept = [];
    for (const it of list) {
      const text = sanitizeItemText(it?.text);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      const now = Date.now();
      kept.push({
        text,
        evidence: sanitizeEvidence(it.evidence),
        firstAt: typeof it.firstAt === "number" ? it.firstAt : now,
        lastSeenAt: typeof it.lastSeenAt === "number" ? it.lastSeenAt : now,
        tentative: Boolean(it.tentative),
      });
    }
    out[f.key] = capByPriority(kept, f.max);
  }
  return out;
}

function liveItems(items, field, now = Date.now()) {
  return (items?.[field.key] || []).filter((it) => it?.text && !isItemStale(it, now));
}

function itemLabel(it) {
  return it.tentative ? `（或許）${it.text}` : it.text;
}

// The legacy single-string form (field-per-line, items joined with 「；」).
// Kept because target-context / story ingredients / /memory consume it, and
// derived at read time so stale items drop out without a rewrite.
function renderProfileText(items, now = Date.now()) {
  if (!items) return "";
  const lines = [];
  for (const f of PROFILE_FIELDS) {
    const live = liveItems(items, f, now);
    if (live.length === 0) continue;
    lines.push(`${f.label}：${live.map(itemLabel).join("；")}`);
  }
  return lines.join("\n");
}

function profileTextOf(entry, now = Date.now()) {
  if (!entry) return "";
  if (entry.items) return renderProfileText(entry.items, now);
  return entry.profile || "";
}

function appendObservations(guildId, userId, displayName, observations) {
  if (!guildId || !userId) return;
  if (!Array.isArray(observations) || observations.length === 0) return;

  const data = load();
  if (!data[guildId]) data[guildId] = {};

  const entry = data[guildId][userId] || makeEmptyEntry(displayName);

  if (displayName) entry.name = sanitizeName(displayName);

  const now = Date.now();
  // Read (and, for an old profile, seed) the pool before this batch lands in
  // entry.observations, so the batch isn't folded in twice.
  const baseDetails = detailsOf(entry, now);
  for (const obs of observations) {
    const text = sanitizeObservationText(obs.text);
    if (!text) continue;
    const evidence = sanitizeEvidence(obs.evidence);
    // Same trait re-extracted in a later batch: pool the evidence instead of
    // duplicating the row — accumulated distinct messageIds are what let an
    // observation cross the stability bar over time.
    const existing = entry.observations.find((o) => o.text === text);
    if (existing) {
      existing.evidence = mergeEvidence(existing.evidence, evidence);
      existing.confidence = Math.max(
        clampConfidence(existing.confidence),
        clampConfidence(obs.confidence),
      );
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
  entry.details = upsertDetails(baseDetails, observations, now);

  entry.updatedAt = now;
  data[guildId][userId] = entry;
  save();
}

function setConsolidatedProfile(guildId, userId, profileText) {
  if (!guildId || !userId) return;
  const data = load();
  const entry = data[guildId]?.[userId];
  if (!entry) return;

  // Newlines survive: the consolidated profile is field-per-line
  // (說話風格：…\n常聊話題：…) and /memory show renders it verbatim.
  const clean = (profileText || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(CONTROL_CHARS_RE, " ").replace(/ {2,}/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .slice(0, PROFILE_MAX_LEN);

  entry.profile = clean || null;
  entry.profileAt = Date.now();
  entry.observations = [];
  entry.updatedAt = Date.now();
  save();
}

// What happens to observations after a consolidation. Without `offered`,
// all are consumed (the redistill scripts' whole-profile rewrite). With it:
// cited ones are consumed (their evidence now lives on the items citing
// them); offered-but-uncited ones are carried to the next pass, up to
// OBSERVATION_MAX_CARRY times, if they have evidence to ever build on;
// ones appended while the consolidation call was in flight are untouched.
function carryObservations(observations, consumed) {
  if (!consumed?.offered) return [];
  const offered = new Set(consumed.offered);
  const cited = new Set(consumed.cited || []);
  const out = [];
  for (const o of observations || []) {
    if (!offered.has(o.text)) {
      out.push(o);
      continue;
    }
    if (cited.has(o.text)) continue;
    const carried = (o.carried ?? 0) + 1;
    if (carried > OBSERVATION_MAX_CARRY || (o.evidence?.length ?? 0) === 0) continue;
    out.push({ ...o, carried });
  }
  return out;
}

// Observations a consolidation hasn't seen yet — carried ones were already
// offered once, so they shouldn't by themselves trigger another pass.
function freshObservations(observations) {
  return (observations || []).filter((o) => !o.carried);
}

// Replaces the profile with a structured items map. The previous rendering is
// pushed onto profileHistory first, so drift between consolidations can be
// audited (which "plank" got swapped, and when). `consumed` = { offered,
// cited } observation texts; see carryObservations.
function setProfileItems(guildId, userId, items, consumed = null) {
  if (!guildId || !userId) return;
  const data = load();
  const entry = data[guildId]?.[userId];
  if (!entry) return;

  const now = Date.now();
  const clean = sanitizeItems(items);
  const nextText = renderProfileText(clean, now);
  const prevText = profileTextOf(entry, now);
  if (prevText && prevText !== nextText) {
    const history = Array.isArray(entry.profileHistory) ? entry.profileHistory : [];
    history.push({ at: entry.profileAt ?? null, profile: prevText });
    entry.profileHistory = history.slice(-PROFILE_HISTORY_MAX);
  }

  entry.items = clean;
  entry.profile = nextText || null;
  entry.profileAt = now;
  entry.observations = carryObservations(entry.observations, consumed);
  entry.updatedAt = now;
  save();
}

// Aliases = what OTHER people in the guild call this person (綽號), learned
// from group chat by alias-extractor.js. Each alias pools evidence as
// { messageId, at, speakerId }; code has already verified the speaker isn't
// the person and the alias literally appears in that message. One message is
// a guess — an alias counts once it shows up in ALIAS_CONFIRM_MIN_MESSAGES
// distinct messages, and ages out like profile items.
const ALIAS_MAX_LEN = 12;
const ALIAS_MAX_PER_USER = 8;
const ALIAS_EVIDENCE_MAX = 10;
const ALIAS_CONFIRM_MIN_MESSAGES = 2;
const ALIAS_PROMPT_MAX = 3;

function sanitizeAlias(text) {
  if (typeof text !== "string") return "";
  const t = text.normalize("NFC").replace(CONTROL_CHARS_RE, "").replace(/\s+/g, " ").trim();
  return t.length > 0 && t.length <= ALIAS_MAX_LEN ? t : "";
}

function aliasKey(alias) {
  return alias.normalize("NFC").toLowerCase();
}

function sanitizeAliasEvidence(list) {
  const seen = new Set();
  const out = [];
  for (const ev of Array.isArray(list) ? list : []) {
    const messageId = ev?.messageId ? String(ev.messageId) : null;
    if (!messageId || seen.has(messageId)) continue;
    seen.add(messageId);
    out.push({
      messageId,
      at: typeof ev.at === "number" && Number.isFinite(ev.at) ? ev.at : null,
      speakerId: ev.speakerId ? String(ev.speakerId) : null,
    });
  }
  out.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return out.slice(0, ALIAS_EVIDENCE_MAX);
}

// Denials = aliases the person themselves told 西寶 not to use (「別叫我X」).
// They outrank any amount of group evidence and never age out — an explicit
// wish shouldn't quietly lapse after 120 days. Lifted only by the person
// saying the opposite (「叫我X就好」), see alias-statements.js.
const ALIAS_DENIALS_MAX = 10;

function isAliasDenied(entry, alias) {
  const key = aliasKey(alias || "");
  return (entry?.aliasDenials || []).some((d) => aliasKey(d.alias) === key);
}

function denyAlias(guildId, userId, displayName, alias, meta = {}) {
  if (!guildId || !userId) return false;
  const clean = sanitizeAlias(alias);
  if (!clean) return false;
  const data = load();
  if (!data[guildId]) data[guildId] = {};
  const entry = data[guildId][userId] || makeEmptyEntry(displayName);
  const at = typeof meta.at === "number" && Number.isFinite(meta.at) ? meta.at : Date.now();
  const denials = (entry.aliasDenials || []).filter((d) => aliasKey(d.alias) !== aliasKey(clean));
  denials.push({ alias: clean, at, messageId: meta.messageId ? String(meta.messageId) : null });
  entry.aliasDenials = denials.slice(-ALIAS_DENIALS_MAX);
  if (Array.isArray(entry.aliases)) {
    entry.aliases = entry.aliases.filter((a) => aliasKey(a.alias) !== aliasKey(clean));
  }
  entry.updatedAt = Date.now();
  data[guildId][userId] = entry;
  save();
  return true;
}

function allowAlias(guildId, userId, alias) {
  const entry = guildId && userId ? load()[guildId]?.[userId] : null;
  const clean = sanitizeAlias(alias);
  if (!entry || !clean || !isAliasDenied(entry, clean)) return false;
  entry.aliasDenials = entry.aliasDenials.filter((d) => aliasKey(d.alias) !== aliasKey(clean));
  entry.updatedAt = Date.now();
  save();
  return true;
}

function deniedAliases(entry) {
  return (entry?.aliasDenials || []).map((d) => d.alias);
}

function recordAliasEvidence(guildId, userId, displayName, alias, evidence) {
  if (!guildId || !userId) return false;
  const clean = sanitizeAlias(alias);
  const incoming = sanitizeAliasEvidence(evidence);
  if (!clean || incoming.length === 0) return false;

  const data = load();
  if (!data[guildId]) data[guildId] = {};
  if (isAliasDenied(data[guildId][userId], clean)) return false;
  const entry = data[guildId][userId] || makeEmptyEntry(displayName);
  if (displayName && !data[guildId][userId]) entry.name = sanitizeName(displayName);
  const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
  const existing = aliases.find((a) => aliasKey(a.alias) === aliasKey(clean));
  const now = Date.now();
  if (existing) {
    existing.evidence = sanitizeAliasEvidence([...existing.evidence, ...incoming]);
  } else {
    aliases.push({ alias: clean, evidence: incoming, firstAt: now });
  }
  for (const a of aliases) {
    a.lastSeenAt = Math.max(...a.evidence.map((e) => e.at ?? 0), a.lastSeenAt ?? 0);
  }
  // Over the cap, the least-supported (then oldest) alias goes first.
  aliases.sort((a, b) => b.evidence.length - a.evidence.length || b.lastSeenAt - a.lastSeenAt);
  entry.aliases = aliases.slice(0, ALIAS_MAX_PER_USER);
  entry.updatedAt = now;
  data[guildId][userId] = entry;
  save();
  return true;
}

function isAliasConfirmed(a, now = Date.now()) {
  if (!a || isItemStale(a, now)) return false;
  return new Set((a.evidence || []).map((e) => e.messageId)).size >= ALIAS_CONFIRM_MIN_MESSAGES;
}

// Confirmed aliases, most-used first.
function confirmedAliases(entry, now = Date.now(), max = ALIAS_PROMPT_MAX) {
  return (entry?.aliases || [])
    .filter((a) => isAliasConfirmed(a, now) && !isAliasDenied(entry, a.alias))
    .sort((a, b) => b.evidence.length - a.evidence.length)
    .slice(0, max)
    .map((a) => a.alias);
}

const PROFILE_PROMPT_MAX_LEN = 300;

function buildItemsLines(items) {
  const now = Date.now();
  const lines = [];
  for (const f of PROFILE_FIELDS) {
    const live = liveItems(items, f, now);
    if (live.length === 0) continue;
    lines.push(`- ${f.label}：`);
    for (const it of live) lines.push(`  - ${itemLabel(it)}`);
  }
  return lines;
}

function buildUserProfileBlock(entry) {
  const itemLines = entry?.items ? buildItemsLines(entry.items) : [];
  const hasLegacy = !entry?.items && entry?.profile;
  const aliases = confirmedAliases(entry);
  const denied = deniedAliases(entry);
  if (
    itemLines.length === 0 && !hasLegacy && !entry?.observations?.length &&
    aliases.length === 0 && denied.length === 0
  ) return "";
  const name = entry.name || "未知";
  const lines = [
    "\n\n## 當前使用者長期記憶",
    "這是你對目前說話者的長期印象，只能當成輕量參考，不要直接複述，也不要假裝百分之百確定。",
    `- 暱稱：${name}`,
  ];
  if (aliases.length > 0) lines.push(`- 群友常叫他：${aliases.join("、")}`);
  if (denied.length > 0) lines.push(`- 他親口說過不要這樣叫他（別用）：${denied.join("、")}`);

  if (itemLines.length > 0) {
    lines.push(...itemLines);
  } else if (hasLegacy) {
    // Prompt block stays one bullet per item — flatten the field-per-line
    // profile into a single line for injection.
    const flat = entry.profile.replace(/\n+/g, "；");
    lines.push(`- 摘要：${flat.slice(0, PROFILE_PROMPT_MAX_LEN)}`);
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

function deleteUserProfile(guildId, userId) {
  if (!guildId || !userId) return false;
  const data = load();
  if (!data[guildId]?.[userId]) return false;
  delete data[guildId][userId];
  if (Object.keys(data[guildId]).length === 0) delete data[guildId];
  save();
  return true;
}

function listUserProfiles(guildId) {
  if (!guildId) return [];
  const data = load();
  const entries = data[guildId] || {};
  return Object.entries(entries).map(([userId, entry]) => ({
    userId,
    ...entry,
  }));
}

// Users whose pending backlog reached minCount, across all guilds — feed for
// the scheduled backlog sweep, so passively-scooped users don't wait forever
// for their own next @mention to trigger extraction.
function listPendingBacklog(minCount = 1) {
  const data = load();
  const out = [];
  for (const [guildId, users] of Object.entries(data)) {
    for (const [userId, entry] of Object.entries(users)) {
      const pending = entry?.pendingInteractions ?? [];
      if (pending.length < minCount) continue;
      out.push({
        guildId,
        userId,
        name: entry.name || null,
        pendingCount: pending.length,
        lastPendingAt: pending[pending.length - 1]?.at ?? 0,
        lastExtractedAt: entry.lastExtractedAt ?? 0,
      });
    }
  }
  return out;
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
  PROFILE_MAX_LEN,
  PROFILE_PROMPT_MAX_LEN,
  PENDING_TEXT_MAX_LEN,
  PENDING_MAX_COUNT,
  EVIDENCE_MAX_PER_OBSERVATION,
  RECENT_OBSERVATIONS_PROMPT_COUNT,
  PROFILE_FIELDS,
  ITEM_TEXT_MAX_LEN,
  ITEM_STALE_MS,
  PROFILE_HISTORY_MAX,
  OBSERVATION_MAX_CARRY,
  DETAIL_MAX,
  DETAIL_STALE_MS,
  textTokens,
  tokenSimilarity,
  upsertDetails,
  detailsOf,
  isDetailStale,
  STABLE_MIN_DISTINCT_MESSAGES,
  STABLE_TIME_GAP_MS,
  isStableEvidence,
  isItemStale,
  mergeEvidenceNewest,
  fieldByKeyOrLabel,
  sanitizeItems,
  capByPriority,
  carryObservations,
  freshObservations,
  renderProfileText,
  profileTextOf,
  setProfileItems,
  getUserProfile,
  ALIAS_MAX_LEN,
  ALIAS_MAX_PER_USER,
  ALIAS_CONFIRM_MIN_MESSAGES,
  sanitizeAlias,
  recordAliasEvidence,
  isAliasConfirmed,
  isAliasDenied,
  denyAlias,
  allowAlias,
  deniedAliases,
  confirmedAliases,
  listPendingBacklog,
  appendPendingInteraction,
  getPendingInteractions,
  clearPending,
  appendObservations,
  setConsolidatedProfile,
  deleteUserProfile,
  listUserProfiles,
  buildUserProfileBlock,
  flush,
  resetCacheForTests,
};
