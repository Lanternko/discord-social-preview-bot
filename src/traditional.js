// Last-pass 簡→繁 for 西寶's 繁體 replies.
//
// Every model in the chain leaks a Simplified character now and then (GLM
// 「认真」, Luna 「国」, deepseek-flash whole sentences): ~2–4% of 5,551 logged
// replies, 2026-11-09. Prompting only lowers the rate, and a resend costs a
// call and can leak again — but which characters are Simplified is a lookup,
// so the fix is a lookup too.
//
// Per character on purpose: the map (scripts/build-s2t-map.js) only holds
// characters with one safe 繁體 form, so no word context is needed and a text
// that is already 繁體 comes through byte-identical. Ambiguous ones (发 發/髮,
// 后, 干, 台, 里) are left alone rather than guessed.
const S2T = require("./s2t-map.json");

// Spans that must not change: custom emoji (`<:name:id>`, `:name:`), sticker
// markers, URLs and inline code. Names the caller passes (群友暱稱 can be
// Simplified on purpose) are protected the same way.
const EMOJI_NAME = String.raw`[\w\u4e00-\u9fff]+`;
const FIXED_SPANS = String.raw`<a?:${EMOJI_NAME}:\d+>|:${EMOJI_NAME}:|\[貼圖:[^\]]*\]|https?:\/\/\S+|` + "`[^`]*`";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildSkipPattern(protect) {
  const names = [...new Set(protect.filter((n) => typeof n === "string" && n))]
    .filter((n) => [...n].some((c) => S2T[c]))
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  return new RegExp(names.length ? `${FIXED_SPANS}|${names.join("|")}` : FIXED_SPANS, "g");
}

function convertPlain(text, changed) {
  let out = "";
  for (const ch of text) {
    const t = S2T[ch];
    if (t) {
      changed.push(ch);
      out += t;
    } else {
      out += ch;
    }
  }
  return out;
}

// Returns { text, changed } — `changed` lists the Simplified characters that
// were rewritten, in order, for the log line.
function toTraditional(text, { protect = [] } = {}) {
  if (typeof text !== "string" || !text) return { text, changed: [] };
  const changed = [];
  const skip = buildSkipPattern(protect);
  let out = "";
  let last = 0;
  for (const m of text.matchAll(skip)) {
    out += convertPlain(text.slice(last, m.index), changed);
    out += m[0];
    last = m.index + m[0].length;
  }
  out += convertPlain(text.slice(last), changed);
  return { text: out, changed };
}

// Applies the pass only to guilds that reply in 繁體中文 and logs what it fixed.
// zh-CN / ja / en replies are returned untouched — Japanese shares 国/学/会.
function enforceTraditional(text, { language, protect, label } = {}) {
  if (language && language !== "zh-TW") return text;
  const { text: out, changed } = toTraditional(text, { protect });
  if (changed.length) {
    console.log(`[s2t] converted ${changed.length} char(s) label=${label || "?"} chars=${changed.join("")}`);
  }
  return out;
}

module.exports = { toTraditional, enforceTraditional };
