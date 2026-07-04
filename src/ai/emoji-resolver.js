// Custom emoji support for 西寶 AI replies.
//
// Flow:
//   1. buildEmojiMap(client, guildId) — collect name→{id,animated} from the current guild
//   2. buildEmojiPromptBlock(map)  — compact system-prompt block listing available emoji
//   3. resolveCustomEmojis(text, map) — post-process AI output: :name: → <:name:id>
//
// Discord may allow cross-guild custom emoji in some contexts, but prompting the
// model with every emoji the bot can see leaks other servers' meme vocabulary
// into the current server. Guild-scoped maps keep 西寶's emoji choices local.

// Names the AI should never use: sexual/suggestive, racially coded, server-member refs.
const EMOJI_BLACKLIST = new Set([]);

// Names that look like auto-generated filenames — no useful semantics.
const JUNK_NAME_RE = /^(FB_IMG_|Screenshot\d|Gemini_Generated_|VS\d+|images?\d+|emoji_\d+)/i;

// Hints for names whose meaning can't be derived from prefix/suffix rules.
// Check order: EXACT_HINTS → PREFIX_HINTS → SUFFIX_HINTS.
const EXACT_HINTS = new Map([
  ["1Silent_witch", "吃驚/驚嚇（沉默魔女）"],
  ["0kIroha", "太讚了/流口水/擦嘴巴"],
  ["0kFushi_eel", "縮頭探頭"],
  ["0Cmonbruh", "Cmonbruh/come on"],
  ["mRaana", "好吃/冰淇淋/抹茶/貓"],
  ["mRaana_matcha", "抹茶/好吃"],
  ["Rin_Oishi", "好吃"],
  ["Cucumber_drinking", "喝飲料/喝水"],
  ["ruruka_icecream", "冰淇淋/甜點"],
  ["mihari", "挑眉/懷疑"],
  ["mihari_suspicious", "懷疑/盯"],
  ["umirin", "冷靜鼓掌/slow clap"],
  ["mSakiko_jisatsu", "破防（誇大語氣，非真自殺）"],
  ["mSoyo_HARUHIKAGE", "激動/生氣/破防（為什麼要唱春日影）"],
  ["Shika_shake3", "惱怒/發牢騷/跺地揮手"],
  ["mTomori_police", "逮捕/嚴厲斥責"],
  ["Spider_evilsmile", "壞笑/邪惡"],
  ["mAnon_sugar", "撒嬌/甜"],
  ["Rosmontis_wakatta", "わかった/了解"],
  ["Rosmontis_shiranai", "不知道"],
  ["Rosmontis_goodjob", "做得好/稱讚"],
  ["Rosmontis_recommend", "推薦/推"],
  ["Rosmontis_sunshine", "開心/陽光"],
  ["Rin_O_O", "驚訝/瞪眼"],
  ["Awakward_ichika", "尷尬"],
  ["mPhone", "手機/滑手機"],
  ["Starburst_stream", "直播/開台"],
  ["z_no_picture", "沒圖/沒有照片"],
  ["mCucumberHappy2", "開心"],
  ["mCucumberStare", "盯/觀察"],
  ["Futaba_feeling_cold", "冷/發抖"],
  ["Pepe_A_Madge", "生氣/不爽"],
  ["Pepe_KILL", "氣到想砍/威脅吐槽（誇張玩笑）"],
  ["Pepe_LaughPoint", "笑到指人"],
  ["Pepe_OK", "OK/可以"],
  ["Pepe_Sus", "可疑"],
  ["Pepe_Why", "為什麼/崩潰疑問"],
  ["bird_bonk", "敲頭/制裁"],
  ["z_gan_a_ne", "甘阿捏/真的假的"],
  ["z_hao_yo_o", "好油喔/對方太宅"],
  ["z_pathetic", "可憐"],
  ["z_garden_eel", "花園鰻冒出來/雞雞"],
  ["Lick_arisu", "舔/舔螢幕"],
  ["anon_licking", "舔/舔螢幕"],
  ["mAnon_licking", "舔/舔螢幕"],
  ["1Momoi", "嚴厲斥責"],
  ["zLBY", "害羞"],
  ["Homo_ferret", "我想要/興奮了"],
  ["Homo_frog", "我想要/興奮了"],
  ["Ecchi", "好色哦/臉紅吐舌"],
  ["Ecchi_kimura", "嘿嘿嘿/太尊了"],
  ["z_sakurajima", "蹲下來"],
  ["z_shikanokonoko", "（角色）"],
]);

