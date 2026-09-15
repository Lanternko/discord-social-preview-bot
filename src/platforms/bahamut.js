const { fetchPageProbeMetadata } = require("../probe");
const { buildBahamutEmbed } = require("../embeds");
const { buildFallbackUrl } = require("../url-routing");
const {
  getBahamutSessionCookies,
  toProbeCookies,
} = require("../bahamut-session");

const RESTRICTED_NOTICE = "（內容需登入巴哈姆特才能看完整貼文）";

// 未登入抓場外，巴哈回的是「兒少保護警示」頁：title 是警示、og:description 是
// 「您將進入的頁面，有不適合兒少瀏覽的內容…」。那是牆，不是文章摘要。
function isChildProtectionWall(metadata) {
  return Boolean(
    metadata?.title?.includes("兒少保護") ||
      metadata?.description?.startsWith("您將進入的頁面"),
  );
}

function hasUsableMetadata(metadata) {
  if (isChildProtectionWall(metadata)) return false;
  return Boolean(metadata?.title || metadata?.description);
}

async function probeWithSession(url, cookies) {
  return fetchPageProbeMetadata(
    url,
    cookies ? { cookies: toProbeCookies(cookies) } : undefined,
  );
}

// 有設巴哈帳號就帶登入 cookie 去 probe（ermiana 的做法）。登入後仍被牆 → 可能是
// session 過期，強制重登再試一次；還是牆就是帳號本身沒資格（未滿 15 / 沒手機
// 認證 / 沒開顯示敏感內容），照未登入的流程走。
async function fetchBahamutMetadata(url) {
  const cookies = await getBahamutSessionCookies();
  const metadata = await probeWithSession(url, cookies);
  if (!metadata.restricted || !cookies) return metadata;

  const refreshed = await getBahamutSessionCookies({ force: true });
  const retried =
    refreshed && refreshed !== cookies
      ? await probeWithSession(url, refreshed)
      : metadata;
  if (retried.restricted) {
    console.warn(
      `[baha-session] still walled while logged in — account needs 手機認證 + 顯示敏感內容 ${url}`,
    );
  }
  return retried;
}

// og:image is whatever the site advertises — for a post built around a YouTube
// embed that's a still thumbnail, and for a post built around a GIF it's
// nothing. The picture the author actually put in the article is the better
// preview (and a GIF keeps animating inside an embed), so it wins when present.
//
// A text-only post has no picture of its own, and its og:image is just the
// site-wide Bahamut logo — a big orange card that says nothing about the post.
// Show no image rather than that.
const SITE_DEFAULT_IMAGE = /\/bahaLOGO[^/]*\.(?:jpe?g|png)$/i;

function withArticleMedia(metadata) {
  const articleImage = metadata.images?.[0];
  if (articleImage) return { ...metadata, image: articleImage };
  if (SITE_DEFAULT_IMAGE.test(metadata.image || "")) {
    return { ...metadata, image: null };
  }
  return metadata;
}

// A bot-built embed can't hold a player, so the only way to make the article's
// video playable in Discord is to let Discord unfurl the video URL itself:
// send it as message content alongside our embed. Content that isn't unfurled
// still reads as a plain clickable link, so this can't leave the preview worse
// off than the embed alone.
function withVideoContent(payload, metadata) {
  const videoUrl = metadata.videoUrls?.[0];
  if (!videoUrl) return payload;
  console.log(`[preview] bahamut-video ${videoUrl}`);
  return { ...payload, content: videoUrl };
}

async function buildBahamutPayload(url) {
  try {
    const metadata = await fetchBahamutMetadata(url);
    if (metadata.restricted) {
      // Even a restricted page often returns a public title / og:description
      // that's enough to let the user decide whether to log in. Surface that
      // instead of dropping straight to a fixer URL.
      if (hasUsableMetadata(metadata)) {
        const noticed = {
          ...metadata,
          description: metadata.description
            ? `${metadata.description}\n\n${RESTRICTED_NOTICE}`
            : RESTRICTED_NOTICE,
        };
        console.log(`[preview] bahamut-restricted-summary ${url}`);
        return { embeds: [buildBahamutEmbed(url, noticed)] };
      }
      console.log(`[preview] bahamut-restricted fallback ${url}`);
      return { content: buildFallbackUrl(url), sourceUrl: url };
    }
    console.log(`[preview] bahamut-custom ${url}`);
    const enriched = withArticleMedia(metadata);
    return withVideoContent(
      { embeds: [buildBahamutEmbed(url, enriched)] },
      metadata,
    );
  } catch (error) {
    console.warn(`Could not fetch Bahamut metadata for ${url}:`, error.message);
  }

  console.log(`[preview] bahamut fallback ${url}`);
  return {
    content: buildFallbackUrl(url),
    sourceUrl: url,
    recoverUrls: [buildFallbackUrl(url), url],
    recoverEmbedOptions: { color: 0xf08c2e, footerText: "巴哈姆特 · 預覽降級" },
  };
}

module.exports = { buildBahamutPayload };
