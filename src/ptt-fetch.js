// PTT 純 fetch 快路徑 —— `buildPttPayload` 在退回 Playwright probe 之前先試這條。
//
// WHY：PTT 是靜態 HTML，內文、作者、標題在第一份 response 裡就齊了，沒有任何
// 需要跑 JS 才會出現的東西。可是 probe 對每一則 PTT 連結都開一顆完整 chromium
// （~1-2s、幾百 MB），而 PTT 正是目前 chromium 啟動次數的大宗（2026-09 抽樣：
// 6 天 70 次啟動裡 43 次是 PTT）。一個 fetch 就能把那 6 成打掉。
//
// 這裡的解析刻意對齊 `threads-probe.cjs` 的 `readPttMetadata`，讓兩條路吐出同
// 一個 shape（title / description / image / author / metaTagCount），
// `buildPttEmbed` 因此不必知道 metadata 是誰抓的。
//
// 任何一步不如預期都回 null（絕不 throw）：未登入牆、版型改動、PTT 掛掉——
// 呼叫端就照舊開 probe。快路徑只能讓預覽變快，不能讓預覽變差。

const { decodeHtmlEntities } = require("./og-fallback");

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 內文要整份讀，比 og-fallback 的 head-only 寬。

// PTT 不看 UA，但給一個正常瀏覽器的值，免得哪天被當成爬蟲擋掉。
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

const PTT_HOSTS = new Set(["ptt.cc", "www.ptt.cc"]);

// 文章頁長這樣：/bbs/<板名>/M.<時間戳>.A.<hash>.html。八卦板等分級板未帶
// over18 cookie 時會 302 到 /ask/over18，比對落點就能認出來。
const ARTICLE_PATH_RE = /^\/bbs\/[^/]+\/M\.\d+\.[^/]*\.html$/;

function isPttArticleUrl(url) {
  try {
    const parsed = new URL(url);
    return (
      PTT_HOSTS.has(parsed.hostname) && ARTICLE_PATH_RE.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

// probe 讀的是 innerText，這裡要從 HTML 還原出等價的純文字：<br> 與區塊結尾
// 變換行，標籤拿掉，實體還原。
function htmlToText(html) {
  return decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:div|p|li|tr|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  );
}

// 只要 #main-content 這一塊。推文（.push）整段砍掉——probe 是靠「切掉 `--` 之後
// 的簽名檔」順便把推文一起帶走的，但那依賴發文者真的有 `--` 分隔線；直接從結構
// 上砍 .push 對沒有簽名檔的文章也成立。
function extractMainContentHtml(html) {
  const start = html.search(/<div\b[^>]*id=["']main-content["'][^>]*>/i);
  if (start === -1) return null;
  const body = html.slice(start);
  const pushStart = body.search(/<div\b[^>]*class=["'][^"']*\bpush\b/i);
  return pushStart === -1 ? body : body.slice(0, pushStart);
}

// 作者 / 看板 / 標題 / 時間依序放在 .article-meta-value 裡，和 probe 取的
// values[0] / values[2] 是同一組。
function extractMetaValues(html) {
  const values = [];
  const re =
    /<span\b[^>]*class=["'][^"']*\barticle-meta-value\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    values.push(htmlToText(match[1]).trim());
  }
  return values;
}

function extractOgMeta(html, property) {
  const re = new RegExp(
    `<meta\\b[^>]*property=["']${property}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const match = html.match(re);
  if (!match) return null;
  const value = decodeHtmlEntities(match[1]).trim();
  return value || null;
}

function parsePttHtml(html) {
  const mainContentHtml = extractMainContentHtml(html);
  const values = extractMetaValues(html);

  let body = htmlToText(mainContentHtml || "")
    .replace(/^作者.*\n看板.*\n標題.*\n時間.*\n?/m, "")
    .replace(/\n--\n[\s\S]*$/, "")
    .trim();

  const imageMatch = body.match(
    /https?:\/\/[^\s]+\.(?:jpg|jpeg|png|gif|webp)/i,
  );

  return {
    title:
      values[2] ||
      extractOgMeta(html, "og:title") ||
      htmlToText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").trim() ||
      null,
    description: extractOgMeta(html, "og:description") || body || null,
    image: imageMatch?.[0] || null,
    author: values[0] || null,
    metaTagCount: (html.match(/<meta\b/gi) || []).length,
  };
}

// 與 threads-probe.cjs 的 trimText 同一套規則：兩條路徑吐出的字串長度、換行
// 收斂方式要一致，不然同一篇文走不同路會長得不一樣。
function trimText(text, limit) {
  if (!text) return null;
  const normalized = text
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return null;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1).trimEnd()}…`;
}

function normalizePttMetadata(metadata) {
  return {
    ...metadata,
    title: trimText(metadata.title, 256),
    description: trimText(metadata.description, 4000),
    // Discord 的 embed author 只有一行，多行標頭要壓成一行（同 probe）。
    author: trimText(
      metadata.author ? metadata.author.replace(/\s+/g, " ") : null,
      256,
    ),
  };
}

async function fetchPttHtml(url, timeoutMs) {
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
        // 分級板的年齡牆吃這顆 cookie，和 probe 的 addCookies 等價。
        Cookie: "over18=1",
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    // 牆沒過就會被導去 /ask/over18；那頁沒有內文，當 miss 處理。
    if (!isPttArticleUrl(response.url)) {
      throw new Error(`redirected off article page (${response.url})`);
    }
    const text = await response.text();
    return text.length > MAX_HTML_BYTES ? text.slice(0, MAX_HTML_BYTES) : text;
  } finally {
    clearTimeout(timer);
  }
}

// 成功回 metadata（與 probe 同 shape），任何 miss 回 null。永遠不 throw。
async function fetchPttMetadataViaHttp(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isPttArticleUrl(url)) return null;

  let html;
  try {
    html = await fetchPttHtml(url, timeoutMs);
  } catch (error) {
    console.log(`[ptt-fetch] miss ${url} reason=${error.message}`);
    return null;
  }

  const metadata = normalizePttMetadata(parsePttHtml(html));
  // 標題和內文都沒撈到 = 版型跟我們的假設不一樣了，交給 probe。
  if (!metadata.title && !metadata.description) {
    console.log(`[ptt-fetch] miss ${url} reason=no title/description`);
    return null;
  }
  return metadata;
}

module.exports = {
  fetchPttMetadataViaHttp,
  parsePttHtml,
  normalizePttMetadata,
  isPttArticleUrl,
};