// Emotion by name-prefix convention. Only prefixes with an unambiguous emotion
// are listed — these let new emoji (e.g. a fresh :Good_xxx:) get a meaning
// without a manual EXACT_HINTS entry. Sort-stable; first match wins.
const PREFIX_HINTS = [
  ["Good_", "讚/正確"],
  ["OAO_", "驚訝/瞪眼"],
  ["Waku_", "興奮/期待"],
  ["555_", "哭哭"],
  ["Ha_", "蛤/質疑/疑惑"],
  ["Angry_", "生氣"],
  ["Sleep_", "睡著"],
  ["Awkward_", "尷尬"],
  ["Question_", "困惑"],
  ["Fighting_", "加油/助威"],
  ["Win_", "勝利/贏了"],
  ["Boolean_true", "對/是"],
  ["Boolean_false", "錯/否"],
];

// Emotion by name-suffix convention. Matched against the last _-delimited
// segment (case-insensitive), so Pepe_Cry, mahiro_cry, 0kFushi_cry all
// resolve automatically. Trailing digits are stripped before matching
// (nishi_tere2 → tere). First match wins.
const SUFFIX_HINTS = [
  ["cry", "哭哭"],
  ["scared", "害怕/驚嚇"],
  ["scare", "害怕/驚嚇"],
  ["tere", "害羞/尷尬"],
  ["angry", "生氣"],
  ["awkward", "尷尬"],
  ["happy", "開心"],
  ["waku", "興奮/期待"],
  ["ha", "蛤/質疑"],
  ["wow", "驚訝/哇"],
  ["joy", "開心/喜悅"],
  ["stare", "盯/觀察"],
  ["punch", "拳打/吐槽"],
  ["phone", "手機/滑手機"],
  ["evil", "壞笑/邪惡"],
  ["heart", "喜歡/愛心"],
  ["hello", "打招呼/嗨"],
  ["hate", "討厭/不爽"],
  ["eat", "吃東西/好吃"],
  ["cold", "冷/發抖"],
  ["utsu", "鬱悶/低落"],
  ["owo", "可愛/賣萌"],
  ["nani", "什麼？/困惑"],
  ["yell", "大喊/激動"],
  ["clap", "鼓掌/稱讚"],
  ["sweat", "緊張/冒汗"],
  ["doubt", "懷疑/疑惑"],
  ["think", "思考/疑惑"],
  ["good", "讚/可以"],
  ["huh", "蛤/困惑"],
  ["bonk", "敲頭/制裁"],
  ["oao", "驚訝/瞪眼"],
  ["stream", "直播/開台"],
];

// Decorative sort-order prefix some emoji names carry in FRONT of the real
// emotion token (0_555_Kei → "555" = 哭哭, 2_Ha_seal → "Ha" = 蛤). The raw
// startsWith / lastSeg checks miss these, so emotionForName retries once on the
// stripped name. Only "<digits>[k]_" is stripped — letter prefixes (mSakiko,
// z_garden_eel) are already covered by EXACT_HINTS.
function stripDecorativePrefix(name) {
  return name.replace(/^\d+k?_/, "");
}

