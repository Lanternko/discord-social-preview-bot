// Learns what group members call each other (綽號) from group chat, so 西寶
// knows 「峰哥」 is 峰【…】 without anyone telling her. Display names are a
// poor proxy — they carry jokes and decorations, and the name friends actually
// use often isn't in them at all.
//
// Source = the group-context rows chain.js already fetched for a reply (no
// extra Discord fetch). Rows accumulate in a per-guild in-memory buffer; once
// ALIAS_EXTRACT_MIN_NEW unseen messages pile up, one LLM call reads the
// buffer and proposes { person, alias, evidence }. The model only proposes —
// resolveAliasCandidates keeps an alias only when a DIFFERENT person's message
// literally contains it, and user-profile-store confirms it only after it shows
// up in ≥2 distinct messages. Buffer is in-memory: a restart just delays the
// next batch; confirmed aliases persist in user-profiles.json.

const { getUserProfile, recordAliasEvidence, sanitizeAlias } = require("../user-profile-store");
const { sanitizeName } = require("../utils");

const ALIAS_BUFFER_MAX = 80;
const ALIAS_EXTRACT_MIN_NEW = 30;
const ALIAS_LINE_MAX_LEN = 200;
const ALIAS_EXTRACT_MAX_TOKENS = 1200;
const ALIAS_MAX_PER_BATCH = 10;

// Words that address someone but aren't a name for any one person. Kinship
// terms matter most: 「姐姐」 said five times to one person passes the
// evidence bar easily, yet it's a relation, not a 綽號 (real-chat probe,
// 2026-09-27).
const ALIAS_STOPWORDS = new Set([
  "你", "妳", "您", "他", "她", "它", "我", "你們", "妳們", "他們", "她們", "大家", "各位",
  "兄弟", "姊妹", "姐妹", "朋友", "老師", "老大", "大佬", "前輩",
  "哥", "姐", "姊", "弟", "妹", "哥哥", "姐姐", "姊姊", "弟弟", "妹妹", "大哥", "大姐", "大姊",
  "小弟", "小妹", "學長", "學姐", "學姊", "學弟", "學妹", "爸爸", "媽媽", "爸", "媽", "主人",
  "寶", "寶寶", "寶貝", "寶子", "親", "親親", "親愛的", "老公", "老婆", "笨蛋", "白癡",
  "西寶", "bot", "機器人",
]);

// Who a line is explicitly aimed at: its reply target plus any <@id> tags.
function addresseesOf(row) {
  const ids = new Set();
  if (row.replyToUserId) ids.add(row.replyToUserId);
  for (const m of row.content.matchAll(/<@!?(\d+)>/g)) ids.add(m[1]);
  return ids;
}

const ALIAS_PERSONA = `你是一個群組稱呼紀錄助手。你的工作是從群聊紀錄中找出**群友之間用來稱呼某個特定群友的綽號**。

## 資料格式
- 「參與者」列出 P編號＝該人的 Discord 顯示名稱。
- 對話逐行編號 L編號，格式「L3 P2（回覆 P1）: 內容」。「回覆 P1」表示這則是回覆 P1 的訊息；內容裡的 @P1 表示 tag 了 P1。

## 規則
- 只收**某人明確拿來稱呼另一個特定群友**的詞：叫他、回覆他、tag 他時用的名字（例：「峰哥你又來了」回覆 P1 → P1 的綽號是「峰哥」）。
- 綽號必須**原字出現**在你引用的那幾行內容裡，而且說話的人不是被稱呼的本人。
- **不收**：代名詞（你、他）、泛稱（大家、兄弟、老師）、一時的罵人或形容詞、在講第三方（明星、角色）的名字、只是把顯示名稱原文照抄一遍。
- **西寶是 bot，不在參與者名單裡**：群友叫「西寶」「西寶寶」「小西寶」這類稱呼都是在叫 bot，不是在叫任何 P，一律不收。
- 打招呼、點名時要看清楚是對誰：優先看「回覆 P?」與 @P?；都沒有時，要從上下文能明確看出在叫誰才收。
- 沒把握是在叫誰就不要收。沒有就回 {"aliases":[]}。

## 輸出（只輸出 JSON）
{"aliases":[{"person":"P1","alias":"峰哥","evidence":["L3","L7"]}]}`;

const buffers = new Map(); // guildId -> { lines: Map<messageId, row>, newCount }
const inFlight = new Set();

function bufferFor(guildId) {
  if (!buffers.has(guildId)) buffers.set(guildId, { lines: new Map(), newCount: 0 });
  return buffers.get(guildId);
}

// entries = fetchGroupContext rows. Only real people's own text is kept —
// link previews and empty (sticker/attachment-only) messages can't carry an
// alias. Dedup by messageId: the same row re-fetched by the next reply isn't new.
function recordAliasContext(guildId, entries) {
  if (!guildId || !Array.isArray(entries)) return 0;
  const buf = bufferFor(guildId);
  let added = 0;
  for (const e of entries) {
    const content = typeof e?.content === "string" ? e.content.trim() : "";
    if (!e?.userId || !e.messageId || e.isLinkPreview || !content) continue;
    if (buf.lines.has(e.messageId)) continue;
    buf.lines.set(e.messageId, {
      messageId: e.messageId,
      speakerId: e.userId,
      speakerName: e.displayName || null,
      content: content.normalize("NFC").slice(0, ALIAS_LINE_MAX_LEN),
      at: typeof e.at === "number" ? e.at : Date.now(),
      replyToUserId: e.replyToUserId || null,
    });
    added++;
  }
  buf.newCount += added;
  if (buf.lines.size > ALIAS_BUFFER_MAX) {
    const oldest = [...buf.lines.values()].sort((a, b) => a.at - b.at);
    for (const row of oldest.slice(0, buf.lines.size - ALIAS_BUFFER_MAX)) {
      buf.lines.delete(row.messageId);
    }
  }
  return added;
}

