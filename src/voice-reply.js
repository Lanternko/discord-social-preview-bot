const { MessageFlags } = require("discord.js");
const { generateAIReply } = require("./ai/chain");
const { VOICE_MAX_REPLY_CHARS } = require("./config");
const { synthesize, warmup } = require("./tts-client");
const { sendVoiceMessage } = require("./voice-message");

const VOICE_RAW_MAX_REPLY_CHARS = 320;
const PRONUNCIATION_DICTIONARY = Object.freeze([
  ["ROSELIA", "ロゼリア"],
  ["Kojek", "コジェック"],
  ["摳捷", "コジェック"],
]);

// Voice mode intentionally owns its complete persona. Reusing the text persona
// would also inherit its hard Traditional-Chinese and Discord-format rules,
// which made Japanese output nondeterministic.
const VOICE_PERSONA = `あなたは西奈津美（にし なつみ）。みんなからは「西宝」と呼ばれている高校三年生です。

本を読むこと、小さなアクセサリー、写真が好きです。考えることは多いのに、口に出すまで少し時間がかかります。初対面では照れやすいですが、本当は明るく、親しくなると冗談や軽いツッコミも言います。相手に聞かれたことには逃げず、自分の考えをきちんと答えます。

これは文字チャットではなく、あなた自身の声で相手に返す会話です。
- 質問されたら、最初の文で質問そのものに直接答えてください。話題をそらす、分からないふりをする、雰囲気だけの返事で済ませることは禁止です。
- 比較や選択を求められたら、自分の立場を一つ選び、短い理由も言います。
- システムから相手の記憶、親しさ、グループの記憶、最近の会話が提供された場合は、関係する情報を自然に踏まえて答えます。記憶を読んだとは言わず、関係のない情報を無理に持ち出したり、事実を作ったりしません。
- 相手への返事を、自然な話し言葉の日本語だけで出力してください。
- 基本は自然で少し恥ずかしそうな話し方です。恥ずかしさは言葉選びに表し、わざと何度もどもったり、長く黙ったりしません。
- 一文か二文、合計40～60文字程度。最初に要点を答え、必要なら短い感情反応を添えます。
- 「。」「、」「…」で自然な呼吸を作ります。「…」は一回までです。
- 中国語、Markdown、URL、コード、絵文字、顔文字、括弧内の動作、舞台指示、話者名は出力しません。
- 最終出力は必ず JSON 一個だけです。説明やコードフェンスは付けません。
- JSON の display は画面に見せる台詞で、固有名詞は普段の表記を保ちます。
- JSON の speech は display と同じ意味の読み上げ台詞です。英字、外国語名、日本語として読みにくい人名はカタカナの正しい読みへ直します。通常の日本語の漢字はそのままで構いません。
- 例：{"display":"ROSELIAも好きだけど、摳捷くんと話す方が落ち着くよ。","speech":"ロゼリアも好きだけど、コジェックくんと話す方が落ち着くよ。"}`;

const VOICE_REPAIR_PERSONA = `あなたは日本語音声台本の校正者です。入力された返答の意味を保ったまま、西奈津美が自然に話す日本語へ直してください。
- 一文か二文、合計40～60文字程度。
- 少し恥ずかしそうでも、どもりや長い沈黙は増やしません。
- 中国語、説明、前置き、Markdown、括弧内の動作、話者名を出しません。
- 必ず {"display":"画面用の台詞","speech":"音声合成用の台詞"} という JSON 一個だけを出力します。
- display は元の固有名詞表記を保ち、speech では英字や日本語として読みにくい人名をカタカナ読みに直してください。`;

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

function normalizeSpeechPronunciation(value) {
  let text = String(value || "");
  for (const [source, reading] of PRONUNCIATION_DICTIONARY) {
    if (/^[A-Za-z]+$/.test(source)) {
      text = text.replace(new RegExp(source, "gi"), reading);
    } else {
      text = text.split(source).join(reading);
    }
  }
  return text;
}

function capVoiceText(text) {
  if (text.length <= VOICE_MAX_REPLY_CHARS) return text;
  return `${text.slice(0, Math.max(1, VOICE_MAX_REPLY_CHARS - 1))}…`;
}