function matchPrefixSuffix(name) {
  for (const [prefix, hint] of PREFIX_HINTS) {
    if (name.startsWith(prefix)) return hint;
  }
  const parts = name.split("_");
  const lastSeg = parts[parts.length - 1].toLowerCase().replace(/\d+$/, "");
  if (lastSeg) {
    for (const [suffix, hint] of SUFFIX_HINTS) {
      if (lastSeg === suffix) return hint;
    }
  }
  return null;
}

// Resolve an emoji name to a short emotion/usage hint, or null if we can't
// confidently say what it's for. Priority: exact → prefix/suffix → same checks
// on the decoration-stripped name. Names with no derivable meaning are NOT
// advertised to the model — listing a bare character name with no emotion just
// invites misuse.
function emotionForName(name) {
  if (EXACT_HINTS.has(name)) return EXACT_HINTS.get(name);
  const direct = matchPrefixSuffix(name);
  if (direct) return direct;
  const stripped = stripDecorativePrefix(name);
  if (stripped !== name) return matchPrefixSuffix(stripped);
  return null;
}

function isUsableEmoji(name) {
  if (!name) return false;
  if (EMOJI_BLACKLIST.has(name)) return false;
  if (name === "__") return false;
  if (JUNK_NAME_RE.test(name)) return false;
  return true;
}

function buildEmojiMap(client, guildId = null, trustedGuildIds = []) {
  const map = new Map();
  const trustedSet = new Set(trustedGuildIds);
  const sourceGuildIds =
    guildId && trustedSet.has(guildId) ? [...trustedSet] : guildId ? [guildId] : [];

  if (sourceGuildIds.length > 0) {
    for (const sourceGuildId of sourceGuildIds) {
      const emojiCache =
        client?.guilds?.cache?.get?.(sourceGuildId)?.emojis?.cache ?? null;
      appendEmojiCache(map, emojiCache);
    }
    return map;
  }

  appendEmojiCache(map, client?.emojis?.cache ?? null);
  return map;
}

function appendEmojiCache(map, emojiCache) {
  if (!emojiCache) return;
  for (const emoji of emojiCache.values()) {
    if (!isUsableEmoji(emoji.name)) continue;
    // On duplicate names keep the first seen.
    if (!map.has(emoji.name)) {
      map.set(emoji.name, { id: emoji.id, animated: !!emoji.animated });
    }
  }
}

const EMOJI_ALIASES = new Map([
  ["pepe_knife", "Pepe_KILL"],
  ["pepe_kill", "Pepe_KILL"],
  ["pepe_punch", "Pepe_punch"],
  ["pepe_bonk", "bird_bonk"],
  ["pepe_ok", "Pepe_OK"],
  ["pepe_good", "Pepe_Good"],
  ["pepe_huh", "Pepe_Huh"],
  ["pepe_sus", "Pepe_Sus"],
  ["pepe_sweat", "Pepe_Sweat"],
  ["pepe_scared", "Pepe_Scared"],
  ["pepe_cry", "Pepe_Cry"],
]);

function normalizeEmojiName(name) {
  return String(name || "").toLowerCase();
}

function resolveEmojiEntry(name, emojiMap) {
  if (!emojiMap) return null;
  const exact = emojiMap.get(name);
  if (exact) return { name, emoji: exact };

  const normalized = normalizeEmojiName(name);
  const aliasName = EMOJI_ALIASES.get(normalized);
  if (aliasName && emojiMap.has(aliasName)) {
    return { name: aliasName, emoji: emojiMap.get(aliasName) };
  }

  for (const [candidateName, emoji] of emojiMap.entries()) {
    if (normalizeEmojiName(candidateName) === normalized) {
      return { name: candidateName, emoji };
    }
  }

  return null;
}

// Unicode / system emoji (😳😅💦🥺 …). <:name:id> custom syntax is pure ASCII,
// so this never touches resolved custom emoji. Includes flag pairs, variation
// selectors, ZWJ and skin-tone modifiers so compound emoji are fully removed.
const UNICODE_EMOJI_RE =
  /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}]/gu;

