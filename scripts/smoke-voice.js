#!/usr/bin/env node
const assert = require("node:assert/strict");

process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN || "smoke-dummy";

const {
  VOICE_PERSONA,
  VOICE_REPAIR_PERSONA,
  sanitizeVoiceText,
  hasJapaneseKana,
  normalizeSpeechPronunciation,
  parseVoicePayload,
  interactionAsMessage,
  voiceGenerationOptions,
  publishVoiceTranscript,
  handleVoiceCommand,
} = require("../src/voice-reply");
const {
  MESSAGE_FLAG_IS_VOICE_MESSAGE,
  sendVoiceMessage,
} = require("../src/voice-message");
const { postTts } = require("../src/tts-client");
const { VOICE_COMMAND } = require("../src/commands");

let passed = 0;
let failed = 0;
async function it(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

function makeInteraction(text = "今天過得怎麼樣？") {
  const edits = [];
  const deferred = [];
  const followUps = [];
  return {
    id: "interaction-1",
    guildId: "guild-1",
    channelId: "channel-1",
    guild: { id: "guild-1", name: "測試群" },
    channel: { id: "channel-1", send: async () => {} },
    user: { id: "user-1", username: "測試者" },
    member: { displayName: "小測" },
    createdTimestamp: 1234,
    options: { getString: () => text },
    deferReply: async (payload) => deferred.push(payload),
    editReply: async (payload) => edits.push(payload),
    followUp: async (payload) => followUps.push(payload),
    edits,
    deferred,
    followUps,
  };
}

async function main() {
  console.log("voice prompt and sanitizer");
  await it("uses a standalone Japanese spoken persona", () => {
    assert.match(VOICE_PERSONA, /自然な話し言葉の日本語だけ/);
    assert.match(VOICE_PERSONA, /西奈津美/);
    assert.match(VOICE_PERSONA, /質問そのものに直接答えて/);
    assert.match(VOICE_PERSONA, /相手の記憶、親しさ、グループの記憶、最近の会話/);
    assert.match(VOICE_PERSONA, /JSON の display/);
    assert.match(VOICE_PERSONA, /JSON の speech/);
    assert.doesNotMatch(VOICE_PERSONA, /繁體中文/);
    assert.match(VOICE_REPAIR_PERSONA, /日本語音声台本の校正者/);
  });
  await it("keeps voice generation out of text history and memory", () => {
    const options = voiceGenerationOptions(VOICE_PERSONA);
    assert.equal(options.personaOverride, VOICE_PERSONA);
    assert.equal(options.includeHistory, false);
    assert.equal(options.recordMemory, false);
    assert.equal(options.includeContext, true);
  });
  await it("strips markup, URLs and emoji before TTS", () => {
    assert.equal(
      sanitizeVoiceText("**うん** https://example.com :xibao: 😳 `大丈夫`。"),
      "うん 大丈夫。",
    );
  });
  await it("accepts kana and rejects Chinese-only text", () => {
    assert.equal(hasJapaneseKana("今日は大丈夫だよ。"), true);
    assert.equal(hasJapaneseKana("今天很好。"), false);
  });
  await it("keeps display spelling but normalizes known TTS pronunciations", () => {
    const parsed = parseVoicePayload(JSON.stringify({
      display: "ROSELIAも好きだけど、摳捷くんが特別かも。",
      speech: "ROSELIAも好きだけど、摳捷くんが特別かも。",
    }));
    assert.equal(parsed.displayText, "ROSELIAも好きだけど、摳捷くんが特別かも。");
    assert.equal(parsed.speechText, "ロゼリアも好きだけど、コジェックくんが特別かも。");
    assert.equal(normalizeSpeechPronunciation("RoseliaとKojek"), "ロゼリアとコジェック");
  });

  console.log("slash command flow");
  await it("registers /voice with one required message option", () => {
    assert.equal(VOICE_COMMAND.name, "voice");
    assert.equal(VOICE_COMMAND.options[0].name, "message");
    assert.equal(VOICE_COMMAND.options[0].required, true);
  });
  await it("maps an interaction to the existing AI message context", () => {
    const interaction = makeInteraction();
    const client = { user: { id: "bot-1" } };
    const message = interactionAsMessage(interaction, client);
    assert.equal(message.author.id, "user-1");
    assert.equal(message.channelId, "channel-1");
    assert.equal(message.client, client);
  });
  await it("sends voice and keeps the text-memory path disabled", async () => {
    const interaction = makeInteraction();
    const client = { rest: {} };
    let aiOptions;
    let ttsText;
    const events = [];
    const result = await handleVoiceCommand(interaction, client, {
      warmup: () => {},
      generateAIReply: async (_message, _text, options) => {
        aiOptions = options;
        return JSON.stringify({
          display: "うん、今日はちょっと嬉しかった。",
          speech: "うん、今日はちょっと嬉しかった。",
        });
      },
      synthesize: async (text) => {
        events.push("tts");
        ttsText = text;
        return { ogg: Buffer.from("ogg"), durationSecs: 1, waveform: "AA==" };
      },
      publishVoiceTranscript: async (target, text) => {
        events.push(`text:${text}`);
        await target.editReply({ content: text, allowedMentions: { parse: [] } });
        return true;
      },
      sendVoiceMessage: async () => {
        events.push("voice");
        return true;
      },
    });
    assert.equal(result, true);
    assert.equal(aiOptions.personaOverride, VOICE_PERSONA);
    assert.equal(aiOptions.includeHistory, false);
    assert.equal(aiOptions.recordMemory, false);
    assert.equal(aiOptions.includeEmojiPrompt, false);
    assert.equal(ttsText, "うん、今日はちょっと嬉しかった。");
    assert.deepEqual(events, [
      "text:うん、今日はちょっと嬉しかった。",
      "tts",
      "voice",
    ]);
    assert.deepEqual(interaction.deferred, [undefined]);
    assert.equal(interaction.edits.length, 1);
    assert.equal(interaction.edits[0].content, "うん、今日はちょっと嬉しかった。");
    assert.equal(interaction.followUps.length, 0);
  });
  await it("falls back to the transcript when TTS is unavailable", async () => {
    const interaction = makeInteraction();
    const result = await handleVoiceCommand(interaction, {}, {
      warmup: () => {},
      generateAIReply: async () => JSON.stringify({
        display: "少し緊張するけど、話せて嬉しい。",
        speech: "少し緊張するけど、話せて嬉しい。",
      }),
      publishVoiceTranscript: async () => true,
      synthesize: async () => null,
      sendVoiceMessage: async () => {
        throw new Error("must not send");
      },
    });
    assert.equal(result, false);
    assert.match(interaction.followUps[0].content, /語音服務暫時不可用/);
    assert.match(interaction.followUps[0].content, /文字台詞已經送出/);
  });
  await it("repairs Chinese output once before sending it to TTS", async () => {
    const interaction = makeInteraction();
    const calls = [];
    let ttsText = "";
    const result = await handleVoiceCommand(interaction, {}, {
      warmup: () => {},
      generateAIReply: async (_message, text, options) => {
        calls.push({ text, options });
        return calls.length === 1
          ? "今天很好。"
          : JSON.stringify({
            display: "今日はちょっと嬉しかったよ。",
            speech: "今日はちょっと嬉しかったよ。",
          });
      },
      synthesize: async (text) => {
        ttsText = text;
        return { ogg: Buffer.from("ogg"), durationSecs: 1, waveform: "AA==" };
      },
      publishVoiceTranscript: async () => true,
      sendVoiceMessage: async () => true,
    });
    assert.equal(result, true);
    assert.equal(calls.length, 2);
    assert.match(calls[1].text, /今天很好/);
    assert.equal(calls[1].options.personaOverride, VOICE_REPAIR_PERSONA);
    assert.equal(calls[1].options.includeContext, false);
    assert.equal(ttsText, "今日はちょっと嬉しかったよ。");
  });
  await it("does not send output that remains Chinese after one repair", async () => {
    const interaction = makeInteraction();
    let called = false;
    let generations = 0;
    await handleVoiceCommand(interaction, {}, {
      warmup: () => {},
      generateAIReply: async () => {
        generations += 1;
        return "今天很好。";
      },
      synthesize: async () => {
        called = true;
      },
    });
    assert.equal(generations, 2);
    assert.equal(called, false);
    assert.equal(interaction.edits[0], "語音台詞生成失敗了，請再試一次。");
  });

  await it("publishes the interaction transcript without allowing mentions", async () => {
    let payload;
    const ok = await publishVoiceTranscript(
      { editReply: async (value) => { payload = value; } },
      "今日は大丈夫だよ。",
    );
    assert.equal(ok, true);
    assert.equal(payload.content, "今日は大丈夫だよ。");
    assert.deepEqual(payload.allowedMentions, { parse: [] });
  });

  console.log("TTS and Discord transport");
  await it("parses the Irodori TTS response contract", async () => {
    const fetchImpl = async (_url, request) => {
      assert.deepEqual(JSON.parse(request.body), { text: "こんにちは" });
      return {
        ok: true,
        headers: new Headers({ "x-duration-secs": "1.25", "x-waveform": "AQI=" }),
        arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
      };
    };
    const audio = await postTts({ text: "こんにちは" }, fetchImpl);
    assert.equal(audio.durationSecs, 1.25);
    assert.equal(audio.waveform, "AQI=");
    assert.deepEqual([...audio.ogg], [1, 2, 3]);
  });
  await it("uses Discord's voice-message flag and attachment metadata", async () => {
    let route;
    let payload;
    const client = {
      rest: { post: async (r, p) => { route = r; payload = p; } },
    };
    const ok = await sendVoiceMessage(client, "channel-1", {
      ogg: Buffer.from([1]), durationSecs: 2.5, waveform: "AQ==",
    });
    assert.equal(ok, true);
    assert.equal(route, "/channels/channel-1/messages");
    assert.equal(payload.body.flags, MESSAGE_FLAG_IS_VOICE_MESSAGE);
    assert.equal(payload.body.attachments[0].duration_secs, 2.5);
    assert.equal(payload.files[0].contentType, "audio/ogg");
  });

  console.log(`\nvoice smoke: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

main();