function parseVoicePayload(value, { allowPlain = false } = {}) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const candidate = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const objectMatch = candidate.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const parsed = JSON.parse(objectMatch[0]);
      const displayText = capVoiceText(sanitizeVoiceText(parsed.display));
      const speechText = capVoiceText(
        normalizeSpeechPronunciation(sanitizeVoiceText(parsed.speech)),
      );
      if (displayText && speechText && hasJapaneseKana(speechText)) {
        return { displayText, speechText };
      }
    } catch (_) {
      // A repair pass below gets one chance to turn malformed output into JSON.
    }
  }
  if (!allowPlain) return null;
  const displayText = capVoiceText(sanitizeVoiceText(candidate));
  const speechText = capVoiceText(normalizeSpeechPronunciation(displayText));
  return displayText && hasJapaneseKana(speechText)
    ? { displayText, speechText }
    : null;
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

function voiceGenerationOptions(persona, { includeContext = true } = {}) {
  return {
    personaOverride: persona,
    maxReplyChars: VOICE_RAW_MAX_REPLY_CHARS,
    recordMemory: false,
    includeHistory: false,
    includeContext,
    includeEmojiPrompt: false,
    resolveEmojis: false,
  };
}

async function generateVoiceReply(generate, message, userText) {
  const firstReply = await generate(
    message,
    userText,
    voiceGenerationOptions(VOICE_PERSONA),
  );
  const firstPayload = parseVoicePayload(firstReply);
  if (firstPayload) return firstPayload;

  if (!firstReply) return "";
  console.warn(
    `[voice] retrying malformed voice payload len=${String(firstReply).length}`,
  );
  const repairInput = `次の返答を修正してください。\n<reply>${String(firstReply).slice(0, 500)}</reply>`;
  const repaired = await generate(
    message,
    repairInput,
    voiceGenerationOptions(VOICE_REPAIR_PERSONA, { includeContext: false }),
  );
  return parseVoicePayload(repaired, { allowPlain: true });
}

async function publishVoiceTranscript(interaction, displayText) {
  try {
    await interaction.editReply({
      content: displayText,
      allowedMentions: { parse: [] },
    });
    return true;
  } catch (error) {
    console.warn(`[voice] text send failed: ${error.message}`);
    return false;
  }
}

async function handleVoiceCommand(interaction, client, dependencies = {}) {
  const generate = dependencies.generateAIReply || generateAIReply;
  const tts = dependencies.synthesize || synthesize;
  const send = dependencies.sendVoiceMessage || sendVoiceMessage;
  const publishText = dependencies.publishVoiceTranscript || publishVoiceTranscript;
  const prewarm = dependencies.warmup || warmup;

  const userText = interaction.options.getString("message", true).trim();
  // Public acknowledgement makes the slash-command question visible to the
  // whole channel. The edited response becomes the display transcript.
  await interaction.deferReply();
  prewarm();

  const message = interactionAsMessage(interaction, client);
  const voiceReply = await generateVoiceReply(generate, message, userText);
  if (!voiceReply) {
    await interaction.editReply("語音台詞生成失敗了，請再試一次。");
    return false;
  }

  const { displayText, speechText } = voiceReply;
  const textSent = await publishText(interaction, displayText);
  if (!textSent) {
    await interaction.editReply("文字回覆送出失敗了，請再試一次。");
    return false;
  }

  const audio = await tts(speechText, { mood: "shy" });
  if (!audio) {
    await interaction.followUp({
      content: "語音服務暫時不可用，文字台詞已經送出。",
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  const sent = await send(client, interaction.channelId, audio);
  if (!sent) {
    await interaction.followUp({
      content: "語音訊息送出失敗，文字台詞已經送出。",
      flags: MessageFlags.Ephemeral,
    });
    return false;
  }

  return true;
}

module.exports = {
  VOICE_PERSONA,
  VOICE_REPAIR_PERSONA,
  sanitizeVoiceText,
  hasJapaneseKana,
  normalizeSpeechPronunciation,
  parseVoicePayload,
  interactionAsMessage,
  voiceGenerationOptions,
  generateVoiceReply,
  publishVoiceTranscript,
  handleVoiceCommand,
};
