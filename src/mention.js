const { pickRandom } = require("./utils");
const { generateAIReply, isQuotaReply } = require("./ai/chain");
const { detectSkill, buildSkillContext } = require("./ai/skills");
const { extractSticker } = require("./ai/sticker-resolver");
const { withTyping } = require("./typing");
const {
  buildStickerCatalog,
  buildStickerSendPayload,
} = require("./stickers");
const { t, fortuneLabel, fortuneComments } = require("./system-text");
const { getGuildAiChatMode } = require("./ai-chat-store");

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

function drawFortune() {
  const total = FORTUNE_RESULTS.reduce((sum, r) => sum + r.weight, 0);
  let rand = Math.floor(Math.random() * total);
  for (const result of FORTUNE_RESULTS) {
    rand -= result.weight;
    if (rand < 0) return result.label;
  }
  return FORTUNE_RESULTS.at(-1).label;
}

// Send 西寶's AI reply, attaching the sticker she asked for (if any).
//
// The sticker is best-effort: a guild sticker can be deleted between catalog
// build and send, and a library file can go missing on disk — both 400 the
// whole message. Losing the sticker is fine, losing the reply is not, so a
// failed send is retried once as text-only.
async function sendAIReply(message, aiReply, stickerCatalog) {
  const { text, sticker } = extractSticker(aiReply, stickerCatalog);
  const base = { allowedMentions: { repliedUser: false } };
  // Used when there's no sticker to send, and again when sending one failed.
  // A reply that was ONLY a sticker token leaves no text behind — say a line
  // rather than posting silence or leaking the raw "[貼圖:…]" token.
  const textOnly = text
    ? { ...base, content: text }
    : { ...base, content: pickRandom(t("mention.stickerMiss")) };

  const stickerPayload = buildStickerSendPayload(sticker);
  if (!stickerPayload) {
    await message.reply(textOnly);
    return;
  }

  console.log(`[sticker] send kind=${sticker.kind} name=${sticker.name}`);
  try {
    // A sticker-only reply carries no content — that's the "一張圖代替一句話"
    // case, and Discord accepts a message with stickers/files but no text.
    await message.reply({
      ...base,
      ...(text ? { content: text } : {}),
      ...stickerPayload,
    });
  } catch (err) {
    console.warn(
      `[sticker] send failed kind=${sticker.kind} name=${sticker.name}: ${err.message}`,
    );
    await message.reply(textOnly);
  }
}

async function handleMention(message, client) {
  const text = message.content
    .replace(/<@!?\d+>/g, "")
    .normalize("NFC")
    .trim();
  const textLower = text.toLowerCase();

  if (textLower.includes("抽籤") || textLower.includes("運勢")) {
    const tier = drawFortune();
    await message.reply({
      content: t("fortune.line", {
        result: fortuneLabel(tier),
        comment: pickRandom(fortuneComments(tier)),
      }),
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  if (textLower === "道歉") {
    await message.reply({
      content: t("mention.apology"),
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  const stickerCatalog = await buildStickerCatalog(message.guild);

  // Skill routing: a request shaped like one of the tuned prompt packs (講故事,
  // …) gets that pack folded into THIS call — no extra round trip. On any miss
  // the skill resolves to null and she answers as usual.
  const skill = detectSkill(text);
  const skillCtx = await buildSkillContext(skill, { message, text });
  if (skillCtx) {
    console.log(`[skill] hit id=${skill.id} user=${message.author.id}`);
  }

  const aiReply = await withTyping(message.channel, () => generateAIReply(message, text, {
    stickerCatalog,
    ...(skillCtx
      ? {
          personaSuffix: skillCtx.personaSuffix,
          minTokens: skillCtx.minTokens,
          minReplyChars: skillCtx.minReplyChars,
          extraUserContext: skillCtx.extraUserContext || "",
          providerOptions: skillCtx.providerOptions || {},
        }
      : {}),
  }));
  if (aiReply) {
    // A skill may normalise its own output format (the story pack forces the
    // first line into a `## ` heading). Never let that throw away the reply.
    let finalReply = aiReply;
    if (skillCtx?.postProcess && !isQuotaReply(aiReply)) {
      try {
        finalReply = skillCtx.postProcess(aiReply) || aiReply;
      } catch (err) {
        console.warn(`[skill] postProcess failed id=${skill.id}: ${err.message}`);
      }
    }
    console.log(`[ai] reply len=${finalReply.length} user=${message.author.id}`);
    await sendAIReply(message, finalReply, stickerCatalog);
    return;
  }

  if (text === "") {
    await message.reply({
      content: pickRandom(t("mention.greeting")),
      allowedMentions: { repliedUser: false },
    });
    return;
  }

  await message.reply({
    content: t("mention.calledMe"),
    allowedMentions: { repliedUser: false },
  });
}

function isMentioningBot(message, client) {
  return message.mentions.has(client.user);
}

// A mention the user actually typed: <@bot> in the text, or the bot's own
// managed role (Discord's autocomplete offers both). Unlike isMentioningBot,
// a reply ping and @everyone / @here don't count.
function isDirectMention(message, client) {
  const botId = client.user?.id;
  if (!botId) return false;
  if (new RegExp(`<@!?${botId}>`).test(message.content || "")) return true;
  const botRoleId = message.guild?.members?.me?.roles?.botRole?.id;
  return Boolean(botRoleId && message.mentions.roles?.has?.(botRoleId));
}

// Whether this message should reach handleMention, per the guild's /ai-chat
// mode. In "direct" mode a non-direct mention falls through to the normal
// preview path, so a reply to 西寶 that carries a link still gets previewed.
function shouldHandleMention(message, client) {
  if (!isMentioningBot(message, client)) return false;
  if (getGuildAiChatMode(message.guildId) === "all") return true;
  return isDirectMention(message, client);
}

module.exports = {
  sendAIReply,
  FORTUNE_RESULTS,
  drawFortune,
  handleMention,
  isMentioningBot,
  isDirectMention,
  shouldHandleMention,
};
