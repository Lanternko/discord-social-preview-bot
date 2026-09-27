// Fixed (non-AI) text the bot posts on its own — preview failures, embed
// labels, fortune draws, quota notices — in the guild's /language setting.
//
// The language rides an AsyncLocalStorage context opened once per Discord
// event (index.js), so the preview builders deep in platforms/ and embeds.js
// read it without threading a `language` argument through every call. Outside
// a context (tests, startup) everything falls back to 繁體中文 — the behaviour
// before /language existed.

const { AsyncLocalStorage } = require("async_hooks");
const { DEFAULT_LANGUAGE, isValidLanguage } = require("./reply-language");
const { getGuildLanguage } = require("./language-store");

const languageContext = new AsyncLocalStorage();

// Each entry: { "zh-TW": ..., "zh-CN": ..., ja: ..., en: ... }. A value is a
// string, a string[] (pick one — caller's job), or a function of vars.
const TEXT = {
  // ── Preview pipeline ─────────────────────────────────────────────
  "preview.failed": {
    "zh-TW": "對不起對不起…預覽載入失敗了…我知道我不好… ///",
    "zh-CN": "对不起对不起…预览加载失败了…我知道我不好… ///",
    ja: "ごめんなさいごめんなさい…プレビューを読み込めなかった…わたしのせいだよね… ///",
    en: "Sorry, sorry… the preview failed to load… I know, it's my fault… ///",
  },
  "preview.degraded": {
    "zh-TW": "預覽降級",
    "zh-CN": "预览降级",
    ja: "簡易プレビュー",
    en: "Fallback preview",
  },
  "preview.spoilered": {
    "zh-TW": "🔞 已打碼",
    "zh-CN": "🔞 已打码",
    ja: "🔞 伏せ字済み",
    en: "🔞 Spoilered",
  },
  "preview.moreImages": {
    "zh-TW": ({ n }) => `還有 ${n} 張`,
    "zh-CN": ({ n }) => `还有 ${n} 张`,
    ja: ({ n }) => `ほか ${n} 枚`,
    en: ({ n }) => `${n} more image${n === 1 ? "" : "s"}`,
  },
  "preview.video": {
    "zh-TW": "影片",
    "zh-CN": "视频",
    ja: "動画",
    en: "video",
  },
  "preview.unavailable": {
    "zh-TW": "預覽目前無法載入，請點標題前往原始貼文。",
    "zh-CN": "预览暂时无法加载，请点标题前往原帖。",
    ja: "プレビューを読み込めませんでした。タイトルから元の投稿を開いてください。",
    en: "Couldn't load a preview right now — click the title to open the original post.",
  },

  // ── Instagram ────────────────────────────────────────────────────
  "instagram.post": {
    "zh-TW": "Instagram 貼文",
    "zh-CN": "Instagram 帖子",
    ja: "Instagram の投稿",
    en: "Instagram post",
  },
  "instagram.story": {
    "zh-TW": ({ owner }) => `這是 **${owner}** 的限動！`,
    "zh-CN": ({ owner }) => `这是 **${owner}** 的快拍！`,
    ja: ({ owner }) => `**${owner}** のストーリーだよ！`,
    en: ({ owner }) => `This is **${owner}**'s story!`,
  },
  "instagram.storyUnknown": {
    "zh-TW": "這是 Instagram 限動（但我抓不到是誰發的…抱歉）",
    "zh-CN": "这是 Instagram 快拍（但我查不到是谁发的…抱歉）",
    ja: "Instagram のストーリーだよ（でも誰の投稿か分からなかった…ごめんね）",
    en: "This is an Instagram story (but I couldn't tell whose… sorry)",
  },

  // ── Threads ──────────────────────────────────────────────────────
  "threads.post": {
    "zh-TW": "Threads 貼文",
    "zh-CN": "Threads 帖子",
    ja: "Threads の投稿",
    en: "Threads post",
  },
  "threads.videoPost": {
    "zh-TW": "Threads 影片貼文",
    "zh-CN": "Threads 视频帖子",
    ja: "Threads の動画投稿",
    en: "Threads video post",
  },
  "threads.postBy": {
    "zh-TW": ({ author, kind }) => `@${author} 的 ${kind}`,
    "zh-CN": ({ author, kind }) => `@${author} 的 ${kind}`,
    ja: ({ author, kind }) => `@${author} の ${kind}`,
    en: ({ author, kind }) => `${kind} by @${author}`,
  },
  "threads.walled": {
    "zh-TW": "未登入看不到這篇（限定或敏感內容），請跳轉至原文。",
    "zh-CN": "未登录看不到这篇（限定或敏感内容），请跳转至原文。",
    ja: "ログインしないと見られない投稿です（限定公開またはセンシティブな内容）。元の投稿を開いてください。",
    en: "This post needs a login to view (restricted or sensitive) — open the original.",
  },
  "threads.videoUnavailable": {
    "zh-TW": "（影片無法載入，請點連結觀看）",
    "zh-CN": "（视频无法加载，请点链接观看）",
    ja: "（動画を読み込めませんでした。リンクから見てください）",
    en: "(Couldn't load the video — open the link to watch)",
  },
  "threads.originalPost": {
    "zh-TW": "原貼文",
    "zh-CN": "原帖",
    ja: "元の投稿",
    en: "Original post",
  },
  "threads.noText": {
    "zh-TW": "（無文字內容）",
    "zh-CN": "（无文字内容）",
    ja: "（テキストなし）",
    en: "(no text)",
  },
  "threads.replyNoText": {
    "zh-TW": "（這則回覆沒有文字）",
    "zh-CN": "（这条回复没有文字）",
    ja: "（この返信にはテキストがありません）",
    en: "(this reply has no text)",
  },
  "threads.skippedReplies": {
    "zh-TW": ({ n }) => `（中間還有 ${n} 則）`,
    "zh-CN": ({ n }) => `（中间还有 ${n} 条）`,
    ja: ({ n }) => `（間に ${n} 件）`,
    en: ({ n }) => `(${n} more in between)`,
  },

  // ── Bedtime-story quiz ───────────────────────────────────────────
  "quiz.header": {
    "zh-TW": "📝 **閱讀測驗**",
    "zh-CN": "📝 **阅读测验**",
    ja: "📝 **読解クイズ**",
    en: "📝 **Reading quiz**",
  },
  "quiz.answer": {
    "zh-TW": ({ answer }) => `正確答案：||${answer}||`,
    "zh-CN": ({ answer }) => `正确答案：||${answer}||`,
    ja: ({ answer }) => `正解：||${answer}||`,
    en: ({ answer }) => `Answer: ||${answer}||`,
  },

  // ── @西寶 hardcoded replies ────────────────────────────────────────
  "fortune.line": {
    "zh-TW": ({ result, comment }) => `🎋 今日運勢：**${result}**\n${comment}`,
    "zh-CN": ({ result, comment }) => `🎋 今日运势：**${result}**\n${comment}`,
    ja: ({ result, comment }) => `🎋 今日の運勢：**${result}**\n${comment}`,
    en: ({ result, comment }) => `🎋 Today's fortune: **${result}**\n${comment}`,
  },
  "mention.apology": {
    "zh-TW": "對不起對不起…我知道我不好…///",
    "zh-CN": "对不起对不起…我知道我不好…///",
    ja: "ごめんなさいごめんなさい…わたしが悪かったです…///",
    en: "Sorry, sorry… I know it's my fault…///",
  },
  "mention.stickerMiss": {
    "zh-TW": ["欸…我剛剛想丟一張貼圖，結果找不到…", "啊…那張貼圖我沒有啦…", "我本來想貼圖的…算了…"],
    "zh-CN": ["欸…我刚刚想丢一张贴图，结果找不到…", "啊…那张贴图我没有啦…", "我本来想发贴图的…算了…"],
    ja: ["あれ…スタンプ送ろうとしたのに見つからない…", "あ…そのスタンプ持ってないや…", "スタンプ貼ろうと思ったんだけど…まあいっか…"],
    en: ["Uh… I wanted to send a sticker but I can't find it…", "Ah… I don't have that sticker…", "I was going to send a sticker… never mind…"],
  },
  "mention.greeting": {
    "zh-TW": ["哎呀…突然叫我幹嘛…", "有、有什麼事嗎…？///", "嗯…？叫我了嗎…", "…在的在的…怎麼了嗎？"],
    "zh-CN": ["哎呀…突然叫我干嘛…", "有、有什么事吗…？///", "嗯…？叫我了吗…", "…在的在的…怎么了吗？"],
    ja: ["わっ…急にどうしたの…", "な、なにか用…？///", "ん…？呼んだ…？", "…いるよいるよ…どうしたの？"],
    en: ["Eek… why the sudden call…", "W-what is it…? ///", "Hm…? Did you call me…", "…I'm here, I'm here… what's up?"],
  },
  "mention.calledMe": {
    "zh-TW": "你…你在叫我嗎？///",
    "zh-CN": "你…你在叫我吗？///",
    ja: "え…わたしのこと呼んだ？///",
    en: "Y-you're calling me? ///",
  },

  // ── AI quota ─────────────────────────────────────────────────────
  "quota.guild": {
    "zh-TW": ({ limit }) => `今天被叫太多次了…我先休息一下，明天再陪你們聊 ///\n-# 本伺服器今天的免費額度（${limit} 次）用完了，台北時間 0 點重置；管理員可用 \`/ai-key set\` 自帶金鑰解除限制。`,
    "zh-CN": ({ limit }) => `今天被叫太多次了…我先休息一下，明天再陪你们聊 ///\n-# 本服务器今天的免费额度（${limit} 次）用完了，台北时间 0 点重置；管理员可用 \`/ai-key set\` 自带密钥解除限制。`,
    ja: ({ limit }) => `今日は呼ばれすぎちゃった…ちょっと休むね、また明日話そう ///\n-# このサーバーの今日の無料枠（${limit} 回）を使い切りました。台北時間 0 時にリセット。管理者は \`/ai-key set\` で自前のキーを設定すると制限が外れます。`,
    en: ({ limit }) => `I've been called way too much today… I'll rest now, let's talk tomorrow ///\n-# This server's free quota for today (${limit} replies) is used up; it resets at 00:00 Taipei time. Admins can lift the limit with their own key via \`/ai-key set\`.`,
  },
  "quota.owner": {
    "zh-TW": "嗚…今天真的講不動了，明天再來找我好不好 ///\n-# 西寶今天整體的免費額度用完了，台北時間 0 點重置；自帶金鑰（`/ai-key set`）的伺服器不受影響。",
    "zh-CN": "呜…今天真的讲不动了，明天再来找我好不好 ///\n-# 西宝今天整体的免费额度用完了，台北时间 0 点重置；自带密钥（`/ai-key set`）的服务器不受影响。",
    ja: "うぅ…今日はもう話せない、また明日来てくれる？ ///\n-# 西寶の今日の無料枠が全体で尽きました。台北時間 0 時にリセット。自前のキー（`/ai-key set`）を設定したサーバーは影響を受けません。",
    en: "Ugh… I really can't talk anymore today, come find me tomorrow? ///\n-# 西寶's overall free quota for today is used up; it resets at 00:00 Taipei time. Servers with their own key (`/ai-key set`) aren't affected.",
  },

  // ── Slash-command safety net ─────────────────────────────────────
  "command.failed": {
    "zh-TW": "指令執行失敗了…抱歉 🙏",
    "zh-CN": "指令执行失败了…抱歉 🙏",
    ja: "コマンドの実行に失敗しちゃった…ごめんね 🙏",
    en: "The command failed… sorry 🙏",
  },
};

