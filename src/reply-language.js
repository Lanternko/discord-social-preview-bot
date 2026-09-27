// Which language 西寶 writes her AI replies in, per guild (/language).
//
// Only AI-generated text follows this — chat, skills, recap, story. Hardcoded
// strings (preview errors, fortune draws) and internal notes (memory
// summaries) stay 繁體中文 on purpose: translating the former is a separate
// job, and switching the latter would leave one guild's memory in two
// languages.

const DEFAULT_LANGUAGE = "zh-TW";

const LANGUAGES = {
  "zh-TW": {
    label: "繁體中文",
    promptName: "繁體中文",
    storyRule: "- 全文用繁體中文（台灣用語），不要出現簡體字。",
  },
  "zh-CN": {
    label: "简体中文",
    promptName: "简体中文",
    storyRule: "- 全文用简体中文，不要出現繁體字。",
  },
  ja: {
    label: "日本語",
    promptName: "日文（日本語）",
    storyRule: "- 全文用自然的日文（日本語）寫，標題也是日文。",
  },
  en: {
    label: "English",
    promptName: "英文（English）",
    storyRule: "- 全文用自然的英文（English）寫，標題也是英文。",
  },
};

const VALID_LANGUAGES = Object.keys(LANGUAGES);

function isValidLanguage(code) {
  return VALID_LANGUAGES.includes(code);
}

function languageSpec(code) {
  return LANGUAGES[code] || LANGUAGES[DEFAULT_LANGUAGE];
}

// The persona is written in Chinese and its style notes (「嗯…」, ///) are
// Chinese-typing habits. Without this block a non-Chinese setting drifts into
// a generic assistant voice — the character has to survive the switch.
function buildLanguagePersonaBlock(code) {
  if (!isValidLanguage(code) || code === DEFAULT_LANGUAGE) return "";
  const { promptName } = languageSpec(code);
  return [
    "",
    "",
    "## 回覆語言",
    `這個伺服器的管理員設定你用${promptName}回覆。上面的人設和說話習慣是用中文寫的，那是在描述你是誰——實際說出口一律用${promptName}。`,
    `- 你還是同一個人：個性、情緒起伏、害羞和吐槽都照舊，只是換成${promptName}裡自然的講法，不要變成客服或翻譯腔。`,
    `- 對方用別的語言跟你講話，你也照樣用${promptName}回。`,
    "- 群友暱稱、專有名詞、emoji 代碼（:name:）照原樣，不要翻譯。",
  ].join("\n");
}

module.exports = {
  DEFAULT_LANGUAGE,
  LANGUAGES,
  VALID_LANGUAGES,
  isValidLanguage,
  languageSpec,
  buildLanguagePersonaBlock,
};
