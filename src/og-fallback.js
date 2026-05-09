// Lightweight HTTP-only OG metadata fetcher + generic Discord embed builder.
// This is the LAST-DITCH "至少要顯示 description" path — used when both the
// primary fixer and any secondary fixer fail to produce a Discord-side embed.
//
// We avoid Playwright here on purpose: the embed-recovery path runs inside
// `checkAndHandleEmptyEmbeds` (already on a 5s+ delay), so a heavy probe would
// stack latency. Most fixer hosts return clean, crawler-friendly HTML with
// proper OG tags — a plain HTTP fetch + regex parse is more than enough.

const { EmbedBuilder } = require("discord.js");
const { trimDescription } = require("./utils");

const DEFAULT_TIMEOUT_MS = 6000;
const MAX_HTML_BYTES = 1024 * 1024; // 1 MiB cap to avoid OOM on rogue hosts.

// Discord-compatible UA — fixers usually serve OG tags only when UA looks like
// a crawler. discordbot is the canonical one.
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)";

function decodeHtmlEntities(text) {
  if (!text) return text;
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function extractMetaContent(html, regex) {
  const match = html.match(regex);
  if (!match) return null;
  const raw = match[1] || match[2] || null;
  if (!raw) return null;
  const trimmed = decodeHtmlEntities(raw).trim();
  return trimmed || null;
}

// Look for `<meta property="og:title" content="..." />` (or with attributes
// reversed). We scan the head only; some pages embed `<meta>` tags inside
// `<noscript>` later in the body which we don't want.
//
// Two regex variants per direction handle the two possible quote styles for the
// content attribute. The original [^"']*? stopped at whichever quote came first,
// so content="Author's post" was truncated to "Author". Now [^"]* and [^']* each
// stop only at the matching closing quote, fixing apostrophes / embedded quotes.
function buildMetaRegex(attrName, attrValue) {
  const valueEsc = attrValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Forward: attr first, then content
  const forwardDQ = new RegExp(
    `<meta\\b[^>]*${attrName}=["']${valueEsc}["'][^>]*content="([^"]*)"`,
    "i",
  );
  const forwardSQ = new RegExp(
    `<meta\\b[^>]*${attrName}=["']${valueEsc}["'][^>]*content='([^']*)'`,
    "i",
  );
  // Reverse: content first, then attr — covers `<meta content="x" property="og:title">`
  const reverseDQ = new RegExp(
    `<meta\\b[^>]*content="([^"]*)"[^>]*${attrName}=["']${valueEsc}["']`,
    "i",
  );
  const reverseSQ = new RegExp(
    `<meta\\b[^>]*content='([^']*)'[^>]*${attrName}=["']${valueEsc}["']`,
    "i",
  );
  return { forwardDQ, forwardSQ, reverseDQ, reverseSQ };
}

function findMeta(html, attrName, attrValue) {
  const { forwardDQ, forwardSQ, reverseDQ, reverseSQ } =
    buildMetaRegex(attrName, attrValue);
  return (
    extractMetaContent(html, forwardDQ) ||
    extractMetaContent(html, forwardSQ) ||
    extractMetaContent(html, reverseDQ) ||
    extractMetaContent(html, reverseSQ)
  );
}

function parseOgFromHtml(html) {
  const head = html.split(/<\/head>/i)[0] || html.slice(0, 65536);

  const title =
    findMeta(head, "property", "og:title") ||
    findMeta(head, "name", "twitter:title") ||
    (head.match(/<title[^>]*>([\s\S]{0,512}?)<\/title>/i)?.[1]
      ? decodeHtmlEntities(
          head.match(/<title[^>]*>([\s\S]{0,512}?)<\/title>/i)[1],
        ).trim()
      : null);

  const description =
    findMeta(head, "property", "og:description") ||
    findMeta(head, "name", "twitter:description") ||
    findMeta(head, "name", "description");

  const image =
    findMeta(head, "property", "og:image:secure_url") ||
    findMeta(head, "property", "og:image:url") ||
    findMeta(head, "property", "og:image") ||
    findMeta(head, "name", "twitter:image:src") ||
    findMeta(head, "name", "twitter:image");

  const siteName = findMeta(head, "property", "og:site_name");
  const author =
    findMeta(head, "name", "author") ||
    findMeta(head, "property", "article:author") ||
    findMeta(head, "property", "og:author");

  return { title, description, image, siteName, author };
}

async function fetchHtml(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": DEFAULT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType && !/html|xml/i.test(contentType)) {
      throw new Error(`unexpected content-type ${contentType}`);
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      return text.length > MAX_HTML_BYTES
        ? text.slice(0, MAX_HTML_BYTES)
        : text;
    }
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let html = "";
    let received = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (received >= MAX_HTML_BYTES) {
        try {
          await reader.cancel();
        } catch {}
        break;
      }
      // OG tags live in <head>; bail early once we see </head>.
      if (html.includes("</head>") || html.includes("</HEAD>")) {
        try {
          await reader.cancel();
        } catch {}
        break;
      }
    }
    html += decoder.decode();
    return html;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOgMetadata(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const html = await fetchHtml(url, timeoutMs);
  const meta = parseOgFromHtml(html);
  return meta;
}

function hasUsefulMetadata(meta) {
  if (!meta) return false;
  return Boolean(meta.title || meta.description || meta.image);
}

function buildGenericFallbackEmbed(meta, originalUrl, options = {}) {
  const {
    color = 0x2b2d31,
    footerText = "預覽降級",
    descriptionLimit = 1024,
  } = options;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setURL(originalUrl)
    .setFooter({ text: footerText });

  if (meta.title) {
    embed.setTitle(trimDescription(meta.title, 256));
  }
  if (meta.author) {
    embed.setAuthor({ name: trimDescription(meta.author, 256) });
  }
  if (meta.description) {
    embed.setDescription(trimDescription(meta.description, descriptionLimit));
  }
  if (meta.image) {
    embed.setImage(meta.image);
  }
  return embed;
}

// Walks `recoverUrls` in order, returning the first embed we can build from a
// usable OG metadata response. Returns null if every URL fails.
async function tryRecoverEmbedFromUrls(recoverUrls, options = {}) {
  if (!Array.isArray(recoverUrls) || recoverUrls.length === 0) return null;
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sourceUrl,
    embedOptions,
  } = options;

  for (const candidate of recoverUrls) {
    if (!candidate) continue;
    try {
      const meta = await fetchOgMetadata(candidate, { timeoutMs });
      if (!hasUsefulMetadata(meta)) {
        console.log(`[og-fallback] empty meta candidate=${candidate}`);
        continue;
      }
      const embed = buildGenericFallbackEmbed(
        meta,
        sourceUrl || candidate,
        embedOptions || {},
      );
      console.log(
        `[og-fallback] recovered candidate=${candidate} title=${meta.title ? "yes" : "no"} desc=${meta.description ? "yes" : "no"} image=${meta.image ? "yes" : "no"}`,
      );
      return { embed, source: candidate, meta };
    } catch (error) {
      console.log(
        `[og-fallback] fetch failed candidate=${candidate} reason=${error.message}`,
      );
    }
  }
  return null;
}

module.exports = {
  fetchOgMetadata,
  parseOgFromHtml,
  buildGenericFallbackEmbed,
  tryRecoverEmbedFromUrls,
  hasUsefulMetadata,
  decodeHtmlEntities,
};
