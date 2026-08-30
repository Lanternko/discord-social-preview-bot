const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);
const INSTAGRAM_POST_PATH = /^\/(p|reel|reels)\/([A-Za-z0-9_-]{1,128})\/?$/;

function canonicalizeInstagramPostUrl(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  const authority = rawUrl.match(/^https:\/\/([^/?#]+)/i)?.[1];
  if (!authority || authority.includes("@") || authority.includes(":")) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !INSTAGRAM_HOSTS.has(parsed.hostname.toLowerCase()) ||
    parsed.hash !== ""
  ) {
    return null;
  }

  const match = parsed.pathname.match(INSTAGRAM_POST_PATH);
  if (!match) return null;
  const imageIndex = parsed.searchParams.get("img_index");
  parsed.hostname = "www.instagram.com";
  parsed.pathname = `/${match[1] === "reels" ? "reel" : match[1]}/${match[2]}/`;
  parsed.search = "";
  if (match[1] === "p" && /^\d{1,2}$/.test(imageIndex || "")) {
    parsed.searchParams.set("img_index", imageIndex);
  }
  parsed.hash = "";
  return parsed.toString();
}

function resolveInstagramUrl(rawUrl) {
  return canonicalizeInstagramPostUrl(rawUrl) || rawUrl;
}

module.exports = {
  INSTAGRAM_HOSTS,
  INSTAGRAM_POST_PATH,
  canonicalizeInstagramPostUrl,
  resolveInstagramUrl,
};
