const { pickRandom } = require("./utils");
const { generateAIReply } = require("./ai/chain");

const FORTUNE_RESULTS = [
  { label: "大大吉", weight: 1 },
  { label: "大吉", weight: 9 },
  { label: "中吉", weight: 16 },
  { label: "小吉", weight: 20 },
  { label: "末吉", weight: 20 },
  { label: "吉", weight: 15 },
  { label: "凶", weight: 13 },
  { label: "大凶", weight: 6 },
];

const FORTUNE_COMMENTS = {
  大大吉: [
    "欸欸欸…！這、這是超級幸運日……！////",
    "大、大大吉…？我第一次看到…！好厲害喔…！",
    "今、今天一定會發生超棒的事……！！！",
  ],
  大吉: ["今天會是很好的一天喔！", "哇…真的嗎…好厲害！", "運氣超好的…羨慕///"],
  中吉: ["嗯…是好運喔！", "今天應該會順順的～", "有點小期待…的一天呢。"],
  小吉: ["還好啦…小小的幸運～", "有一點點好運喔。", "有點小確幸喔…"],
  末吉: ["唔…勉強算吉吧…", "就…就還行吧？", "平平淡淡的一天。"],
  吉: ["普通普通…", "就是正常啦～", "嗯，還行喔！"],
  凶: ["今天要小心一點喔…", "有點不好耶…好擔心…", "…要注意安全喔。"],
  大凶: [
    "啊、對不起…抽到大凶了…",
    "不、不要難過…！明天會更好的…",
    "今天就乖乖待在家吧…///",
  ],
};

function drawFortune() {
  const total = FORTUNE_RESULTS.reduce((sum, r) => sum + r.weight, 0);
  let rand = Math.floor(Math.random() * total);
  for (const result of FORTUNE_RESULTS) {
    rand -= result.weight;
    if (rand < 0) return result.label;
  }
  return FORTUNE_RESULTS.at(-1).label;
}

const FALLBACK_GREETINGS = [
  "哎呀…突然叫我幹嘛…",
  "有、有什麼事嗎…？///",
  "嗯…？叫我了嗎…",
  "…在的在的…怎麼了嗎？",
];

async function handleMention(message, client) {
  const text = message.content
    .replace(/<@!?\d+>/g, "")
    .normalize("NFC")
    .trim();
  const textLower = text.toLowerCase();

  if (textLower.includes("抽籤") || textLower.includes("運勢")) {
    const result = drawFortune();
    const comment = pickRandom(FORTUNE_COMMENTS[result]);
    await message.reply({
      content: `🎋 今日運勢：**${result}**\n${comment}`,
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  if (textLower === "道歉") {
    await message.reply({
      content: "對不起對不起…我知道我不好…///",
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const aiReply = await generateAIReply(message, text);
  if (aiReply) {
    console.log(`[ai] reply len=${aiReply.length} user=${message.author.id}`);
    await message.reply({
      content: aiReply,
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  if (text === "") {
    await message.reply({
      content: pickRandom(FALLBACK_GREETINGS),
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  await message.reply({
    content: "你…你在叫我嗎？///",
    allowedMentions: { repliedUser: false },
  });
}

function isMentioningBot(message, client) {
  return message.mentions.has(client.user);
}

module.exports = {
  FORTUNE_RESULTS,
  FORTUNE_COMMENTS,
  FALLBACK_GREETINGS,
  drawFortune,
  handleMention,
  isMentioningBot,
};
