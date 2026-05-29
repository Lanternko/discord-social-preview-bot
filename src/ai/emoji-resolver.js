// Custom emoji support for 西寶 AI replies.
//
// Flow:
//   1. buildEmojiMap(client)       — collect name→{id,animated} from all guilds bot is in
//   2. buildEmojiPromptBlock(map)  — compact system-prompt block listing available emoji
//   3. resolveCustomEmojis(text, map) — post-process AI output: :name: → <:name:id>
//
// Bots can use custom emoji from any guild they're in, cross-server. So we pull
// from client.emojis.cache (all guilds) rather than just the message's guild.

// Names the AI should never use: sexual/suggestive, racially coded, server-member refs.
const EMOJI_BLACKLIST = new Set([
  "z_garden_eel",
  "Lick_arisu",
  "anon_licking",
  "mAnon_licking",
  "Ecchi",
  "Ecchi_kimura",
  "1Momoi",
  "zLBY",
  "Homo_ferret",
  "Homo_frog",
]);

// Names that look like auto-generated filenames — no useful semantics.
const JUNK_NAME_RE = /^(FB_IMG_|Screenshot\d|Gemini_Generated_|VS\d+|images?\d+|emoji_\d+)/i;

// Hints for names whose meaning isn't obvious from the name alone.
// Ha_* is handled by prefix below; everything else is exact-name.
const EXACT_HINTS = new Map([
  ["1Silent_witch", "吃驚/驚嚇（沉默魔女）"],
  ["0Nishi_tere", "害羞"],
  ["0kIroha", "太讚了/流口水/擦嘴巴"],
  ["0kKaguya_nani", "什麼？/困惑"],
  ["0cry_kaguya", "哭哭"],
  ["0kFushi_eel", "縮頭探頭"],
  ["0Cmonbruh", "Cmonbruh/come on"],
  ["mRaana", "好吃/冰淇淋/抹茶/貓"],
  ["mihari", "挑眉/懷疑"],
  ["umirin", "冷靜鼓掌/slow clap"],
  ["mSakiko_jisatsu", "破防（誇大語氣，非真自殺）"],
  ["mSoyo_HARUHIKAGE", "激動/生氣/破防（為什麼要唱春日影）"],
  ["Shika_shake3", "惱怒/發牢騷/跺地揮手"],
  ["mTomori_police", "逮捕/嚴厲斥責"],
  ["mSpiderman_evil", "壞笑/邪惡"],
  ["mAnon_sugar", "撒嬌/甜"],
  ["Rosmontis_wakatta", "わかった/了解"],
  ["Rosmontis_shiranai", "不知道"],
  ["Boolean_False", "錯/否"],
  ["Boolean_true_sparrow", "對/是"],
  ["Boolean_true_cat", "對/是"],
  ["Boolean_false_cat", "錯/否"],
  ["z_gan_a_ne", "甘阿捏/真的假的"],
  ["z_hao_yo_o", "好喲喔"],
  ["z_lala_punch", "拳打"],
  ["z_pathetic", "可憐"],
  ["z_sakurajima", "（角色）"],
  ["z_shikanokonoko", "（角色）"],
]);

// Emotion by name-prefix convention. Only prefixes with an unambiguous emotion
// are listed — these let new emoji (e.g. a fresh :Good_xxx:) get a meaning
// without a manual EXACT_HINTS entry. Sort-stable; first match wins.
const PREFIX_HINTS = [
  ["Good_", "讚/正確"],
  ["OAO_", "驚訝/瞪眼"],
  ["Waku_", "興奮"],
  ["555_", "哭哭"],
  ["Ha_", "蛤/質疑/疑惑"],
  ["Angry_", "生氣"],
  ["Sleep_", "睡著"],
  ["Awkward_", "尷尬"],
  ["Question_", "困惑"],
  ["Fighting_", "加油/助威"],
];

// Resolve an emoji name to a short emotion/usage hint, or null if we can't
// confidently say what it's for (exact hint > prefix convention > nothing).
// Names with no derivable meaning are NOT advertised to the model — listing a
// bare character name with no emotion just invites misuse.
function emotionForName(name) {
  if (EXACT_HINTS.has(name)) return EXACT_HINTS.get(name);
  for (const [prefix, hint] of PREFIX_HINTS) {
    if (name.startsWith(prefix)) return hint;
  }
  return null;
}

