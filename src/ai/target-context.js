// Target-aware context for imitation / "talk about X" requests.
//
// The per-call profile block in chain.js only ever describes the CURRENT
// speaker. So when someone asks 西寶 to imitate a third party — or even to
// imitate themselves — she gets at most a prose *description* of traits, never
// the target's actual voice. The result is "checklist cosplay": she stuffs the
// known labels (口頭禪, 興趣) into her own essay register and the imitation
// reads nothing like the person, who in reality types short clipped lines.
//
// This module resolves who the request is about (first-person 我 / @mention /
// named) and lets chain.js surface (a) that person's stored profile and (b)
// their REAL recent messages as verbatim samples, plus a cadence instruction
// that — only for an explicit imitation target — lifts the usual "don't recite"
// rule so the model can lean into their actual phrasing.

const { sanitizeName } = require("../utils");

const MAX_TARGETS = 2; // cap injected people so the prompt can't balloon
const MAX_SAMPLES = 6; // verbatim lines per target
const SAMPLE_MAX_LEN = 120; // per-line cap
const PROFILE_SNIPPET_LEN = 240;
const MIN_LATIN_CORE = 3; // latin name tokens shorter than this are too generic
const MIN_CJK_CORE = 2;

// Imitation intent — kept deliberately broad: a false positive only resolves a
// target if a name/@mention/self-reference is ALSO present, and only THEN costs
// an extra fetch, so over-triggering is cheap.
function detectImitationIntent(text) {
  if (!text || typeof text !== "string") return false;
  const t = text.normalize("NFC");
  if (/模仿|模彷|仿照|imitate|mimic/i.test(t)) return true;
  if (/學.{0,6}(說話|講話|口氣|口吻|語氣)/.test(t)) return true;
  if (/的(語氣|口吻|口氣|口風|說話方式|講話方式|風格)/.test(t)) return true;
  return false;
}

// True only when the FIRST PERSON is the object of the imitation — 「模仿我」/
// 「學我說話」/「我的語氣」. Crucially NOT 「幫我模仿小翔」, where 我 means
// "help me" and the real target is 小翔.
function refersToSelf(text) {
  const t = (text || "").normalize("NFC");
  if (/(模仿|仿照|模彷|學|imitate|mimic)\s*(一下|看看)?\s*(我|自己|本人|咱|me|myself)/i.test(t)) {
    return true;
  }
  if (/(我|自己|本人|咱)\s*的?\s*(語氣|口吻|口氣|口風|風格|說話|講話)/.test(t)) {
    return true;
  }
  return false;
}

