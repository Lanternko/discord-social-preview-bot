// 從靜態 HTML 還原「瀏覽器會看到的純文字」的共用工具。
//
// WHY：PTT 與巴哈的快路徑（ptt-fetch.js / bahamut-fetch.js）都在做同一件事——
// 把 probe 裡 `page.evaluate` 的 innerText / querySelector 換成不開瀏覽器的等價
// 解析。兩邊要嚴格對齊各自的 probe 分支，共用的部分就只有這裡：標籤轉換行、
// 實體還原、抓出某個 class 的元素範圍。平台專屬的欄位規則留在各自模組。

const { decodeHtmlEntities } = require("./og-fallback");

// innerText 的近似。三件事必須對：
//
// 1. 區塊邊界（<div> / <p> / <li>… 的**開頭與結尾**）各算一次換行，但連續的
//    邊界只換一行——瀏覽器不會因為 `</div><div>` 相鄰就空一行。所以先放一個
//    哨兵字元標記邊界，最後把連成一串的哨兵收成單一個 \n。<br> 則是實打實的
//    換行，不參與收斂：`─────<br></font><div>下一段` 在 innerText 裡就是空一行。
// 2. &nbsp; 當成一般空白，行尾空白不算內容。這裡刻意與瀏覽器不同：innerText
//    把 nbsp 當成不可收合的空白，`<div>&nbsp;</div>` 會留下「一行空白」；那種
//    行在 embed 裡只是雜訊，而且因為「有內容」會逃過 trimText 的空行收斂，所以
//    整行丟掉。差異只出現在純排版行上，不會動到任何文字。
// 3. 行首空白不動——PTT 的內文是 pre-wrap，縮排是作者排版的一部分。
const BLOCK_BOUNDARY = "\u0000";
const BLOCK_TAGS = "div|p|li|tr|h[1-6]|blockquote|pre|article|section";

function htmlToText(html) {
  if (!html) return "";
  const text = decodeHtmlEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(
        new RegExp(`<\\/?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"),
        BLOCK_BOUNDARY,
      )
      .replace(/<[^>]+>/g, ""),
  );
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]*\u0000[ \t\u0000]*/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

function classAttrPattern(className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `class=["'][^"']*\\b${escaped}\\b[^"']*["']`;
}

// querySelector(".<className>") 的近似：回傳**第一個**符合的元素的 innerHTML。
// 靠計算同名標籤的深度找到對應的結束標籤，所以巢狀 <div> 不會讓範圍提早結束
// ——巴哈的文章區塊裡到處是巢狀 div，用非貪婪 regex 只會切到第一個 </div>。
function extractElementHtml(html, className, tagName = "div") {
  if (!html) return null;
  const openRe = new RegExp(
    `<${tagName}\\b[^>]*${classAttrPattern(className)}[^>]*>`,
    "i",
  );
  const openMatch = html.match(openRe);
  if (!openMatch) return null;

  const innerStart = openMatch.index + openMatch[0].length;
  const scanner = new RegExp(`<${tagName}\\b|</${tagName}>`, "gi");
  scanner.lastIndex = innerStart;
  let depth = 1;
  let match;
  while ((match = scanner.exec(html)) !== null) {
    depth += match[0][1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(innerStart, match.index);
  }
  // 結束標籤缺失（截斷的 HTML）→ 有多少用多少，而不是整個當沒抓到。
  return html.slice(innerStart);
}

// 第一個符合的元素的純文字，沒有就 null。
function extractElementText(html, className, tagName = "div") {
  const inner = extractElementHtml(html, className, tagName);
  if (inner === null) return null;
  const text = htmlToText(inner).trim();
  return text || null;
}

function extractMeta(html, attribute, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `<meta\\b[^>]*${attribute}=["']${escaped}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const match = html.match(re);
  if (!match) return null;
  const value = decodeHtmlEntities(match[1]).trim();
  return value || null;
}

function extractTitleTag(html) {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return null;
  const value = htmlToText(match[1]).trim();
  return value || null;
}

// threads-probe.cjs 的 trimText：快路徑吐出的字串要跟 probe 一模一樣，包含
// 連續空行的收斂與截斷符號。
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

module.exports = {
  htmlToText,
  extractElementHtml,
  extractElementText,
  extractMeta,
  extractTitleTag,
  trimText,
};