function isUsableEmoji(name) {
  if (!name) return false;
  if (EMOJI_BLACKLIST.has(name)) return false;
  if (name === "__") return false;
  if (JUNK_NAME_RE.test(name)) return false;
  return true;
}

function buildEmojiMap(client) {
  const map = new Map();
  if (!client?.emojis?.cache) return map;
  for (const emoji of client.emojis.cache.values()) {
    if (!isUsableEmoji(emoji.name)) continue;
    // On duplicate names keep the first seen (order is stable per GUILD_CREATE).
    if (!map.has(emoji.name)) {
      map.set(emoji.name, { id: emoji.id, animated: !!emoji.animated });
    }
  }
  return map;
}

// Unicode / system emoji (😳😅💦🥺 …). <:name:id> custom syntax is pure ASCII,
// so this never touches resolved custom emoji. Includes flag pairs, variation
// selectors, ZWJ and skin-tone modifiers so compound emoji are fully removed.
const UNICODE_EMOJI_RE =
  /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;

function resolveCustomEmojis(text, emojiMap) {
  let out = text;
  if (emojiMap && emojiMap.size > 0) {
    out = out.replace(/:([A-Za-z0-9_]+):/g, (match, name) => {
      const e = emojiMap.get(name);
      if (e) return `<${e.animated ? "a" : ""}:${name}:${e.id}>`;
      // Unknown name. The model loves to invent names from the prefix conventions
      // (e.g. :OAO_bocchi: — real OAO_ + real bocchi, but no such emoji). Drop it
      // so it never reaches the user as literal ":fake:" garbage. Keep pure-digit
      // tokens like :30: which are likely timestamps/ratios, not emoji attempts.
      if (/^\d+$/.test(name)) return match;
      return "";
    });
  }
  // Hard guarantee "custom emoji only": strip any Unicode/system emoji the model
  // emitted despite the persona ban. Runs even when emojiMap is empty.
  out = out.replace(UNICODE_EMOJI_RE, "");
  if (out === text) return text;
  // Clean up whitespace left behind by removed tokens.
  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/ {2,}/g, " ")
    .replace(/ +([,，。、！？!?…：])/g, "$1")
    .trim();
}

// The emoji table is stable for a whole bot session (the guild emoji cache
// rarely changes), but generateAIReply rebuilds the system prompt on every
// call. Memoize on the set of emoji names so we don't re-walk the map + rebuild
// the (large) string each reply. Cache key is the sorted name list.
let _promptCache = { sig: null, block: "" };

function buildEmojiPromptBlock(emojiMap) {
  if (!emojiMap || emojiMap.size === 0) return "";

  const names = [...emojiMap.keys()].sort();
  const sig = names.join(",");
  if (_promptCache.sig === sig) return _promptCache.block;

  // One row per emoji we can confidently describe (exact hint or prefix). Emoji
  // with no derivable emotion are skipped — they're noise the model would misuse.
  const rows = [];
  for (const name of names) {
    const emotion = emotionForName(name);
    if (emotion) rows.push(`:${name}: ${emotion}`);
  }

  if (rows.length === 0) {
    _promptCache = { sig, block: "" };
    return "";
  }

  const lines = [
    "## 你超愛用的群組自訂 emoji（用 :name: 格式打出來，系統會自動轉成圖片）",
    "這些是這個群的梗圖 emoji，你平常聊天會自然夾進句子表達情緒——情緒一上來（害羞、驚訝、無言、開心、哭哭、吐槽）就從下表挑一個丟進句子，不要客氣。",
    "查表用——每項是「:名字: 用途/情緒」：",
    rows.join("　｜　"),
    "範例（照這格式把 :name: 寫進句子裡）：「欸…真的假的 :Ha_seal:」「好過分喔 :555_dog:」「那個…我也想去 :0Nishi_tere:」「哇好厲害 :Waku_bocchi:」",
    "**只能用上表這些群組自訂 :name: emoji，絕對不要用 Unicode／系統 emoji（😳💦😣😅 這種一律禁止）**。表裡找不到貼切的就用括號動作或語氣詞，別拿系統 emoji 頂替。每則挑 1 個最貼切的就好，別硬塞一堆。",
  ];

  const block = `\n\n${lines.join("\n")}`;
  _promptCache = { sig, block };
  return block;
}

module.exports = { buildEmojiMap, resolveCustomEmojis, buildEmojiPromptBlock };
