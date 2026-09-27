const {
  VISION_ENABLED,
  VISION_MAX_IMAGES,
  VISION_MAX_BYTES,
  VISION_TOTAL_MAX_BYTES,
  VISION_FETCH_TIMEOUT_MS,
} = require("../config");

// DeepSeek's vision endpoint accepts exactly these four (api-docs.deepseek.com/guides/vision).
// Anything else (svg, bmp, heic, video thumbnails) is rejected server-side, so
// it never leaves here — an unsupported attachment must degrade to "西寶 看不到"
// rather than 400 the whole reply.
const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const EXT_TO_TYPE = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

// Discord usually sets contentType, but attachments uploaded by some clients
// (and every attachment on a message fetched through a partial) can arrive with
// it null. Filename extension is the only other signal we have.
function resolveImageType(attachment) {
  const declared = (attachment?.contentType || "").split(";")[0].trim().toLowerCase();
  if (SUPPORTED_IMAGE_TYPES.has(declared)) return declared;
  if (declared && declared.startsWith("image/")) return null; // known image, unsupported codec
  const ext = (attachment?.name || "").split(".").pop()?.toLowerCase();
  return EXT_TO_TYPE[ext] || null;
}

function collectFromMessage(message) {
  const attachments = message?.attachments;
  if (!attachments) return [];
  const list = typeof attachments.values === "function"
    ? [...attachments.values()]
    : Array.isArray(attachments)
      ? attachments
      : [];

  const images = [];
  for (const att of list) {
    const type = resolveImageType(att);
    if (!type) continue;
    // Size guard is about our own download + the request body, not about
    // DeepSeek's 32 MiB ceiling: the model bills the same for a 200 KB and a
    // 20 MB picture, but the big one costs a slow CDN fetch and 27 MB of
    // base64 in the request.
    if (Number.isFinite(att.size) && att.size > VISION_MAX_BYTES) {
      console.log(`[vision] skip oversized attachment name=${att.name} size=${att.size}`);
      continue;
    }
    if (!att.url) continue;
    images.push({ url: att.url, type, name: att.name, size: att.size });
    if (images.length >= VISION_MAX_IMAGES) break;
  }
  return images;
}

// Images 西寶 should look at: the ones on the message that @ed her, or — when
// she was @ed with no image of its own — the ones on the message being replied
// to. "@西寶 這張是什麼" as a reply to someone else's photo is the single most
// common way an image reaches her, and it carries no attachment itself.
function collectVisionImages(message, referencedMessage = null) {
  if (!VISION_ENABLED) return [];
  const own = collectFromMessage(message);
  if (own.length > 0) return own;
  return collectFromMessage(referencedMessage);
}

// Images are inlined as base64 data URLs rather than handed over as links.
// DeepSeek does accept an external URL — but it has to fetch it itself, and its
// fetcher returned "Failed to download image" on a plain public image URL in
// testing (2026-09-10). A Discord CDN link is signed and expiring on top of
// that, so the link path would fail in ways we could neither see nor retry.
// We already have the bytes a hop away; download them and send them.
async function fetchImageData(image) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(image.url, { signal: controller.signal });
    if (!response.ok) {
      console.warn(`[vision] download http ${response.status} name=${image.name}`);
      return null;
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > VISION_MAX_BYTES) {
      console.log(`[vision] skip oversized download name=${image.name} size=${declared}`);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    // Content-Length can lie or be absent; the buffer is the truth.
    if (buffer.length === 0 || buffer.length > VISION_MAX_BYTES) {
      console.log(`[vision] skip oversized body name=${image.name} size=${buffer.length}`);
      return null;
    }
    return { ...image, bytes: buffer.length, dataUrl: `data:${image.type};base64,${buffer.toString("base64")}` };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "timeout" : err.message;
    console.warn(`[vision] download failed name=${image.name}: ${reason}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Collect + download in one step. Returns only the images we actually hold the
// bytes for: an empty result means the chain gets no vision entry at all and
// 西寶 answers blind, which is strictly better than a 400 that costs her the
// whole reply.
async function loadVisionImages(message, referencedMessage = null) {
  const candidates = collectVisionImages(message, referencedMessage);
  if (candidates.length === 0) return [];

  const loaded = [];
  let total = 0;
  // Sequential on purpose: images are usually 1, and a parallel burst of 4
  // CDN downloads per mention is a bigger footgun than a few hundred ms.
  for (const candidate of candidates) {
    const image = await fetchImageData(candidate);
    if (!image) continue;
    if (total + image.bytes > VISION_TOTAL_MAX_BYTES) {
      console.log(`[vision] total budget reached, dropping ${candidates.length - loaded.length} image(s)`);
      break;
    }
    total += image.bytes;
    loaded.push(image);
  }
  if (loaded.length > 0) {
    console.log(`[vision] loaded ${loaded.length}/${candidates.length} image(s) bytes=${total}`);
  }
  return loaded;
}

const BLIND_NOTE_PREFIX = "（這則訊息附了";

// The note is written for the BLIND case because the turn is shared: every
// provider below the vision entry gets these exact bytes, and a model told
// nothing about the attachment will happily invent what is in it. The vision
// entry swaps the note out in `attachImagesToTurns` right before the call.
function buildImageNote(count) {
  if (count <= 0) return "";
  return `\n${BLIND_NOTE_PREFIX} ${count} 張圖片，但你這次看不到內容——不要假裝看得到，可以說你看不到或問對方。）`;
}

function buildSeeingNote(count) {
  return `\n${BLIND_NOTE_PREFIX} ${count} 張圖片，內容就在下面，直接看圖回話。）`;
}

function replaceImageNote(text, count) {
  const idx = text.lastIndexOf(BLIND_NOTE_PREFIX);
  if (idx < 0) return text;
  return text.slice(0, idx).replace(/\n$/, "") + buildSeeingNote(count);
}

// Turn the last user turn into OpenAI-compatible multimodal content:
//   [{type:"text", ...}, {type:"image_url", image_url:{url}}, ...]
// Only the LAST user turn gets images — earlier turns are conversation history
// whose images (if any) have already been described in her own reply, and
// re-sending them would re-bill every image on every subsequent turn.
function attachImagesToTurns(turns, images) {
  if (!Array.isArray(images) || images.length === 0) return turns;
  let idx = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.role === "user") {
      idx = i;
      break;
    }
  }
  if (idx < 0) return turns;

  const original = turns[idx];
  if (typeof original.content !== "string") return turns;
  const content = [
    { type: "text", text: replaceImageNote(original.content, images.length) },
    ...images.map((img) => ({
      type: "image_url",
      image_url: { url: img.dataUrl || img.url },
    })),
  ];
  return turns.map((t, i) => (i === idx ? { ...t, content } : t));
}

module.exports = {
  SUPPORTED_IMAGE_TYPES,
  resolveImageType,
  collectFromMessage,
  collectVisionImages,
  fetchImageData,
  loadVisionImages,
  buildImageNote,
  attachImagesToTurns,
};
