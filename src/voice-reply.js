const { MessageFlags } = require("discord.js");
const { generateAIReply } = require("./ai/chain");
const { VOICE_MAX_REPLY_CHARS } = require("./config");
const { synthesize, warmup } = require("./tts-client");
const { sendVoiceMessage } = require("./voice-message");

const VOICE_PERSONA_SUFFIX = `## /voice 專用輸出模式
這一次不是 Discord 文字聊天，而是要直接用西寶的聲音說出口。只輸出可朗讀的日文台詞，不要輸出中文。
- 保留西寶原本的個性與對問題的實質回答；預設是自然、略害羞，但不要刻意演成每個字都結巴。
- 1～3 個短句，總長盡量在 120 個日文字元內。先回答重點，再留一點自然反應。
- 用「。」「、」「…」安排自然換氣；不要連續大量省略號，也不要因害羞插入不必要的長停頓。
- 禁止 Markdown、網址、程式碼、自訂或 Unicode emoji、括號動作、舞台指示、說話者標籤。
- 最終輸出只能是要送進日文 TTS 的台詞本身。`;

function sanitizeVoiceText(value) {
  return String(value || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/<a?:\w+:\d+>/g, "")
    .replace(/:[a-zA-Z0-9_~-]{2,}:/g, "")
    .replace(/[*_#>|]/g, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasJapaneseKana(text) {
  return /[\u3040-\u30ff]/u.test(text);
}

function interactionAsMessage(interaction, client) {
  return {
    id: interaction.id,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    guild: interaction.guild,
    channel: interaction.channel,
    client,
    author: interaction.user,
    member: interaction.member,
    createdTimestamp: interaction.createdTimestamp || Date.now(),
  };
}

async function handleVoiceCommand(interaction, client, dependencies = {}) {
  const generate = dependencies.generateAIReply || generateAIReply;
  const tts = dependencies.synthesize || synthesize;
  const send = dependencies.sendVoiceMessage || sendVoiceMessage;
  const prewarm = dependencies.warmup || warmup;

  const userText = interaction.options.getString("message", true).trim();
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  prewarm();

  const rawReply = await generate(interactionAsMessage(interaction, client), userText, {
    personaSuffix: VOICE_PERSONA_SUFFIX,
    maxReplyChars: VOICE_MAX_REPLY_CHARS,
    recordMemory: false,
    includeEmojiPrompt: false,
    resolveEmojis: false,
  });
  const speechText = sanitizeVoiceText(rawReply);
  if (!speechText || !hasJapaneseKana(speechText)) {
    await interaction.editReply("語音台詞生成失敗了，請再試一次。");
    return false;
  }

  const audio = await tts(speechText, { mood: "shy" });
  if (!audio) {
    await interaction.editReply(`語音服務暫時不可用，先把台詞留給你：\n${speechText}`);
    return false;
  }

  const sent = await send(client, interaction.channelId, audio);
  if (!sent) {
    await interaction.editReply(`語音訊息送出失敗，先把台詞留給你：\n${speechText}`);
    return false;
  }

  await interaction.editReply("語音已送出。");
  return true;
}

module.exports = {
  VOICE_PERSONA_SUFFIX,
  sanitizeVoiceText,
  hasJapaneseKana,
  interactionAsMessage,
  handleVoiceCommand,
};
