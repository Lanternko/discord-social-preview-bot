const { FIXER_BILIBILI, BILIBILI_EMOJI } = require("../config");
const {
  extractBilibiliBvid,
  normalizeUrl,
  replaceHostFixer,
} = require("../url-routing");
const { buildBilibiliEmbed } = require("../embeds");
const { trimDescription } = require("../utils");

// The info bar shown ABOVE an uploaded Bilibili video (message content, not an
// embed): optional Bilibili mark + clickable title, the caption, then a small
// author/source subtext. Content renders above attachments, so the info sits
// on top of the player — with a real cover-less layout, no embed box.
function buildBilibiliVideoCaption(url, metadata) {
  const mark = BILIBILI_EMOJI ? `${BILIBILI_EMOJI} ` : "";
  // Strip ] and [ from the link text so they can't break the masked link.
  const title = trimDescription(metadata.title || "Bilibili 影片", 200).replace(
    /[[\]]/g,
    "",
  );
  const lines = [`${mark}**[${title}](${url})**`];
  if (metadata.description) lines.push(trimDescription(metadata.description, 200));
  lines.push(`-# ${metadata.author ? `${metadata.author} · ` : ""}Bilibili`);
  return lines.join("\n");
}

async function fetchBilibiliMetadata(url) {
  const bvid = extractBilibiliBvid(url);
  if (!bvid) {
    throw new Error("Could not extract Bilibili BVID");
  }

  const response = await fetch(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.bilibili.com/",
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Bilibili API returned ${response.status}`);
  }

  const payload = await response.json();
  if (payload.code !== 0 || !payload.data) {
    throw new Error(`Bilibili API error ${payload.code ?? "unknown"}`);
  }

  return {
    title: payload.data.title || "Bilibili Video",
    description: payload.data.desc || null,
    image: payload.data.pic?.replace(/^http:\/\//i, "https://") || null,
    author: payload.data.owner?.name || null,
  };
}

async function buildBilibiliFallbackUrl(url) {
  const parsed = new URL(url);

  if (parsed.hostname !== "b23.tv") {
    return replaceHostFixer(url, FIXER_BILIBILI);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const finalUrl = normalizeUrl(response.url || url);
    const finalParsed = new URL(finalUrl);
    if (
      finalParsed.hostname === "www.bilibili.com" ||
      finalParsed.hostname === "bilibili.com"
    ) {
      return replaceHostFixer(finalUrl, FIXER_BILIBILI);
    }
  } catch (error) {
    console.warn(
      `Could not expand b23.tv short link for ${url}:`,
      error.message,
    );
  } finally {
    clearTimeout(timeout);
  }

  return replaceHostFixer(url, FIXER_BILIBILI);
}

async function buildBilibiliPayload(url) {
  const fixerUrl = await buildBilibiliFallbackUrl(url);
  // The API path uses BVID directly, so b23.tv short links must be expanded
  // before we can hit it. `buildBilibiliFallbackUrl` already follows the
  // redirect; reuse its expanded URL here.
  const targetUrl =
    new URL(url).hostname === "b23.tv"
      ? fixerUrl.replace(
          new RegExp(`^https?://${FIXER_BILIBILI}`),
          "https://www.bilibili.com",
        )
      : url;

  try {
    const metadata = await fetchBilibiliMetadata(targetUrl);
    if (metadata.title) {
      // vxbilibili serves a direct, playable mp4 at media.<host>/video/<bvid>/1
      // (verified: 200 video/mp4, no auth token — the ?_= query is a cache-buster
      // only). Hand it to discord-io as a `videoAttachment` so the API embed
      // (title / UP 主 / cover) gets a real uploaded player below it, MIXED-style.
      const bvid = extractBilibiliBvid(targetUrl);
      const videoAttachment = bvid
        ? `https://media.${FIXER_BILIBILI}/video/${bvid}/1`
        : undefined;
      // The expanded b23.tv URL drags a wall of share-tracking params
      // (buvid/mid/plat_id/…) into the fixer URL. When the BVID is known,
      // post the minimal canonical form instead — same unfurl, readable text.
      const cleanFixerUrl = bvid
        ? `https://${FIXER_BILIBILI}/video/${bvid}`
        : fixerUrl;
      console.log(
        `[preview] bilibili-api-embed ${url} title=${metadata.title.slice(0, 32)} video=${Boolean(videoAttachment)}`,
      );
      return {
        // `embeds` (with cover) is what shows if there's no video to attach.
        embeds: [buildBilibiliEmbed(url, metadata)],
        ...(videoAttachment
          ? {
              videoAttachment,
              // When the upload succeeds, discord-io drops the embed and shows
              // this info bar as message content ABOVE the player — clickable
              // title + Bilibili mark, no duplicate cover, no embed box.
              videoAttachmentContent: buildBilibiliVideoCaption(url, metadata),
              // When the upload MISSES (too big / disabled / at capacity /
              // fetch fail), fall back to the fixer link instead of the cover:
              // Discord unfurls vxbilibili's og:video by STREAMING the remote
              // mp4 — no upload, so the 25 MiB guild cap doesn't apply and even
              // a 55 MB video still gets a native player. If that unfurl comes
              // up empty, the empty-embed pipeline restores the cover embed
              // (embedFallback), then OG recovery.
              videoAttachmentMissContent: cleanFixerUrl,
              embedFallback: { embeds: [buildBilibiliEmbed(url, metadata)] },
              recoverUrls: [cleanFixerUrl],
              recoverEmbedOptions: {
                color: 0x00a1d6,
                footerText: "Bilibili · 預覽降級",
              },
              sourceUrl: url,
            }
          : {}),
      };
    }
  } catch (error) {
    console.warn(`[preview] bilibili API failed for ${url}: ${error.message}`);
  }

  console.log(`[preview] bilibili-fixer ${url} -> ${fixerUrl}`);
  return {
    content: fixerUrl,
    recoverUrls: [fixerUrl],
    recoverEmbedOptions: { color: 0x00a1d6, footerText: "Bilibili · 預覽降級" },
    sourceUrl: url,
  };
}

module.exports = {
  fetchBilibiliMetadata,
  buildBilibiliFallbackUrl,
  buildBilibiliPayload,
};
