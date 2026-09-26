// Pinterest —— 走官方 widget 用的公開 JSON（pidgets），不開 chromium。
//
// WHY 不用頁面 og tag：pin 頁的 og:title/og:url 常常是「相關 pin」的，不是你貼的
// 那一則（實測 2026-09：貼 99360735500167749，og:url 指到另一個 pin）。pidgets
// 用 pin id 直接查，描述、上傳者、圖、影片直鏈都是欄位，而且不需登入。
//
// 影片：`is_video` 不可靠（有 true 但沒影片、也有 false 但帶影片的），一律看
// `videos.video_list.V_720P` 有沒有 mp4。有就交給 discord-io 下載上傳。
//
// 任何一步失敗都退 fixembed + OG recovery（pin 頁本身有 og:image，至少有圖）。

const { buildPinterestEmbed } = require("../embeds");
const { buildFallbackUrl, isPinterestShortHost } = require("../url-routing");
const { trimDescription } = require("../utils");

const PIDGETS_ENDPOINT = "https://widgets.pinterest.com/v3/pidgets/pins/info/";
const TIMEOUT_MS = 6000;
const RECOVER_PROFILE = { color: 0xe60023, footerText: "Pinterest · 預覽降級" };

// /pin/123/ 或 /pin/some-slug--123/（slug 版 id 在最後的 `--` 之後）。
function extractPinId(url) {
  const match = new URL(url).pathname.match(/^\/pin\/(?:[^/]*--)?(\d{5,})\/?/);
  return match?.[1] || null;
}

// pin.it 短網址 → 跟著 redirect 拿到 /pin/<id>/。失效的短網址會落在首頁，
// 那種回 null。
async function resolvePinUrl(url) {
  if (!isPinterestShortHost(new URL(url).hostname)) return url;
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  return extractPinId(response.url) ? response.url : null;
}

function pickImage(images) {
  if (!images) return null;
  // 564x 是 pidgets 給的最大尺寸；736x 大多存在但不保證，不去猜。
  return (
    images["564x"]?.url || images["237x"]?.url || images["236x"]?.url || null
  );
}

async function fetchPinterestMetadata(pinId) {
  const response = await fetch(
    `${PIDGETS_ENDPOINT}?pin_ids=${encodeURIComponent(pinId)}`,
    { signal: AbortSignal.timeout(TIMEOUT_MS) },
  );
  if (!response.ok) throw new Error(`pidgets ${response.status}`);
  const payload = await response.json();
  const pin = payload?.data?.[0];
  if (!pin) throw new Error("pidgets empty");

  const description = pin.description?.trim() || null;
  return {
    title:
      pin.rich_metadata?.title?.trim() ||
      pin.attribution?.title?.trim() ||
      null,
    description,
    author: pin.pinner?.full_name || null,
    authorUrl: pin.pinner?.profile_url || null,
    image: pickImage(pin.images),
    video: pin.videos?.video_list?.V_720P?.url || null,
  };
}

async function buildPinterestPayload(url) {
  const fallbackUrl = buildFallbackUrl(url);
  const fallback = {
    content: fallbackUrl,
    recoverUrls: [fallbackUrl, url],
    recoverEmbedOptions: RECOVER_PROFILE,
    sourceUrl: url,
  };

  try {
    const pinUrl = await resolvePinUrl(url);
    const pinId = pinUrl && extractPinId(pinUrl);
    if (!pinId) {
      console.log(`[pinterest] not a pin ${url} → fixer`);
      return fallback;
    }
    const meta = await fetchPinterestMetadata(pinId);
    if (!meta.image && !meta.video) throw new Error("no media");
    const canonical = `https://www.pinterest.com/pin/${pinId}/`;

    console.log(
      `[pinterest] custom ${url} video=${Boolean(meta.video)} title=${trimDescription(meta.title || meta.description || "", 32)}`,
    );
    const embed = buildPinterestEmbed(canonical, meta);
    if (!meta.video) return { embeds: [embed] };
    return {
      // 上傳不成就留有封面的卡；成功就換成不帶封面的卡，免得封面跟影片重複。
      embeds: [embed],
      videoAttachment: meta.video,
      videoAttachmentEmbeds: [
        buildPinterestEmbed(canonical, { ...meta, image: null }),
      ],
      sourceUrl: url,
    };
  } catch (error) {
    console.warn(`[pinterest] miss ${url} reason=${error.message} → fixer`);
    return fallback;
  }
}

module.exports = { buildPinterestPayload, extractPinId, fetchPinterestMetadata };
