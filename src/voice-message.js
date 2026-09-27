const MESSAGE_FLAG_IS_VOICE_MESSAGE = 1 << 13;

async function sendVoiceMessage(client, channelId, audio) {
  if (!audio?.ogg?.length) return false;
  const filename = "xibao-voice.ogg";
  try {
    await client.rest.post(`/channels/${channelId}/messages`, {
      files: [{ name: filename, data: audio.ogg, contentType: "audio/ogg" }],
      body: {
        flags: MESSAGE_FLAG_IS_VOICE_MESSAGE,
        attachments: [{
          id: 0,
          filename,
          duration_secs: audio.durationSecs,
          waveform: audio.waveform,
        }],
      },
    });
    console.log(
      `[voice] sent channel=${channelId} dur=${audio.durationSecs}s bytes=${audio.ogg.length}`,
    );
    return true;
  } catch (error) {
    console.warn(`[voice] send failed channel=${channelId}: ${error.message}`);
    return false;
  }
}

module.exports = { MESSAGE_FLAG_IS_VOICE_MESSAGE, sendVoiceMessage };
