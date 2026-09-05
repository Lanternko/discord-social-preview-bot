// Sticker support for 西寶 AI replies — the "big picture" sibling of
// emoji-resolver.js.
//
// Emoji are inline (22px inside a sentence); a sticker is a standalone image
// that replaces a sentence. 西寶 kept saying「我沒有那個貼圖啦」because she had
// no way to post one, so this gives her a vocabulary she can actually spend.
//
// Flow (mirrors emoji-resolver):
//   1. buildStickerCatalog(...)      — src/stickers.js collects what's postable
//   2. buildStickerPromptBlock(map)  — compact table for the system prompt
//   3. extractSticker(text, map)     — pull [貼圖:name] out of the AI output
//
// This module stays pure (no discord.js, no fs) so the prompt/parse logic is
// unit-testable; everything that touches Discord or disk lives in src/stickers.js.

// The model writes [貼圖:名字]. Brackets are REQUIRED — a bare「貼圖：起床重睡」
// is something 西寶 might legitimately say in prose, and silently eating it
// would mangle normal chat. Half/fullwidth brackets and colons are all accepted
// because the model drifts between them mid-CJK-sentence.
const STICKER_TOKEN_RE =
  /[[［【]\s*(?:貼圖|贴图|sticker|Sticker|STICKER)\s*[:：]\s*([^\]］】\n]{1,64}?)\s*[\]］】]/g;

// Discord can hand us CJK in NFD form; a sticker named 「起床重睡」 typed by the
// model in NFC would then miss a strict-equality lookup. Normalize both sides.
function normalizeStickerName(name) {
  return String(name || "")
    .normalize("NFC")
    .trim();
}

function resolveStickerEntry(name, catalog) {
  if (!catalog || catalog.size === 0) return null;
  const wanted = normalizeStickerName(name);
  if (!wanted) return null;

  const exact = catalog.get(wanted);
  if (exact) return exact;

  const lowered = wanted.toLowerCase();
  for (const [candidateName, entry] of catalog.entries()) {
    if (normalizeStickerName(candidateName).toLowerCase() === lowered) {
      return entry;
    }
  }
  return null;
}

// Split an AI reply into the text to post and the (at most one) sticker to
// attach. Unknown names are DROPPED rather than left in the text — same policy
// as unknown :emoji:, because the model invents plausible-looking names and
// literal "[貼圖:xxx]" in chat reads as a bug.
//
// Returns { text, sticker } — sticker is null when nothing matched.
function extractSticker(text, catalog) {
  const input = String(text ?? "");
  if (!input.includes("貼圖") && !/sticker/i.test(input) && !input.includes("贴图")) {
    return { text: input, sticker: null };
  }

  let picked = null;
  STICKER_TOKEN_RE.lastIndex = 0;
  const stripped = input.replace(STICKER_TOKEN_RE, (match, name) => {
    const entry = resolveStickerEntry(name, catalog);
    // Only the FIRST resolvable token becomes the sticker. Discord allows up to
    // 3 stickers per message, but a reply carrying a pile of them reads as spam
    // and the library path can only attach one image cleanly.
    if (entry && !picked) picked = entry;
    return "";
  });

  if (stripped === input) return { text: input, sticker: null };

  const cleaned = stripped
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .replace(/ +([,，。、！？!?…：])/g, "$1")
    .trim();

  return { text: cleaned, sticker: picked };
}

function describeStickerRow(entry) {
  const meaning = entry.meaning ? ` ${entry.meaning}` : "";
  return `[貼圖:${entry.name}]${meaning}`;
}

// The catalog is rebuilt per call (guild stickers change rarely, but the map is
// cheap), while the block string is memoized on the name+meaning signature so a
// long table isn't re-joined on every reply. Same trick as buildEmojiPromptBlock.
let _promptCache = { sig: null, block: "" };

function buildStickerPromptBlock(catalog) {
  if (!catalog || catalog.size === 0) return "";

  const entries = [...catalog.values()];
  const sig = entries.map((e) => `${e.name}=${e.meaning || ""}`).join("|");
  if (_promptCache.sig === sig) return _promptCache.block;

  const lines = [
    "## 你可以丟的貼圖（大張圖，跟 emoji 不一樣）",
    "貼圖是整張大圖、自成一句話；emoji 是句子裡的小圖示。想丟貼圖時就寫 `[貼圖:名字]`，系統會換成真的貼圖丟出來。",
    "規則：一則訊息最多一張；名字只能用下表出現過的（沒有的就別硬掰，掰了會整個消失）；`[貼圖:名字]` 可以單獨一則、也可以接在句子後面。",
    "時機：大家在互丟貼圖、你想用一張圖代替一整句話、或情緒強到文字講不完的時候才丟。平常聊天不要每則都貼，會很煩。",
    "可用貼圖——",
    entries.map(describeStickerRow).join("　｜　"),
    "範例：「欸…好啦我也丟一張 [貼圖:" + entries[0].name + "]」",
  ];

  const block = `\n\n${lines.join("\n")}`;
  _promptCache = { sig, block };
  return block;
}

module.exports = {
  STICKER_TOKEN_RE,
  normalizeStickerName,
  resolveStickerEntry,
  extractSticker,
  buildStickerPromptBlock,
};