// Fortune tiers stay keyed by their 繁中 label (weights and comments hang off
// it); only what's shown changes.
const FORTUNE_LABELS = {
  大大吉: { "zh-CN": "大大吉", ja: "大大吉", en: "Supreme Luck" },
  大吉: { "zh-CN": "大吉", ja: "大吉", en: "Great Luck" },
  中吉: { "zh-CN": "中吉", ja: "中吉", en: "Good Luck" },
  小吉: { "zh-CN": "小吉", ja: "小吉", en: "Small Luck" },
  末吉: { "zh-CN": "末吉", ja: "末吉", en: "Late Luck" },
  吉: { "zh-CN": "吉", ja: "吉", en: "Luck" },
  凶: { "zh-CN": "凶", ja: "凶", en: "Bad Luck" },
  大凶: { "zh-CN": "大凶", ja: "大凶", en: "Terrible Luck" },
};

const FORTUNE_COMMENTS = {
  大大吉: {
    "zh-TW": ["欸欸欸…！這、這是超級幸運日……！////", "大、大大吉…？我第一次看到…！好厲害喔…！", "今、今天一定會發生超棒的事……！！！"],
    "zh-CN": ["欸欸欸…！这、这是超级幸运日……！////", "大、大大吉…？我第一次看到…！好厉害哦…！", "今、今天一定会发生超棒的事……！！！"],
    ja: ["えええ…！こ、これって超ラッキーデー……！////", "だ、大大吉…？初めて見た…！すごい…！", "きょ、今日は絶対すごくいいことが起きる……！！！"],
    en: ["Eeeh…! Th-this is a super lucky day……! ////", "S-Supreme Luck…? First time I've seen it…! Amazing…!", "S-something awesome is definitely happening today……!!!"],
  },
  大吉: {
    "zh-TW": ["今天會是很好的一天喔！", "哇…真的嗎…好厲害！", "運氣超好的…羨慕///"],
    "zh-CN": ["今天会是很好的一天哦！", "哇…真的吗…好厉害！", "运气超好的…羡慕///"],
    ja: ["今日はいい一日になるよ！", "わぁ…ほんと…？すごい！", "運よすぎ…うらやましい///"],
    en: ["Today's going to be a great day!", "Whoa… really…? Amazing!", "So lucky… I'm jealous ///"],
  },
  中吉: {
    "zh-TW": ["嗯…是好運喔！", "今天應該會順順的～", "有點小期待…的一天呢。"],
    "zh-CN": ["嗯…是好运哦！", "今天应该会顺顺的～", "有点小期待…的一天呢。"],
    ja: ["うん…いい運だよ！", "今日はきっと順調～", "ちょっと楽しみな…一日だね。"],
    en: ["Mm… that's good luck!", "Today should go smoothly~", "A day to look forward to… a little."],
  },
  小吉: {
    "zh-TW": ["還好啦…小小的幸運～", "有一點點好運喔。", "有點小確幸喔…"],
    "zh-CN": ["还好啦…小小的幸运～", "有一点点好运哦。", "有点小确幸哦…"],
    ja: ["まあまあ…ちょっとだけラッキー～", "ほんの少しいい運だよ。", "小さな幸せがあるかも…"],
    en: ["Not bad… a little luck~", "Just a tiny bit of luck.", "Some small happiness, maybe…"],
  },
  末吉: {
    "zh-TW": ["唔…勉強算吉吧…", "就…就還行吧？", "平平淡淡的一天。"],
    "zh-CN": ["唔…勉强算吉吧…", "就…就还行吧？", "平平淡淡的一天。"],
    ja: ["うーん…ぎりぎり吉かな…", "ま…まあまあ？", "平凡な一日だね。"],
    en: ["Hmm… barely counts as luck…", "It's… it's okay, I guess?", "A plain, ordinary day."],
  },
  吉: {
    "zh-TW": ["普通普通…", "就是正常啦～", "嗯，還行喔！"],
    "zh-CN": ["普通普通…", "就是正常啦～", "嗯，还行哦！"],
    ja: ["ふつうふつう…", "いつも通りだね～", "うん、悪くないよ！"],
    en: ["Average, average…", "Just a normal day~", "Mm, not bad!"],
  },
  凶: {
    "zh-TW": ["今天要小心一點喔…", "有點不好耶…好擔心…", "…要注意安全喔。"],
    "zh-CN": ["今天要小心一点哦…", "有点不好耶…好担心…", "…要注意安全哦。"],
    ja: ["今日はちょっと気をつけてね…", "ちょっとよくないかも…心配…", "…気をつけてね。"],
    en: ["Be a little careful today…", "That's not great… I'm worried…", "…stay safe, okay?"],
  },
  大凶: {
    "zh-TW": ["啊、對不起…抽到大凶了…", "不、不要難過…！明天會更好的…", "今天就乖乖待在家吧…///"],
    "zh-CN": ["啊、对不起…抽到大凶了…", "不、不要难过…！明天会更好的…", "今天就乖乖待在家吧…///"],
    ja: ["あ、ごめんね…大凶だった…", "お、落ち込まないで…！明日はきっといい日だよ…", "今日はおとなしく家にいよう…///"],
    en: ["Ah, sorry… you drew Terrible Luck…", "D-don't be sad…! Tomorrow will be better…", "Maybe just stay home today… ///"],
  },
};

