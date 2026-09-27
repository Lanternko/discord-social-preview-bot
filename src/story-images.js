const {
  DEEPSEEK_API_KEY,
  DEEPSEEK_VISION_MODEL,
  VISION_ENABLED,
  VISION_TIMEOUT_MS,
  STORY_IMAGE_MAX,
} = require("./config");
const { callDeepSeek } = require("./ai/providers");
const { fetchImageData } = require("./ai/vision");

// Bedtime-story ingredients that are pictures get turned into one line of text
// BEFORE the story is written. The story model (v4-pro) is blind, and a caption
// keeps it that way: one cheap flash-vision call per picture, then the picture
// is just another line in the buffet (「貼了一張圖：…」).
const CAPTION_PROMPT = [
  "（系統提示：這是群友今天在聊天室貼的一張圖，要拿來當睡前故事的素材。",
  "用一到兩句話告訴沒看到圖的人：畫面上是什麼、哪裡好笑或值得注意。圖上有字就原樣抄出來。",
  "60 字以內，只描述，不要評論、不要加語氣詞、不要用你的人設說話。）",
].join("\n");

const CAPTION_MAX_TOKENS = 200;

function captionTurn(item) {
  const said = item.preview ? `\n貼圖的人同時說：「${item.preview}」` : "";
  return [{ role: "user", content: `${CAPTION_PROMPT}${said}` }];
}

async function describeImage(item, deps) {
  const image = await deps.fetchImage(item.images[0]);
  if (!image) return "";
  const result = await deps.callVision(captionTurn(item), "", CAPTION_MAX_TOKENS, {
    model: DEEPSEEK_VISION_MODEL,
    images: [image],
    label: `deepseek:${DEEPSEEK_VISION_MODEL}:story-image`,
    timeoutMs: VISION_TIMEOUT_MS,
    thinking: { type: "disabled" },
    reasoningHeadroom: 0,
  });
  if (!result?.ok) return "";
  return result.text.replace(/\s+/g, " ").trim().slice(0, 120);
}

// Mutates each picked ingredient's `imageCaption`. Sequential and capped at
// STORY_IMAGE_MAX: this runs once a night per guild, a burst of parallel CDN
// downloads buys nothing. A failed caption leaves the ingredient text-only (or,
// for an image-only message, drops it from the buffet).
async function describeStoryImages(ingredients, deps = {}) {
  const enabled = deps.enabled ?? (VISION_ENABLED && DEEPSEEK_API_KEY && DEEPSEEK_VISION_MODEL);
  if (!enabled) return 0;
  const resolved = {
    fetchImage: deps.fetchImage || fetchImageData,
    callVision: deps.callVision || callDeepSeek,
  };
  const max = deps.max ?? STORY_IMAGE_MAX;
  const picked = ingredients.filter((item) => item.images?.length > 0).slice(0, max);
  let described = 0;
  for (const item of picked) {
    try {
      const caption = await describeImage(item, resolved);
      if (caption) {
        item.imageCaption = caption;
        described += 1;
      }
    } catch (err) {
      console.warn(`[bedtime-story] image caption failed: ${err.message}`);
    }
  }
  if (picked.length > 0) {
    console.log(`[bedtime-story] images described=${described}/${picked.length}`);
  }
  return described;
}

module.exports = { describeStoryImages, CAPTION_PROMPT };
