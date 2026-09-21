// Shared judgement of "is this viewer card actually a preview, or is it the
// viewer telling us it failed?"
//
// Why this exists: a viewer that is DOWN does not return an empty unfurl — it
// returns a perfectly well-formed embed whose text happens to say "Temporarily
// unavailable / Couldn't load this post right now". The old per-platform
// checks only knew a handful of phrases ("post not found", "log in"), so an
// error card walked straight through as a real preview, the fallback chain
// never ran, and the user saw a dead card (Instagram, 3x in the week of
// 2026-09-21). Detection is the load-bearing half of the fallback chain: every
// layer below is useless if we wrongly call layer 1 a success.
//
// Two tiers on purpose:
//   HARD — wording that can only come from an error page. Rejected always,
//          even when the card carries an image (a viewer may serve its own
//          logo as og:image, which makes an error card look "rich").
//   SOFT — wording that COULD appear in a real caption ("try again", "not
//          available"). Only rejected when the card has no media, i.e. when
//          there is nothing else to justify keeping it.
//
// When a new failure wording shows up, add it here — one list, all platforms.

const HARD_ERROR_PATTERNS = [
  {
    id: "temporarily-unavailable",
    re: /temporar(?:il|)y\s+unavailable|暫時無法(?:載入|使用|顯示)/i,
  },
  {
    id: "cannot-load",
    re: /(?:couldn'?t|could\s+not|can'?t|cannot|unable\s+to|failed\s+to)\s+(?:load|fetch|scan|retrieve|display|render|embed)/i,
  },
  {
    id: "not-found",
    re: /(?:post|page|content|media|video|reel|tweet)\s+not\s+found|\bnot\s+found\b.{0,12}\b404\b|\b404\b.{0,16}not\s+found/i,
  },
  {
    id: "server-error",
    re: /internal\s+server\s+error|something\s+went\s+wrong|unexpected\s+error|\b5\d{2}\s+error\b|服[务務]器?錯誤/i,
  },
  {
    id: "rate-limited",
    re: /rate[\s-]?limit(?:ed|)|too\s+many\s+requests|\b429\b/i,
  },
  {
    id: "login-wall",
    re: /(?:instagram|threads?|facebook)[^\n]{0,16}log\s*in|log\s*in[^\n]{0,16}(?:instagram|threads?|facebook)|join\s+threads\b|登入或註冊即可查看/i,
  },
  {
    id: "post-unavailable",
    re: /(?:post|tweet|content|page|video)\s+is\s+(?:currently\s+)?unavailable|no\s+longer\s+available/i,
  },
];

const SOFT_ERROR_PATTERNS = [
  {
    id: "try-again",
    re: /try\s+again(?:\s+(?:later|soon|shortly|in\s+a\s+(?:moment|bit|few)))?/i,
  },
  { id: "unavailable", re: /(?:isn'?t|is\s+not|not|un)\s*available/i },
  {
    id: "private-account",
    re: /(?:this\s+)?account\s+is\s+private|private\s+account/i,
  },
  { id: "bare-error", re: /^\s*(?:error|oops|sorry)\b/i },
];

// Viewer brand words that carry no information about the post itself.
const GENERIC_CARD_TITLES =
  /^(?:instagram|post|reel|threads?|x|twitter|vxinstagram|fxinstagram|oginstagram|og\s*instagram|instagram7|deinstagram(?:\s+media)?|fxig|embedez)$/i;

// An og:image that is the viewer's own artwork rather than the post's media.
// Kept deliberately narrow — only obviously-static asset paths count.
const LOGO_IMAGE_PATH =
  /(?:^|\/)(?:logo|icon|favicon|default|placeholder|banner|card)[-_.\w]*\.(?:png|jpe?g|svg|webp)(?:$|\?)/i;
// Meta serves its own static artwork (the Instagram glyph instagram7 hands out
// for photo posts) from /rsrc.php/…, while real post media always lives under
// a /v/ path on scontent*. Hash filenames mean only the path shape gives it
// away.
const STATIC_ASSET_PATH = /\/rsrc\.php\//i;

function readEmbedValue(embed, key) {
  return embed?.[key] ?? embed?.data?.[key] ?? null;
}

function collectEmbedText(embed) {
  const title = String(readEmbedValue(embed, "title") || "").trim();
  const description = String(readEmbedValue(embed, "description") || "").trim();
  const author = String(readEmbedValue(embed, "author")?.name || "").trim();
  const fieldText = (readEmbedValue(embed, "fields") || [])
    .flatMap((field) => [field?.name, field?.value])
    .filter(Boolean)
    .join(" ")
    .trim();
  return {
    title,
    description,
    author,
    fieldText,
    visibleText: [title, description, author, fieldText]
      .filter(Boolean)
      .join(" "),
  };
}

function mediaUrlOf(embed) {
  const media =
    readEmbedValue(embed, "video") ||
    readEmbedValue(embed, "image") ||
    readEmbedValue(embed, "thumbnail");
  if (!media) return null;
  return typeof media === "string"
    ? media
    : media.url || media.proxyURL || null;
}

function embedHasMedia(embed) {
  return Boolean(mediaUrlOf(embed));
}

// A viewer serving its own logo as the cover is not "this post has media".
function isViewerArtworkUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    const { pathname } = new URL(url);
    return LOGO_IMAGE_PATH.test(pathname) || STATIC_ASSET_PATH.test(pathname);
  } catch {
    return LOGO_IMAGE_PATH.test(url) || STATIC_ASSET_PATH.test(url);
  }
}

function embedHasPostMedia(embed) {
  const url = mediaUrlOf(embed);
  return Boolean(url) && !isViewerArtworkUrl(url);
}

function matchPatterns(patterns, text) {
  if (!text) return null;
  for (const { id, re } of patterns) {
    if (re.test(text)) return id;
  }
  return null;
}

function matchHardError(text) {
  return matchPatterns(HARD_ERROR_PATTERNS, text);
}

function matchSoftError(text) {
  return matchPatterns(SOFT_ERROR_PATTERNS, text);
}

// Shared first pass for every platform: hard error wording is fatal, and so is
// soft error wording on a card with nothing else to show. Returns a reason id
// when the card should be rejected, otherwise null.
function matchErrorCard(embed, { hasMedia = embedHasPostMedia(embed) } = {}) {
  const { visibleText } = collectEmbedText(embed);
  const hard = matchHardError(visibleText);
  if (hard) return `error:${hard}`;
  if (!hasMedia) {
    const soft = matchSoftError(visibleText);
    if (soft) return `error:${soft}`;
  }
  return null;
}

function hasMeaningfulText(embed, genericPattern = GENERIC_CARD_TITLES) {
  const { title, description, author, fieldText } = collectEmbedText(embed);
  return [title, description, author, fieldText].some(
    (value) => value && !genericPattern.test(value),
  );
}

module.exports = {
  HARD_ERROR_PATTERNS,
  SOFT_ERROR_PATTERNS,
  GENERIC_CARD_TITLES,
  STATIC_ASSET_PATH,
  readEmbedValue,
  collectEmbedText,
  mediaUrlOf,
  embedHasMedia,
  embedHasPostMedia,
  isViewerArtworkUrl,
  matchHardError,
  matchSoftError,
  matchErrorCard,
  hasMeaningfulText,
};
