// Explicit self-statements about one's own 綽號, said to 西寶 directly:
// 「別叫我小峰」「我不叫峰哥」「小峰不是我的綽號」 → deny; 「叫我小峰就好」
// 「可以叫我小峰」 → lift an earlier denial. Only the author speaks for
// themselves — nobody can deny or allow someone else's alias.
//
// Regex, not an LLM call: the patterns are narrow, it runs on every @西寶
// message, and it has to land BEFORE the reply is built so the same reply
// already respects it. A miss is harmless (group evidence still needs 2+
// messages); a false hit only suppresses one alias, so the patterns stay strict.

const { sanitizeAlias, denyAlias, allowAlias } = require("../user-profile-store");

// Captured alias: 1-12 chars, no spaces / punctuation that would end the clause.
const NAME = "([^\\s，。！？!?,.、~～「」『』\"'（）()]{1,12}?)";
const TAIL = "(?:了|啦|喔|哦|啊|吧|好嗎|好不好|拜託|謝謝)?(?=$|[\\s，。！？!?,.、~～]|$)";
const QUOTED = "[「『\"']?";
const QUOTED_END = "[」』\"']?";

const DENY_PATTERNS = [
  // 別/不要/不准/少/不許/請不要 叫我X
  new RegExp(`(?:別|不要|不准|不許|少|請不要|請別|拜託不要|不用)再?叫我${QUOTED}${NAME}${QUOTED_END}${TAIL}`),
  // 我不叫X / 我才不叫X
  new RegExp(`我(?:才|又|並|根本)?不叫${QUOTED}${NAME}${QUOTED_END}${TAIL}`),
  // 我的綽號/暱稱/外號不是X
  new RegExp(`我的?(?:綽號|暱稱|外號|小名)(?:才|並|根本)?不是${QUOTED}${NAME}${QUOTED_END}${TAIL}`),
  // X不是我的綽號 / X才不是我的暱稱
  new RegExp(`${QUOTED}${NAME}${QUOTED_END}(?:才|並|根本)?不是我的?(?:綽號|暱稱|外號|小名|名字)`),
];

const ALLOW_PATTERNS = [
  // 叫我X就好 / 可以叫我X / 你可以叫我X
  new RegExp(`(?:可以|直接|就)叫我${QUOTED}${NAME}${QUOTED_END}${TAIL}`),
  new RegExp(`叫我${QUOTED}${NAME}${QUOTED_END}就(?:好|行|可以)`),
];

// Words a capture must never be — they mean the regex grabbed grammar, not a name.
const NOT_A_NAME = new Set(["你", "妳", "他", "她", "我", "這個", "那個", "這樣", "那樣", "什麼", "啥", "名字", "全名"]);
// 「別叫我去上班」 is an errand, not a name: a capture opening with a verb /
// pronoun / preposition is a clause, and one ending in a question particle
// is a question.
const CLAUSE_START_RE = /^(?:去|來|做|幫|買|吃|喝|寫|看|打|上|下|出|進|回|起|跟|給|把|被|在|用|等|拿|找|起床|睡|你|妳|他|她|它|我)/;
const QUESTION_END_RE = /[嗎呢吗么麼]$/;

function firstMatch(patterns, text) {
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const alias = sanitizeAlias(m[1]);
    if (!alias || NOT_A_NAME.has(alias)) continue;
    if (CLAUSE_START_RE.test(alias) || QUESTION_END_RE.test(alias)) continue;
    return alias;
  }
  return null;
}

// text = the user's message with the 西寶 mention already stripped.
// Returns { deny: [aliases], allow: [aliases] } — deny wins if both hit the
// same clause (「別叫我X，叫我Y就好」 is handled clause by clause).
function detectAliasStatements(text) {
  const out = { deny: [], allow: [] };
  if (typeof text !== "string" || !text) return out;
  const clauses = text.normalize("NFC").split(/[，,。！？!?；;\n]+/).map((c) => c.trim()).filter(Boolean);
  for (const clause of clauses) {
    const denied = firstMatch(DENY_PATTERNS, clause);
    if (denied) {
      if (!out.deny.includes(denied)) out.deny.push(denied);
      continue;
    }
    const allowed = firstMatch(ALLOW_PATTERNS, clause);
    if (allowed && !out.allow.includes(allowed)) out.allow.push(allowed);
  }
  return out;
}

// Writes what the author just said about their own name. Runs before the
// reply is assembled so the profile block of THIS reply already carries it.
function applyAliasStatements(guildId, userId, displayName, text, meta = {}) {
  if (!guildId || !userId) return { deny: [], allow: [] };
  const found = detectAliasStatements(text);
  const deny = found.deny.filter((a) => denyAlias(guildId, userId, displayName, a, meta));
  const allow = found.allow.filter((a) => allowAlias(guildId, userId, a));
  if (deny.length || allow.length) {
    console.log(
      `[alias] statement guild=${guildId} user=${userId}${deny.length ? ` deny=${deny.join(",")}` : ""}${allow.length ? ` allow=${allow.join(",")}` : ""}`,
    );
  }
  return { deny, allow };
}

module.exports = { detectAliasStatements, applyAliasStatements };
