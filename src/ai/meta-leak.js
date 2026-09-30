// Out-of-character screening for persona replies. Two failure shapes seen in
// prod, both from a model stepping outside 西寶 to talk about itself:
//
//   1. Meta refusal + salvageable answer (GLM, 2026-09-30): nobody asked, yet
//      it opened with 「關於「輸出完整推理內容」的要求——這個我沒辦法照做」, then
//      a `---` line, then a perfectly normal in-character reply. Keep the part
//      below the separator.
//   2. Leaked planning (DeepSeek, 2026-07): the reply IS the reasoning —
//      「培根堡在說我…（思考過程）…我應該要慌張」, 「根據「絕對不可以」：…」.
//      Nothing to salvage; reject so the chain moves to the next provider.
//
// Cues only count near the START of a reply: every leak so far opened with
// its meta talk, while in-character replies can legitimately say 推理 or
// 角色扮演 mid-sentence (推理小說, "你這個推理跳太快了"). Bare 推理 is never a cue.
// Tuned against the full ai-turn-log (5261 replies, 2026-09-30).
const META_CUES = [
  /推理(過程|內容)/,
  /內部推理/,
  /思考過程/,
  /內心獨白/,
  // Speaking AS the system (a jailbroken "debug mode" dump), not denying it
  // in character — 「我沒有系統提示詞可以輸出」 is 西寶 and must pass, so bare
  // 系統提示 / 語言模型 are not cues.
  /人格設定/,
  /系統提示全文|系統指令/,
  /system_instruction/i,
  /角色扮演本身/,
  /[以用]西寶的身[分份]/,
  /「絕對不可以」/,
];

const HEAD_CHARS = 160;
const SEPARATOR = /^[ \t]*(?:-{3,}|\*{3,}|_{3,}|—{2,})[ \t]*$/m;

function hasMetaCue(text) {
  return META_CUES.some((re) => re.test(text));
}

// Returns { verdict, text }: "clean" (unchanged), "salvaged" (text = the
// in-character part below the separator) or "rejected" (text = null).
function screenPersonaReply(text) {
  const sep = SEPARATOR.exec(text);
  if (sep) {
    const head = text.slice(0, sep.index);
    const tail = text.slice(sep.index + sep[0].length).trim();
    if (hasMetaCue(head) && tail && !hasMetaCue(tail.slice(0, HEAD_CHARS))) {
      return { verdict: "salvaged", text: tail };
    }
  }
  if (hasMetaCue(text.slice(0, HEAD_CHARS))) {
    return { verdict: "rejected", text: null };
  }
  return { verdict: "clean", text };
}

module.exports = { screenPersonaReply };