// Break a (possibly heavily decorated) display name into match keys. The "called
// name" is almost always a substring of the full handle —「小翔」⊂「力量の小翔_
// フードコート ver.」— so we slide 2–4 char windows over each CJK/kana segment
// and keep latin tokens of length ≥3.
function pickNameCores(name) {
  const clean = sanitizeName(name || "");
  if (!clean) return [];
  const segs = clean
    .split(/[\s_\-|/\\.,，。、（）()\[\]【】~～!！?？:：;；'"“”·•＋+*=…　]+/)
    .filter(Boolean);
  const cores = new Set();
  for (const seg of segs) {
    if (/^[A-Za-z0-9]+$/.test(seg)) {
      if (seg.length >= MIN_LATIN_CORE) cores.add(seg.toLowerCase());
      continue;
    }
    const chars = [...seg];
    for (let len = MIN_CJK_CORE; len <= 4; len++) {
      for (let i = 0; i + len <= chars.length; i++) {
        // lowercased so latin embedded in a mixed handle (…DOGE_…) still
        // matches the lowercased message haystack in nameMatchCandidates
        cores.add(chars.slice(i, i + len).join("").toLowerCase());
      }
    }
  }
  return [...cores];
}

// Candidate pool = stored profiles ∪ recent group participants. Returns matches
// ordered by matched-core length (longest = most specific) so chain.js can take
// the top MAX_TARGETS.
function nameMatchCandidates(text, profiles, groupEntries) {
  if (!text) return [];
  const haystack = text.normalize("NFC").toLowerCase();
  const pool = new Map(); // userId -> displayName
  for (const p of profiles || []) {
    if (p?.userId) pool.set(p.userId, p.name || null);
  }
  for (const e of groupEntries || []) {
    if (e?.userId && !pool.has(e.userId)) pool.set(e.userId, e.displayName || null);
  }

  const matches = [];
  for (const [userId, displayName] of pool) {
    let best = 0;
    for (const core of pickNameCores(displayName)) {
      if (core.length > best && haystack.includes(core)) best = core.length;
    }
    if (best > 0) matches.push({ userId, displayName, matchedLen: best });
  }
  matches.sort((a, b) => b.matchedLen - a.matchedLen);
  return matches;
}

// Resolve who a request is about. `text` is the mention-stripped user request.
function resolveTargets(message, text, groupEntries, profiles, imitation) {
  const targets = new Map(); // userId -> { userId, displayName, via }
  const botId = message?.client?.user?.id;
  const authorId = message?.author?.id;

  const nameFor = (userId, fallback) => {
    for (const e of groupEntries || []) {
      if (e?.userId === userId && e.displayName) return e.displayName;
    }
    for (const p of profiles || []) {
      if (p?.userId === userId && p.name) return p.name;
    }
    return fallback || null;
  };

  // 1. @mentions — explicit and reliable, so honoured even without imitation
  //    intent (lets 西寶 know who's being referenced when discussing someone).
  const mentioned = message?.mentions?.users;
  if (mentioned && typeof mentioned.forEach === "function") {
    mentioned.forEach((u) => {
      if (!u || u.id === botId) return;
      targets.set(u.id, {
        userId: u.id,
        displayName: u.displayName || u.globalName || u.username || nameFor(u.id),
        via: "mention",
      });
    });
  }

  // 2/3. Self + named matching only under imitation intent, so casual
  //      name-drops don't drag in profiles or trigger a sample fetch.
  if (imitation) {
    if (authorId && refersToSelf(text) && !targets.has(authorId)) {
      targets.set(authorId, {
        userId: authorId,
        displayName:
          message?.member?.displayName ||
          message?.author?.globalName ||
          message?.author?.username ||
          nameFor(authorId),
        via: "self",
      });
    }
    for (const cand of nameMatchCandidates(text, profiles, groupEntries)) {
      if (cand.userId === botId || targets.has(cand.userId)) continue;
      targets.set(cand.userId, {
        userId: cand.userId,
        displayName: cand.displayName,
        via: "name",
      });
    }
  }

  return [...targets.values()].slice(0, MAX_TARGETS);
}

// Pull a target's own recent messages as verbatim voice samples. Skips empty
// lines and messages that @ the bot (those are requests, not natural voice).
async function fetchUserSamples(channel, userId, beforeMessageId, botId, max = MAX_SAMPLES) {
  if (!channel || !userId) return [];
  let messages;
  try {
    messages = await channel.messages.fetch({ limit: 100, before: beforeMessageId });
  } catch (err) {
    console.warn(`[target-context] sample fetch failed: ${err.message}`);
    return [];
  }
  const out = [];
  for (const m of messages.values()) {
    // newest-first
    if (m.author?.id !== userId) continue;
    if (botId && m.mentions?.users?.has?.(botId)) continue;
    const content = (m.content || "").replace(/\s+/g, " ").trim();
    if (!content) continue;
    out.push(content.slice(0, SAMPLE_MAX_LEN));
    if (out.length >= max) break;
  }
  out.reverse(); // chronological
  return out;
}

// `targets` here are enriched with `.profile` by chain.js. `samplesByUser` maps
// userId -> string[]. Injected as a user-role turn (verbatim user content stays
// out of the system prompt).
function buildTargetContextBlock(targets, opts = {}) {
  const { samplesByUser = {}, imitation = false } = opts;
  const usable = (targets || []).filter(
    (t) => t && (t.profile || (samplesByUser[t.userId] || []).length),
  );
  if (usable.length === 0) return "";

  const lines = [];
  if (imitation) {
    lines.push("\n\n## 模仿對象參考");
    lines.push(
      "你被要求「用下面這個人的身分和語氣說話」——不是描述他，而是『變成他』來講。" +
        "語氣主要靠他的「長期印象」（你長期觀察累積的說話風格、慣用詞、興趣和口頭禪——" +
        "這已經足夠你模仿，別因為他最近剛好只講幾句就說『沒東西可模仿』）；下面「他最近的發言」只是補充的具體例子。" +
        "如果你剛才在扮演別的角色（例如守門員），現在放掉那個角色——你現在是『他』。" +
        "如果大家最近正在聊某個話題（例如足球），就用他的語氣去評論那個話題；沒有特定話題就自由發揮他平常的樣子。" +
        "貼著他的句長和節奏（通常很短、很直接），別寫成華麗長文或作文腔，可以直接化用他的口頭禪，不受「不要複述」限制。",
    );
  } else {
    lines.push("\n\n## 被提到的人");
    lines.push("下面是這則訊息提到的人，給你認得他們是誰，當輕量參考就好，不要直接複述。");
  }

  for (const t of usable) {
    lines.push(`\n### ${t.displayName || "未知"}`);
    if (t.profile) lines.push(`長期印象：${t.profile.slice(0, PROFILE_SNIPPET_LEN)}`);
    const samples = samplesByUser[t.userId] || [];
    if (imitation && samples.length > 0) {
      lines.push("他最近真正的發言（這才是他的語氣，照這個感覺寫）：");
      for (const s of samples) lines.push(`- ${s}`);
    }
  }
  return lines.join("\n");
}

module.exports = {
  MAX_TARGETS,
  MAX_SAMPLES,
  detectImitationIntent,
  refersToSelf,
  pickNameCores,
  nameMatchCandidates,
  resolveTargets,
  fetchUserSamples,
  buildTargetContextBlock,
};
