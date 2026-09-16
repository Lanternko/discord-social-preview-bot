// 巴哈姆特純 fetch 快路徑 —— `fetchBahamutMetadata` 在退回 Playwright probe
// 之前先試這條。
//
// WHY：和 PTT 同一個理由（見 ptt-fetch.js）——forum.gamer.com.tw 的文章頁是
// server-rendered，`.c-article__content`、作者區塊、og:* 在第一份 response 裡
// 就齊了。PTT 快路徑上線後，巴哈就是剩下的 chromium 大戶。
//
// 解析刻意對齊 `threads-probe.cjs` 的 `readBahamutMetadata`：同一組選擇器、同一
// 個欄位優先序、同一套 trimText，讓 `buildBahamutEmbed` / `withArticleMedia` /
// `withVideoContent` 不必知道 metadata 是誰抓的。
//
// 唯一無法等價的是 probe 那個「用 getBoundingClientRect 找 ≥160px 圖」的墊底
// image——那需要 layout。它排在 og:image 與 thumbnail 之後，而巴哈的文章頁一定
// 帶 og:image（沒自己的圖時是站徽，bahamut.js 的 SITE_DEFAULT_IMAGE 會濾掉），
// 所以實務上輪不到它；真的兩個 meta 都沒有時就當 miss 交還 probe，而不是默默
// 端出一張沒有圖的預覽。
//
// 任何 miss 都回 null（絕不 throw）→ 呼叫端照舊開 probe。

const {
  htmlToText,
  extractElementHtml,
  extractElementText,
  extractMeta,
  extractTitleTag,
  trimText,
} = require("./html-text");

const DEFAULT_TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 4 * 1024 * 1024; // 巴哈整頁（含回覆）比 PTT 大，實測 ~220KB。

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

const BAHAMUT_HOSTS = new Set(["forum.gamer.com.tw", "m.gamer.com.tw"]);