// Numbered roster + lines. People who were only replied to (never spoke in the
// window) still get a P id when their name is known from the profile store.
function buildAliasPrompt(guildId, rows) {
  const people = new Map(); // userId -> { pid, name }
  const add = (userId, name) => {
    if (!userId || people.has(userId)) return;
    const known = name || getUserProfile(guildId, userId)?.name;
    if (!known) return;
    people.set(userId, { pid: `P${people.size + 1}`, name: sanitizeName(known) });
  };
  for (const r of rows) add(r.speakerId, r.speakerName);
  for (const r of rows) add(r.replyToUserId, null);

  const pidOf = (userId) => people.get(userId)?.pid || null;
  const lines = rows.map((r, i) => {
    const text = r.content.replace(/<@!?(\d+)>/g, (_, id) => `@${pidOf(id) || "某人"}`);
    const reply = pidOf(r.replyToUserId) ? `（回覆 ${pidOf(r.replyToUserId)}）` : "";
    return `L${i + 1} ${pidOf(r.speakerId)}${reply}: ${text}`;
  });
  const roster = [...people.values()].map((p) => `${p.pid}＝${p.name}`);
  const turns = [
    {
      role: "user",
      content: `## 參與者\n${roster.join("\n")}\n\n## 對話\n${lines.join("\n")}`,
    },
  ];
  return { turns, people, rows };
}

function parseAliasResult(text) {
  if (!text) return null;
  const cleaned = text.replace(/^[^{]*/, "").replace(/[^}]*$/, "");
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed?.aliases) ? parsed.aliases : null;
  } catch {
    console.warn(`[alias] failed to parse LLM output len=${text.length}`);
    return null;
  }
}

function lineIndexOf(ref) {
  const m = String(ref ?? "").trim().match(/^L?(\d+)$/i);
  return m ? Number(m[1]) - 1 : -1;
}

// The code-side gate. The model's proposal survives only if: the person is on
// the roster, the alias is a real name (not a stopword / not someone else's
// display name / not just the display name verbatim), and at least one cited
// line was said by SOMEONE ELSE, literally contains the alias, and — if it
// replies to or tags anyone — is aimed at the target.
function resolveAliasCandidates(proposals, { people, rows }) {
  if (!Array.isArray(proposals)) return [];
  const byPid = new Map([...people].map(([userId, p]) => [p.pid, { userId, name: p.name }]));
  const nameKeys = new Map([...people].map(([userId, p]) => [p.name.normalize("NFC").toLowerCase(), userId]));
  const out = [];
  for (const prop of proposals.slice(0, ALIAS_MAX_PER_BATCH)) {
    const target = byPid.get(String(prop?.person ?? "").trim().toUpperCase());
    const alias = sanitizeAlias(prop?.alias);
    if (!target || !alias) continue;
    const key = alias.toLowerCase();
    if (ALIAS_STOPWORDS.has(key) || key.includes("西寶")) continue;
    if (nameKeys.has(key)) continue; // someone's display name verbatim
    const refs = Array.isArray(prop.evidence) ? prop.evidence : [prop.evidence];
    const evidence = [];
    for (const ref of refs) {
      const row = rows[lineIndexOf(ref)];
      if (!row || row.speakerId === target.userId) continue;
      // A line that replies to / tags someone ELSE isn't calling the target.
      const addressees = addresseesOf(row);
      if (addressees.size > 0 && !addressees.has(target.userId)) continue;
      if (!row.content.toLowerCase().includes(key)) continue;
      evidence.push({ messageId: row.messageId, at: row.at, speakerId: row.speakerId });
    }
    if (evidence.length === 0) continue;
    out.push({ userId: target.userId, displayName: target.name, alias, evidence });
  }
  return out;
}

async function maybeExtractAliases(guildId, runChain) {
  if (!guildId || !runChain || inFlight.has(guildId)) return;
  const buf = buffers.get(guildId);
  if (!buf || buf.newCount < ALIAS_EXTRACT_MIN_NEW) return;
  inFlight.add(guildId);
  // Reset before the call: a failed batch waits for the next 30 new lines
  // instead of retrying on every reply.
  buf.newCount = 0;
  try {
    const rows = [...buf.lines.values()].sort((a, b) => a.at - b.at);
    const ctx = buildAliasPrompt(guildId, rows);
    const result = await runChain(ctx.turns, ALIAS_PERSONA, ALIAS_EXTRACT_MAX_TOKENS);
    if (!result) return;
    const proposals = parseAliasResult(result.text);
    const accepted = resolveAliasCandidates(proposals, ctx);
    for (const a of accepted) {
      recordAliasEvidence(guildId, a.userId, a.displayName, a.alias, a.evidence);
    }
    console.log(
      `[alias] guild=${guildId} lines=${rows.length} proposed=${proposals?.length ?? 0} accepted=${accepted.length}${accepted.length ? ` (${accepted.map((a) => `${a.displayName}=${a.alias}`).join(", ")})` : ""} provider=${result.provider?.label}`,
    );
  } catch (err) {
    console.warn(`[alias] extraction failed: ${err.message}`);
  } finally {
    inFlight.delete(guildId);
  }
}

function resetAliasBuffersForTests() {
  buffers.clear();
  inFlight.clear();
}

module.exports = {
  ALIAS_BUFFER_MAX,
  ALIAS_EXTRACT_MIN_NEW,
  ALIAS_PERSONA,
  recordAliasContext,
  buildAliasPrompt,
  parseAliasResult,
  resolveAliasCandidates,
  maybeExtractAliases,
  resetAliasBuffersForTests,
};