function runWithLanguage(code, fn) {
  return languageContext.run(isValidLanguage(code) ? code : DEFAULT_LANGUAGE, fn);
}

function runInGuildLanguage(guildId, fn) {
  return runWithLanguage(getGuildLanguage(guildId), fn);
}

function currentLanguage() {
  return languageContext.getStore() || DEFAULT_LANGUAGE;
}

function pick(variants, lang) {
  return variants[lang] ?? variants[DEFAULT_LANGUAGE];
}

// Look up `key` in the current (or given) language. Functions are applied to
// `vars`; arrays come back whole for the caller to pick from.
function t(key, vars = {}, lang = currentLanguage()) {
  const entry = TEXT[key];
  if (!entry) throw new Error(`unknown system text: ${key}`);
  const value = pick(entry, lang);
  return typeof value === "function" ? value(vars) : value;
}

// Every language's rendering of `key` — for recognising a canned line after
// the fact (isQuotaReply) whatever language it went out in.
function allVariants(key, vars = {}) {
  return Object.keys(TEXT[key]).map((lang) => t(key, vars, lang));
}

function fortuneLabel(tier, lang = currentLanguage()) {
  return FORTUNE_LABELS[tier]?.[lang] ?? tier;
}

function fortuneComments(tier, lang = currentLanguage()) {
  return pick(FORTUNE_COMMENTS[tier], lang);
}

module.exports = {
  runWithLanguage,
  runInGuildLanguage,
  currentLanguage,
  t,
  allVariants,
  fortuneLabel,
  fortuneComments,
  FORTUNE_TIERS: Object.keys(FORTUNE_COMMENTS),
};
