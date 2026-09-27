// Repairs member names the model spelled back with kana spliced in.
//
// deepseek-v4-pro once wrote `linchien` as `lインchien` nine times in one
// bedtime story (2026-09-26): the "in" came out as katakana イン. The ingredient
// list had the name right; the corruption is in decoding, so no prompt rule
// fixes it. We know the real names, so we put them back.
//
// A corrupted token is Latin/digits with a kana run in the middle or at an
// edge. It is replaced only when exactly ONE known name keeps the token's
// Latin head and tail with a plausible length — Chinese prose never puts
// kana next to Latin letters, and an ambiguous match is left alone.

const KANA = "\\u3040-\\u30ff\\u31f0-\\u31ff\\uff66-\\uff9f";
const LATIN = "A-Za-z0-9_.\\-";
const MIXED_TOKEN_RE = new RegExp(
  `[${LATIN}]*[${KANA}]+[${LATIN}${KANA}]*`,
  "g",
);
const HAS_LATIN_RE = /[A-Za-z0-9]/;
const HAS_KANA_RE = new RegExp(`[${KANA}]`);
// A kana char stands in for 1–3 Latin letters (イン = "in", ン = "n").
const MAX_LATIN_PER_KANA = 3;

function splitEdges(token) {
  const head = token.match(new RegExp(`^[${LATIN}]*`))[0];
  const tail = token.match(new RegExp(`[${LATIN}]*$`))[0];
  const kanaCount = [...token].length - head.length - tail.length;
  return { head, tail, kanaCount };
}

function candidateFor(token, names) {
  const { head, tail, kanaCount } = splitEdges(token);
  if (!head && !tail) return null;
  const lower = token.toLowerCase();
  const matches = names.filter((name) => {
    const n = name.toLowerCase();
    if (n === lower || HAS_KANA_RE.test(n)) return false;
    if (!n.startsWith(head.toLowerCase()) || !n.endsWith(tail.toLowerCase())) {
      return false;
    }
    const replaced = n.length - head.length - tail.length;
    return replaced >= 1 && replaced <= kanaCount * MAX_LATIN_PER_KANA;
  });
  return matches.length === 1 ? matches[0] : null;
}

function repairNames(text, names = []) {
  if (!text || typeof text !== "string") return text;
  const known = [...new Set(names.filter((n) => n && HAS_LATIN_RE.test(n)))];
  if (known.length === 0 || !HAS_KANA_RE.test(text)) return text;

  const fixed = new Map();
  const out = text.replace(MIXED_TOKEN_RE, (token) => {
    if (!HAS_LATIN_RE.test(token)) return token; // pure kana: real Japanese
    const name = candidateFor(token, known);
    if (!name) return token;
    fixed.set(token, name);
    return name;
  });
  for (const [from, to] of fixed) {
    console.log(`[name-repair] ${from} -> ${to}`);
  }
  return out;
}

module.exports = { repairNames };