function isBahamutHost(url) {
  try {
    return BAHAMUT_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

// og:title 是分頁標題「<標題> @<板名> 哈啦板 - 巴哈姆特」。footer 已經寫了
// 巴哈姆特，那條尾巴只會讓標題多折一行。要求站名後綴存在才砍，免得誤傷真的
// 以「@某某」結尾的標題。（與 probe 的 stripSiteSuffix 同規則）
function stripSiteSuffix(title) {
  if (!title) return null;
  const trimmed = title
    .replace(/\s*@[^@]{1,80}?[-–—]\s*巴哈姆特\s*$/, "")
    .replace(/\s*[-–—]\s*巴哈姆特\s*$/, "")
    .trim();
  return trimmed || title;
}

// 標頭是一整塊 chrome（樓主 / 暱稱 / 自訂頭銜 / 帳號 / GP / BP），只留能認出
// 發文者的兩個欄位。
function extractAuthor(html) {
  const headerHtml = extractElementHtml(html, "c-post__header__author");
  if (!headerHtml) return null;
  const username = extractElementText(headerHtml, "username", "a");
  const userid = extractElementText(headerHtml, "userid", "a");
  if (username && userid && username !== userid) return `${username} (${userid})`;
  return username || userid || null;
}

// 文章自己的圖永遠進不了 og:*（YouTube 貼文的 og:image 是影片縮圖，梗圖 GIF 的
// 貼文甚至什麼都不給），所以直接從文章區塊撈。表情符號與頭像是 chrome 不是內容。
function extractArticleImages(articleHtml) {
  if (!articleHtml) return [];
  const images = [];
  const re = /<img\b[^>]*>/gi;
  let match;
  while ((match = re.exec(articleHtml)) !== null) {
    const tag = match[0];
    const src = (
      tag.match(/\bdata-src=["']([^"']*)["']/i)?.[1] ||
      tag.match(/\bsrc=["']([^"']*)["']/i)?.[1] ||
      ""
    ).trim();
    if (!/^https?:\/\//.test(src)) continue;
    if (/\/(?:emotion|avatar)\//i.test(src)) continue;
    images.push(src);
  }
  return images;
}

// bot 做的 embed 塞不了播放器，所以把 YouTube 網址交給 Discord 自己 unfurl。
function extractVideoUrls(articleHtml) {
  if (!articleHtml) return [];
  const ids = new Set();
  const re = /<iframe\b[^>]*>/gi;
  let match;
  while ((match = re.exec(articleHtml)) !== null) {
    const tag = match[0];
    const src =
      tag.match(/\bsrc=["']([^"']*)["']/i)?.[1] ||
      tag.match(/\bdata-src=["']([^"']*)["']/i)?.[1] ||
      "";
    const id = src.match(
      /(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{6,20})/,
    )?.[1];
    if (id) ids.add(id);
  }
  return Array.from(ids).map((id) => `https://www.youtube.com/watch?v=${id}`);
}

// 場外（bsn=60076）整板掛兒少保護警示；未登入拿到的是警示頁而不是文章。
function isRestricted(html, title) {
  const pageText = htmlToText(html);
  return Boolean(
    title?.includes("兒少保護") ||
      pageText.includes("如要閱覽請先登入") ||
      pageText.includes("兒少保護"),
  );
}

// 巴哈把推文/社群連結留成 `<blockquote class="twitter-tweet">`，由對方的
// widget.js 在瀏覽器裡換成 iframe——probe 等到 networkidle 才讀，看到的是換完
// 的卡片（沒有文字），純 fetch 看到的卻是還沒被換掉的原始網址。不清掉的話，
// 快路徑的內文會比 probe 多一行裸網址。
function stripEmbedPlaceholders(articleHtml) {
  if (!articleHtml) return articleHtml;
  return articleHtml.replace(
    /<blockquote\b[^>]*class=["'][^"']*\btwitter-tweet\b[^"']*["'][\s\S]*?<\/blockquote>/gi,
    "",
  );
}

function parseBahamutHtml(html) {
  const pageTitle = extractTitleTag(html);
  const restricted = isRestricted(html, pageTitle);

  const articleHtml = extractElementHtml(html, "c-article__content");
  // og:description 把整篇壓成一行；文章自己的 innerText 保留作者的分行，所以
  // 它優先（與 probe 同序）。
  const articleBody = articleHtml
    ? htmlToText(stripEmbedPlaceholders(articleHtml)).trim() || null
    : null;

  return {
    title: stripSiteSuffix(
      extractMeta(html, "property", "og:title") || pageTitle,
    ),
    description:
      articleBody ||
      extractMeta(html, "property", "og:description") ||
      extractMeta(html, "name", "description") ||
      null,
    image:
      extractMeta(html, "property", "og:image") ||
      extractMeta(html, "name", "thumbnail") ||
      null,
    images: extractArticleImages(articleHtml).slice(0, 10),
    videoUrls: extractVideoUrls(articleHtml).slice(0, 3),
    author: extractAuthor(html),
    restricted,
    metaTagCount: (html.match(/<meta\b/gi) || []).length,
  };
}

function normalizeBahamutMetadata(metadata) {
  return {
    ...metadata,
    title: trimText(metadata.title, 256),
    description: trimText(metadata.description, 4000),
    author: trimText(
      metadata.author ? metadata.author.replace(/\s+/g, " ") : null,
      256,
    ),
  };
}

async function fetchBahamutHtml(url, { timeoutMs, cookieHeader }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!isBahamutHost(response.url)) {
      throw new Error(`redirected off gamer.com.tw (${response.url})`);
    }
    const text = await response.text();
    return text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
  } finally {
    clearTimeout(timer);
  }
}

// cookies：bahamut-session 的 { BAHAENUR, BAHARUNE }，登入後才看得到場外。
function toCookieHeader(cookies) {
  if (!cookies) return null;
  const pairs = Object.entries(cookies).map(([name, value]) => `${name}=${value}`);
  return pairs.length ? pairs.join("; ") : null;
}

// 成功回 metadata（與 probe 同 shape），任何 miss 回 null。永遠不 throw。
async function fetchBahamutMetadataViaHttp(
  url,
  { cookies, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  if (!isBahamutHost(url)) return null;

  let html;
  try {
    html = await fetchBahamutHtml(url, {
      timeoutMs,
      cookieHeader: toCookieHeader(cookies),
    });
  } catch (error) {
    console.log(`[baha-fetch] miss ${url} reason=${error.message}`);
    return null;
  }

  const metadata = normalizeBahamutMetadata(parseBahamutHtml(html));

  // 被牆的頁面本來就沒有文章，交給上層照 restricted 流程處理（不算 miss）。
  if (metadata.restricted) return metadata;

  if (!metadata.title && !metadata.description) {
    console.log(`[baha-fetch] miss ${url} reason=no title/description`);
    return null;
  }
  // og:image 與 thumbnail 都沒有時，probe 還有「抓 ≥160px 的圖」那層墊底，
  // 這裡沒有 layout 復刻不了——除非文章本身有圖（那會蓋掉 image），否則交還
  // probe，別讓快路徑把有圖的預覽變成沒圖的。
  if (!metadata.image && metadata.images.length === 0) {
    console.log(`[baha-fetch] miss ${url} reason=no image candidate`);
    return null;
  }
  return metadata;
}

module.exports = {
  fetchBahamutMetadataViaHttp,
  parseBahamutHtml,
  normalizeBahamutMetadata,
  stripSiteSuffix,
  isBahamutHost,
};
