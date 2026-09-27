const {
  TTS_SERVER_URL,
  TTS_REQUEST_TIMEOUT_MS,
  TTS_DEFAULT_REF_ID,
} = require("./config");

async function postTts(body, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TTS_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${TTS_SERVER_URL}/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn(`[tts] server http ${response.status}: ${detail.slice(0, 200)}`);
      return null;
    }

    const ogg = Buffer.from(await response.arrayBuffer());
    if (ogg.length === 0) {
      console.warn("[tts] server returned empty audio");
      return null;
    }
    return {
      ogg,
      durationSecs: Number(response.headers.get("x-duration-secs")) || 0,
      waveform: response.headers.get("x-waveform") || "",
    };
  } catch (error) {
    const reason = error?.name === "AbortError"
      ? `timed out after ${TTS_REQUEST_TIMEOUT_MS}ms`
      : error.message;
    console.warn(`[tts] server request failed: ${reason}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function synthesize(text, options = {}) {
  const body = { text, mood: options.mood || "shy" };
  const refId = options.refId || TTS_DEFAULT_REF_ID;
  if (refId) body.ref_id = refId;
  return postTts(body, options.fetchImpl);
}

function warmup(fetchImpl = fetch) {
  fetchImpl(`${TTS_SERVER_URL}/warmup`, {
    method: "POST",
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

module.exports = { postTts, synthesize, warmup };