function formatDiscordEmoji(name, emoji) {
  return `<${emoji.animated ? "a" : ""}:${name}:${emoji.id}>`;
}

function resolveCustomEmojis(text, emojiMap) {
  let out = text;
  if (emojiMap) {
    const replaceEmojiToken = (match, animatedMarker, name, rawId) => {
      const resolved = resolveEmojiEntry(name, emojiMap);
      if (resolved) {
        const { name: resolvedName, emoji } = resolved;
        if (rawId && rawId !== emoji.id) {
          console.warn(
            `[emoji] corrected mismatched id for ${name}: ${rawId} -> ${emoji.id}`,
          );
        }
        return formatDiscordEmoji(resolvedName, emoji);
      }
      // Unknown name. The model loves to invent names from the prefix conventions
      // (e.g. :OAO_bocchi: — real OAO_ + real bocchi, but no such emoji). Drop it
      // so it never reaches the user as literal ":fake:" garbage. Keep pure-digit
      // tokens like :30: which are likely timestamps/ratios, not emoji attempts.
      if (/^\d+$/.test(name)) return match;
      return "";
    };

    // Fix malformed raw Discord custom emoji attempts first. The model sometimes
    // copies the source form but uses a fullwidth colon or drops the leading "<",
    // leaving garbage like "：Waku_kyaru:121...>" in chat.
    out = out.replace(
      /<?(a?)[:：]([A-Za-z0-9_]+)[:：](\d{5,25})>?/g,
      replaceEmojiToken,
    );

    // Then resolve normal :name: tokens, including the fullwidth-colon variants
    // the model occasionally emits in CJK text.
    out = out.replace(/(^|[^<A-Za-z0-9_])[:：]([A-Za-z0-9_]+)[:：]/g, (match, prefix, name) =>
      prefix + replaceEmojiToken(match.slice(prefix.length), "", name, ""),
    );
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

  const examples = [
    ["Ha_seal", "欸…真的假的"],
    ["555_dog", "好過分喔"],
    ["0Nishi_tere", "那個…我也想去"],
    ["Waku_bocchi", "哇好厲害"],
    ["Pepe_KILL", "不要鬧啦"],
    ["Pepe_OK", "嗯…可以"],
  ]
    .filter(([name]) => emojiMap.has(name))
    .slice(0, 4)
    .map(([name, text]) => `「${text} :${name}:」`);
  if (examples.length === 0) {
    examples.push(`「嗯… :${names[0]}:」`);
  }

  const lines = [
    "## 你超愛用的群組自訂 emoji（用 :name: 格式打出來，系統會自動轉成圖片）",
    "這些是這個群的梗圖 emoji，你平常聊天會自然夾進句子表達情緒——情緒一上來（害羞、驚訝、無言、開心、哭哭、吐槽）就從下表挑一個丟進句子，不要客氣。",
    "查表用——每項是「:名字: 用途/情緒」：",
    rows.join("　｜　"),
    `範例（照這格式把 :name: 寫進句子裡，平常從上表挑）：${examples.join("")}`,
    "平常從上表挑 :name: 用；如果有人直接點名叫你打某個 :name: 貼圖，照他說的打就好（就算不在上表也沒關係）。**絕對不要用 Unicode／系統 emoji（😳💦😣😅 箭頭↖️ 這種一律禁止）**——你打不出系統符號，被要求時老實講，別拿系統 emoji 頂替也別硬掰「我打了你看不到」。表裡找不到貼切的就用括號動作或語氣詞。每則挑 1 個最貼切的就好，別硬塞一堆。",
  ];

  const block = `\n\n${lines.join("\n")}`;
  _promptCache = { sig, block };
  return block;
}

module.exports = {
  buildEmojiMap,
  resolveCustomEmojis,
  buildEmojiPromptBlock,
  resolveEmojiEntry,
  emotionForName,
};
