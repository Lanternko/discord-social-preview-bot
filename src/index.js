require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  MessageFlags,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { execFile } = require("node:child_process");
const path = require("node:path");
const { promisify } = require("node:util");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const FIXEMBED_BASE_URL =
  process.env.FIXEMBED_BASE_URL || "https://fixembed.app/embed?url=";
const FIXER_TWITTER = process.env.FIXER_TWITTER || "fxtwitter.com";
const FIXER_THREADS = process.env.FIXER_THREADS || "fixthreads.seria.moe";
const FIXER_THREADS_SECONDARY =
  process.env.FIXER_THREADS_SECONDARY || "threadsez.net";
const FIXER_REDDIT = process.env.FIXER_REDDIT || "rxddit.com";
const FIXER_PIXIV = process.env.FIXER_PIXIV || "phixiv.net";
const FIXER_BLUESKY = process.env.FIXER_BLUESKY || "bskx.app";
const FIXER_BILIBILI = process.env.FIXER_BILIBILI || "vxbilibili.com";
const FIXER_FACEBOOK = process.env.FIXER_FACEBOOK || "facebed.com";
const FIXER_INSTAGRAM = process.env.FIXER_INSTAGRAM || "ddinstagram.com";
const SUPPRESS_ORIGINAL_EMBEDS =
  (process.env.SUPPRESS_ORIGINAL_EMBEDS || "true").toLowerCase() === "true";
const REPLY_MODE = (process.env.REPLY_MODE || "reply").toLowerCase();
const THREADS_PROBE_NODE =
  process.env.THREADS_PROBE_NODE || process.execPath;
const THREADS_PROBE_SCRIPT =
  process.env.THREADS_PROBE_SCRIPT || path.join(__dirname, "threads-probe.cjs");
const THREADS_PROBE_TIMEOUT_MS = Number.parseInt(
  process.env.THREADS_PROBE_TIMEOUT_MS || "10000",
  10,
);
const THREADS_METADATA_CACHE_TTL_MS = Number.parseInt(
  process.env.THREADS_METADATA_CACHE_TTL_MS || "600000",
  10,
);
const EMBED_CHECK_DELAY_MS = Number.parseInt(
  process.env.EMBED_CHECK_DELAY_MS || "5000",
  10,
);

if (!DISCORD_TOKEN) {
  throw new Error("Missing DISCORD_TOKEN. Add it to your .env file.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const THREADS_HOSTS = new Set([
  "threads.net",
  "www.threads.net",
  "threads.com",
  "www.threads.com",
]);
const INSTAGRAM_HOSTS = new Set([
  "instagram.com",
  "www.instagram.com",
]);
const BAHAMUT_HOSTS = new Set([
  "forum.gamer.com.tw",
  "m.gamer.com.tw",
]);
const PTT_HOSTS = new Set([
  "ptt.cc",
  "www.ptt.cc",
]);
const BILIBILI_HOSTS = new Set([
  "bilibili.com",
  "www.bilibili.com",
  "b23.tv",
]);
const FACEBOOK_HOSTS = new Set([
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "fb.watch",
]);

const SUPPORTED_HOSTS = new Set([
  ...THREADS_HOSTS,
  ...INSTAGRAM_HOSTS,
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "reddit.com",
  "www.reddit.com",
  "redd.it",
  "pixiv.net",
  "www.pixiv.net",
  "bsky.app",
  "www.bsky.app",
  ...FACEBOOK_HOSTS,
  ...BAHAMUT_HOSTS,
  ...PTT_HOSTS,
  "bilibili.com",
  "www.bilibili.com",
  "b23.tv",
]);

const URL_REGEX = /https?:\/\/[^\s<>()]+/gi;
const IGNORE_MARKERS = ["fxignore", "previewignore", "nopreview"];
const THREADS_EMBED_COLOR = 0x101010;
const DEDUPE_WINDOW_MS = 60 * 1000;
const recentReplies = new Map();
const inFlightReplies = new Set();
const threadsMetadataCache = new Map();
const execFileAsync = promisify(execFile);
const SERVER_COUNT_COMMAND = {
  name: "servers",
  description: "顯示目前機器人加入的伺服器數量",
};
const DEBUG_PERMS_COMMAND = {
  name: "debug-perms",
  description: "檢查目前頻道裡機器人的權限",
};
const REQUIRED_CHANNEL_PERMISSIONS = [
  {
    flag: PermissionsBitField.Flags.ViewChannel,
    name: "ViewChannel",
  },
  {
    flag: PermissionsBitField.Flags.SendMessages,
    name: "SendMessages",
  },
  {
    flag: PermissionsBitField.Flags.ReadMessageHistory,
    name: "ReadMessageHistory",
  },
  {
    flag: PermissionsBitField.Flags.EmbedLinks,
    name: "EmbedLinks",
  },
];

function normalizeUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete("xmt");
  url.searchParams.delete("slof");
  // Bilibili tracking params
  url.searchParams.delete("spm_id_from");
  url.searchParams.delete("trackid");
  url.searchParams.delete("vd_source");
  url.searchParams.delete("from");
  url.searchParams.delete("from_spmid");
  url.searchParams.delete("seid");
  url.searchParams.delete("share_source");
  url.searchParams.delete("share_medium");
  url.searchParams.delete("share_plat");
  url.searchParams.delete("share_session_id");
  url.searchParams.delete("share_tag");
  url.searchParams.delete("timestamp");
  url.searchParams.delete("unique_k");
  url.searchParams.delete("upsig");
  // Universal UTM params
  url.searchParams.delete("utm_source");
  url.searchParams.delete("utm_medium");
  url.searchParams.delete("utm_campaign");
  url.searchParams.delete("utm_term");
  url.searchParams.delete("utm_content");
  // Instagram-specific tracking params
  if (INSTAGRAM_HOSTS.has(url.hostname)) {
    url.searchParams.delete("igsh");
    url.searchParams.delete("igshid");
  }
  return url.toString();
}

function extractSupportedUrls(content) {
  const matches = content.match(URL_REGEX) || [];
  const urls = [];
  const seen = new Set();

  for (const raw of matches) {
    let parsed;

    try {
      parsed = new URL(raw);
    } catch {
      continue;
    }

    if (!SUPPORTED_HOSTS.has(parsed.hostname)) {
      continue;
    }

    const normalized = normalizeUrl(parsed.toString());
    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    urls.push(normalized);
  }

  return urls;
}

function replaceHostFixer(originalUrl, fixerHost) {
  const parsed = new URL(originalUrl);
  parsed.hostname = fixerHost;
  return parsed.toString();
}

function buildFallbackUrl(originalUrl) {
  const hostname = new URL(originalUrl).hostname;

  if (
    [
      "x.com",
      "www.x.com",
      "twitter.com",
      "www.twitter.com",
      "mobile.twitter.com",
    ].includes(hostname)
  ) {
    return replaceHostFixer(originalUrl, FIXER_TWITTER);
  }

  if (THREADS_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_THREADS);
  }

  if (INSTAGRAM_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_INSTAGRAM);
  }

  if (["reddit.com", "www.reddit.com"].includes(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_REDDIT);
  }

  if (["pixiv.net", "www.pixiv.net"].includes(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_PIXIV);
  }

  if (["bsky.app", "www.bsky.app"].includes(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_BLUESKY);
  }

  if (BILIBILI_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_BILIBILI);
  }

  if (FACEBOOK_HOSTS.has(hostname)) {
    return replaceHostFixer(originalUrl, FIXER_FACEBOOK);
  }

  return `${FIXEMBED_BASE_URL}${encodeURIComponent(originalUrl)}`;
}

function shouldIgnoreMessage(message) {
  if (message.author.bot) {
    return true;
  }

  const lower = message.content.toLowerCase();
  return IGNORE_MARKERS.some((marker) => lower.includes(marker));
}

function cleanupRecentReplies() {
  const now = Date.now();

  for (const [key, timestamp] of recentReplies.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentReplies.delete(key);
    }
  }
}

function cleanupThreadsMetadataCache() {
  const now = Date.now();

  for (const [url, entry] of threadsMetadataCache.entries()) {
    if (now - entry.cachedAt > THREADS_METADATA_CACHE_TTL_MS) {
      threadsMetadataCache.delete(url);
    }
  }
}

function buildReplyCacheKey(message, url) {
  return `${message.channelId}:${url}`;
}

function buildMessageProcessingKey(message, urls) {
  return `${message.id}:${urls.join("|")}`;
}

function shouldSkipRecentReply(message, urls) {
  cleanupRecentReplies();

  return urls.some((url) => {
    const timestamp = recentReplies.get(buildReplyCacheKey(message, url));
    return Boolean(timestamp);
  });
}

function markRecentReplies(message, urls) {
  const now = Date.now();

  for (const url of urls) {
    recentReplies.set(buildReplyCacheKey(message, url), now);
  }
}

function trimDescription(text, limit) {
  if (!text || text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

function isThreadsUrl(url) {
  return THREADS_HOSTS.has(new URL(url).hostname);
}

function isInstagramUrl(url) {
  return INSTAGRAM_HOSTS.has(new URL(url).hostname);
}

// Returns true if the URL path indicates an Instagram Story (with or without mediaId).
function isInstagramStoryUrl(url) {
  const parsed = new URL(url);
  return INSTAGRAM_HOSTS.has(parsed.hostname) &&
    parsed.pathname.startsWith("/stories/");
}

// Returns the story owner username, or null if not a story / username unreadable.
// Story URL format: /stories/<username>[/<mediaId>]
function extractInstagramStoryOwner(url) {
  const parsed = new URL(url);
  if (!INSTAGRAM_HOSTS.has(parsed.hostname)) return null;
  const match = parsed.pathname.match(/^\/stories\/([^/]+)/);
  return match ? match[1] : null;
}

// Fetches the display name for an Instagram username by probing their profile page.
// og:title is typically "DisplayName (@username) • Instagram…"
// Returns null on failure (caller should fall back to raw username).
async function fetchInstagramDisplayName(username) {
  const profileUrl = `https://www.instagram.com/${encodeURIComponent(username)}/`;
  try {
    const metadata = await fetchPageProbeMetadata(profileUrl);
    if (metadata.title) {
      // Match display name before " (@username)" or "（@username）"
      const match = metadata.title.match(/^(.+?)\s*[（(]@/);
      if (match) return match[1].trim();
    }
  } catch (error) {
    console.warn(`[preview] could not fetch Instagram display name for ${username}:`, error.message);
  }
  return null;
}

function isBilibiliUrl(url) {
  return BILIBILI_HOSTS.has(new URL(url).hostname);
}

function isBahamutUrl(url) {
  return BAHAMUT_HOSTS.has(new URL(url).hostname);
}

function isPttUrl(url) {
  return PTT_HOSTS.has(new URL(url).hostname);
}

function extractBilibiliBvid(url) {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/);
  return match?.[1] || null;
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

function buildBilibiliEmbed(url, metadata) {
  const embed = new EmbedBuilder()
    .setColor(0x00a1d6)
    .setURL(url)
    .setTitle(trimDescription(metadata.title, 256))
    .setFooter({ text: "Bilibili" });

  if (metadata.author) {
    embed.setAuthor({ name: metadata.author });
  }

  if (metadata.description) {
    embed.setDescription(trimDescription(metadata.description, 512));
  }

  if (metadata.image) {
    embed.setImage(metadata.image);
  }

  return embed;
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
      headers: {
        "User-Agent": "Mozilla/5.0",
      },
    });

    const finalUrl = normalizeUrl(response.url || url);
    const finalParsed = new URL(finalUrl);
    if (finalParsed.hostname === "www.bilibili.com" || finalParsed.hostname === "bilibili.com") {
      return replaceHostFixer(finalUrl, FIXER_BILIBILI);
    }
  } catch (error) {
    console.warn(`Could not expand b23.tv short link for ${url}:`, error.message);
  } finally {
    clearTimeout(timeout);
  }

  return replaceHostFixer(url, FIXER_BILIBILI);
}

async function fetchThreadsMetadata(url) {
  cleanupThreadsMetadataCache();

  const cached = threadsMetadataCache.get(url);
  if (cached) {
    console.log(`[threads-meta] cache-hit ${url}`);
    return cached.metadata;
  }

  const { stdout } = await execFileAsync(
    THREADS_PROBE_NODE,
    [THREADS_PROBE_SCRIPT, url],
    {
      timeout: THREADS_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );

  const metadata = JSON.parse(stdout);

  console.log(
    `[threads-meta] metaTags=${metadata.metaTagCount} title=${metadata.title ? "yes" : "no"} desc=${metadata.description ? "yes" : "no"} image=${metadata.image ? "yes" : "no"} card=${metadata.twitterCard ?? "null"} imageCount=${metadata.imageCount ?? 0} videoCount=${metadata.videoCount ?? 0} source=playwright-subprocess`,
  );

  const result = {
    title: metadata.title,
    description: metadata.description,
    image: metadata.image,
    twitterCard: metadata.twitterCard,
    video: metadata.video,
    imageCount: metadata.imageCount || 0,
    videoCount: metadata.videoCount || 0,
  };

  threadsMetadataCache.set(url, {
    metadata: result,
    cachedAt: Date.now(),
  });

  return result;
}

async function fetchPageProbeMetadata(url) {
  const { stdout } = await execFileAsync(
    THREADS_PROBE_NODE,
    [THREADS_PROBE_SCRIPT, url],
    {
      timeout: THREADS_PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    },
  );

  return JSON.parse(stdout);
}

function buildThreadsCompactEmbed(url, metadata) {
  const embed = new EmbedBuilder()
    .setColor(THREADS_EMBED_COLOR)
    .setURL(url)
    .setFooter({ text: "Threads" });

  if (metadata.title) {
    embed.setTitle(trimDescription(metadata.title, 256));
  }

  if (metadata.description) {
    embed.setDescription(trimDescription(metadata.description, 4000));
  }

  return embed;
}

function buildThreadsMediaEmbed(url, metadata) {
  const embed = buildThreadsCompactEmbed(url, metadata);

  if (metadata.image) {
    embed.setImage(metadata.image);
  }

  return embed;
}

function buildThreadsLinkRow(url, label = "Open on Threads") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel(label)
      .setStyle(ButtonStyle.Link)
      .setURL(url),
  );
}

function buildBahamutEmbed(url, metadata) {
  const embed = new EmbedBuilder()
    .setColor(0xf08c2e)
    .setURL(url)
    .setFooter({ text: "巴哈姆特" });

  if (metadata.title) {
    embed.setTitle(trimDescription(metadata.title, 256));
  }

  if (metadata.author) {
    embed.setAuthor({ name: trimDescription(metadata.author, 256) });
  }

  if (metadata.description) {
    embed.setDescription(trimDescription(metadata.description, 1024));
  }

  if (metadata.image) {
    embed.setImage(metadata.image);
  }

  return embed;
}

function buildPttEmbed(url, metadata) {
  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setURL(url)
    .setFooter({ text: "PTT" });

  if (metadata.title) {
    embed.setTitle(trimDescription(metadata.title, 256));
  }

  if (metadata.author) {
    embed.setAuthor({ name: trimDescription(metadata.author, 256) });
  }

  if (metadata.description) {
    embed.setDescription(trimDescription(metadata.description, 1024));
  }

  if (metadata.image) {
    embed.setImage(metadata.image);
  }

  return embed;
}

async function buildPreviewPayloads(urls) {
  const payloads = [];

  for (const url of urls) {
    if (isBahamutUrl(url)) {
      try {
        const metadata = await fetchPageProbeMetadata(url);
        if (metadata.restricted) {
          console.log(`[preview] bahamut-restricted fallback ${url}`);
          payloads.push({ content: buildFallbackUrl(url) });
          continue;
        }

        console.log(`[preview] bahamut-custom ${url}`);
        payloads.push({ embeds: [buildBahamutEmbed(url, metadata)] });
        continue;
      } catch (error) {
        console.warn(`Could not fetch Bahamut metadata for ${url}:`, error.message);
      }

      console.log(`[preview] bahamut fallback ${url}`);
      payloads.push({ content: buildFallbackUrl(url) });
      continue;
    }

    if (isPttUrl(url)) {
      try {
        const metadata = await fetchPageProbeMetadata(url);
        console.log(`[preview] ptt-custom ${url}`);
        payloads.push({ embeds: [buildPttEmbed(url, metadata)] });
        continue;
      } catch (error) {
        console.warn(`Could not fetch PTT metadata for ${url}:`, error.message);
      }

      console.log(`[preview] ptt fallback ${url}`);
      payloads.push({ content: buildFallbackUrl(url) });
      continue;
    }

    if (isInstagramUrl(url)) {
      const storyOwner = isInstagramStoryUrl(url) ? extractInstagramStoryOwner(url) : null;
      if (storyOwner != null || isInstagramStoryUrl(url)) {
        // Stories cannot be previewed by any fixer — report the owner instead
        const displayName = await fetchInstagramDisplayName(storyOwner);
        const ownerLabel = displayName
          ? `${displayName}（@${storyOwner}）`
          : `@${storyOwner}`;
        console.log(`[preview] instagram-story owner=${storyOwner} displayName=${displayName ?? "n/a"} ${url}`);
        payloads.push({ content: `這是 **${ownerLabel}** 的限動！` });
        continue;
      }
      const primaryUrl = replaceHostFixer(url, FIXER_INSTAGRAM);
      console.log(`[preview] instagram-fixer ${url}`);
      // fallbackContent is FixEmbed in case ddinstagram fails to unfurl
      payloads.push({ content: primaryUrl, fallbackContent: `${FIXEMBED_BASE_URL}${encodeURIComponent(url)}` });
      continue;
    }

    if (isBilibiliUrl(url)) {
      const fallbackUrl = await buildBilibiliFallbackUrl(url);
      console.log(`[preview] bilibili-fixer ${url} -> ${fallbackUrl}`);
      payloads.push({ content: fallbackUrl });
      continue;
    }

    if (!isThreadsUrl(url)) {
      console.log(`[preview] fixer non-threads ${url}`);
      payloads.push({ content: buildFallbackUrl(url) });
      continue;
    }

    try {
      const metadata = await fetchThreadsMetadata(url);

      const isTextOnly = !metadata.image;

      if (isTextOnly || metadata.twitterCard === "summary") {
        const logLabel = isTextOnly ? "threads-text-only" : "threads-compact";
        console.log(`[preview] ${logLabel} ${metadata.twitterCard} ${url}`);
        payloads.push({ embeds: [buildThreadsCompactEmbed(url, metadata)] });
        continue;
      }

      if (metadata.video || metadata.videoCount > 0) {
        console.log(`[preview] threads-video fixer ${url}`);
        payloads.push({ content: buildFallbackUrl(url) });
        continue;
      }

      if (
        metadata.twitterCard === "summary_large_image" &&
        metadata.image &&
        metadata.imageCount <= 1
      ) {
        console.log(`[preview] threads-single-image ${url}`);
        payloads.push({ embeds: [buildThreadsMediaEmbed(url, metadata)] });
        continue;
      }

      if (metadata.imageCount > 1) {
        console.log(`[preview] threads-multi-image ${url}`);
        payloads.push({
          embeds: [buildThreadsMediaEmbed(url, metadata)],
          components: [buildThreadsLinkRow(url)],
        });
        continue;
      }

      console.log(`[preview] threads-generic ${metadata.twitterCard} ${url}`);
      payloads.push({ embeds: [buildThreadsCompactEmbed(url, metadata)] });
      continue;
    } catch (error) {
      console.warn(`Could not fetch Threads metadata for ${url}:`, error.message);
    }

    console.log(`[preview] threads fixer fallback ${url}`);
    payloads.push({ content: buildFallbackUrl(url) });
  }

  return payloads;
}

function describeMessageLocation(message) {
  const guildName = message.guild?.name || "DM";
  const channelName =
    "name" in message.channel && message.channel.name
      ? `#${message.channel.name}`
      : message.channelId;
  return `guild="${guildName}" channel="${channelName}"`;
}

function getMissingChannelPermissions(message) {
  if (!message.inGuild()) {
    return [];
  }

  const me = message.guild.members.me;
  if (!me) {
    return ["BotMemberUnavailable"];
  }

  const permissions = message.channel.permissionsFor(me);
  if (!permissions) {
    return ["PermissionsUnavailable"];
  }

  return REQUIRED_CHANNEL_PERMISSIONS.filter(
    (permission) => !permissions.has(permission.flag),
  ).map((permission) => permission.name);
}

function logMissingChannelPermissions(message, missingPermissions) {
  console.warn(
    `[permissions] missing=${missingPermissions.join(",")} ${describeMessageLocation(message)}`,
  );
}

function inferMissingPermissionsFromError(error) {
  const message = error?.message || "";
  const code = error?.code;
  const missingPermissions = [];

  if (code === 160002 || /read message history/i.test(message)) {
    missingPermissions.push("ReadMessageHistory");
  }

  if (code === 50013 || /missing permissions/i.test(message)) {
    missingPermissions.push("MissingPermissions");
  }

  return [...new Set(missingPermissions)];
}

async function suppressOriginalEmbeds(message) {
  if (!SUPPRESS_ORIGINAL_EMBEDS || !message.inGuild()) {
    return;
  }

  const me = message.guild.members.me;
  if (!me) {
    return;
  }

  const permissions = message.channel.permissionsFor(me);
  if (!permissions?.has(PermissionsBitField.Flags.ManageMessages)) {
    console.warn(
      `[permissions] missing=ManageMessages ${describeMessageLocation(message)} while suppressing embeds`,
    );
    return;
  }

  try {
    await message.suppressEmbeds(true);
  } catch (error) {
    console.warn(
      `[preview] suppress failed ${describeMessageLocation(message)}: ${error.message}`,
    );
  }
}

async function sendPreviews(message, payloads) {
  const missingPermissions = getMissingChannelPermissions(message);
  if (missingPermissions.length > 0) {
    logMissingChannelPermissions(message, missingPermissions);
    return false;
  }

  const sent = [];

  for (const payload of payloads) {
    const outgoing = {
      ...payload,
      allowedMentions: { repliedUser: false },
    };

    let sentMessage;
    if (REPLY_MODE === "send") {
      try {
        sentMessage = await message.channel.send(outgoing);
      } catch (error) {
        const inferredMissingPermissions = inferMissingPermissionsFromError(error);
        if (inferredMissingPermissions.length > 0) {
          logMissingChannelPermissions(message, inferredMissingPermissions);
        }
        throw error;
      }
    } else {
      try {
        sentMessage = await message.reply(outgoing);
      } catch (error) {
        const inferredMissingPermissions = inferMissingPermissionsFromError(error);
        if (inferredMissingPermissions.length > 0) {
          logMissingChannelPermissions(message, inferredMissingPermissions);
        }
        throw error;
      }
    }

    // URL-only payloads rely on Discord to unfurl — track them for embed checks
    // (plain-text messages like Story reports must be excluded)
    const isUrlOnly = Boolean(payload.content && !payload.embeds && payload.content.startsWith("http"));
    sent.push({ sentMessage, isUrlOnly, fallbackContent: payload.fallbackContent ?? null });
  }

  return sent;
}

async function apologyReply(originalMessage) {
  try {
    await originalMessage.reply({
      content: "對不起對不起…預覽載入失敗了…我知道我不好… ///",
      allowedMentions: { repliedUser: false },
    });
  } catch (error) {
    console.warn("[preview] could not send apology:", error.message);
  }
}

async function checkAndHandleEmptyEmbeds(originalMessage, sent) {
  const urlMessages = sent.filter((s) => s.isUrlOnly);
  if (urlMessages.length === 0) return;

  await new Promise((resolve) => setTimeout(resolve, EMBED_CHECK_DELAY_MS));

  for (const { sentMessage, fallbackContent } of urlMessages) {
    let fetched;
    try {
      fetched = await sentMessage.fetch();
    } catch {
      continue;
    }

    if (fetched.embeds.length > 0) continue;

    console.log(`[preview] empty-embed detected ${fetched.id}`);

    // Try fallback fixer before giving up
    if (fallbackContent) {
      console.log(`[preview] trying fallback embed ${fetched.id}`);
      try {
        await fetched.edit({
          content: fallbackContent,
          allowedMentions: { repliedUser: false },
        });
      } catch (error) {
        console.warn("[preview] could not edit to fallback:", error.message);
        await apologyReply(originalMessage);
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, EMBED_CHECK_DELAY_MS));

      let refetched;
      try {
        refetched = await fetched.fetch();
      } catch {
        await apologyReply(originalMessage);
        continue;
      }

      if (refetched.embeds.length > 0) {
        console.log(`[preview] fallback embed succeeded ${refetched.id}`);
        continue;
      }

      console.log(`[preview] fallback also empty, giving up ${refetched.id}`);
      try {
        await refetched.delete();
      } catch (error) {
        console.warn("[preview] could not delete failed fallback message:", error.message);
      }
      await apologyReply(originalMessage);
      continue;
    }

    // No fallback — delete and apologise
    try {
      await fetched.delete();
    } catch (error) {
      console.warn("[preview] could not delete empty embed message:", error.message);
    }
    await apologyReply(originalMessage);
  }
}

async function ensureApplicationCommands() {
  const expectedCommands = [SERVER_COUNT_COMMAND, DEBUG_PERMS_COMMAND];
  const commands = await client.application.commands.fetch();
  for (const expectedCommand of expectedCommands) {
    const existing = commands.find(
      (command) => command.name === expectedCommand.name,
    );

    if (!existing) {
      await client.application.commands.create(expectedCommand);
      console.log(`[commands] registered /${expectedCommand.name}`);
      continue;
    }

    if (existing.description !== expectedCommand.description) {
      await existing.edit(expectedCommand);
      console.log(`[commands] updated /${expectedCommand.name}`);
    }
  }
}

function buildPermissionDebugMessage(interaction) {
  if (!interaction.inGuild()) {
    return "這個指令只能在伺服器頻道內使用。";
  }

  const missingPermissions = getMissingChannelPermissions(interaction);
  const me = interaction.guild.members.me;
  const permissions = me ? interaction.channel.permissionsFor(me) : null;
  const hasManageMessages = permissions?.has(
    PermissionsBitField.Flags.ManageMessages,
  );

  const lines = [
    `伺服器：${interaction.guild.name}`,
    `頻道：${"name" in interaction.channel && interaction.channel.name ? `#${interaction.channel.name}` : interaction.channelId}`,
  ];

  if (missingPermissions.length === 0) {
    lines.push("必要權限：都已具備");
  } else {
    lines.push(`缺少必要權限：${missingPermissions.join(", ")}`);
  }

  lines.push(
    `ManageMessages：${hasManageMessages ? "有" : "沒有"}`,
  );

  return lines.join("\n");
}

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`目前已加入 ${client.guilds.cache.size} 個伺服器`);

  try {
    await ensureApplicationCommands();
  } catch (error) {
    console.error("Failed to register application commands:", error);
  }
});

client.on("guildCreate", (guild) => {
  console.log(
    `加入新伺服器: ${guild.name}，目前共 ${client.guilds.cache.size} 個`,
  );
});

client.on("guildDelete", (guild) => {
  console.log(
    `離開伺服器: ${guild.name}，目前共 ${client.guilds.cache.size} 個`,
  );
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  if (interaction.commandName === SERVER_COUNT_COMMAND.name) {
    await interaction.reply({
      content: `目前已加入 ${client.guilds.cache.size} 個伺服器。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.commandName === DEBUG_PERMS_COMMAND.name) {
    await interaction.reply({
      content: buildPermissionDebugMessage(interaction),
      flags: MessageFlags.Ephemeral,
    });
  }
});

const FORTUNE_RESULTS = [
  { label: "大吉", weight: 5 },
  { label: "中吉", weight: 15 },
  { label: "小吉", weight: 20 },
  { label: "末吉", weight: 20 },
  { label: "吉",   weight: 15 },
  { label: "凶",   weight: 15 },
  { label: "大凶", weight: 10 },
];

function drawFortune() {
  const total = FORTUNE_RESULTS.reduce((sum, r) => sum + r.weight, 0);
  let rand = Math.floor(Math.random() * total);
  for (const result of FORTUNE_RESULTS) {
    rand -= result.weight;
    if (rand < 0) return result.label;
  }
  return FORTUNE_RESULTS.at(-1).label;
}

function isMentioningBot(message) {
  return message.mentions.has(client.user);
}

client.on("messageCreate", async (message) => {
  if (shouldIgnoreMessage(message)) {
    return;
  }

  // Handle @西寶 mentions before link detection
  if (isMentioningBot(message)) {
    const text = message.content
      .replace(/<@!?\d+>/g, "")
      .trim()
      .toLowerCase();

    if (text === "抽籤") {
      const result = drawFortune();
      await message.reply({
        content: `抽到了… **${result}** ！`,
        allowedMentions: { repliedUser: false },
      });
      return;
    }

    if (text === "") {
      await message.reply({
        content: "有、有什麼事嗎…？///" ,
        allowedMentions: { repliedUser: false },
      });
      return;
    }
  }

  const urls = extractSupportedUrls(message.content);
  if (urls.length === 0) {
    return;
  }

  const processingKey = buildMessageProcessingKey(message, urls);
  if (inFlightReplies.has(processingKey)) {
    console.log(`[preview] inflight skip ${urls.join(" ")}`);
    return;
  }

  if (shouldSkipRecentReply(message, urls)) {
    console.log(`[preview] dedupe skip ${urls.join(" ")}`);
    return;
  }

  inFlightReplies.add(processingKey);
  markRecentReplies(message, urls);

  try {
    const payloads = await buildPreviewPayloads(urls);
    const sent = await sendPreviews(message, payloads);
    if (!sent) {
      return;
    }
    await suppressOriginalEmbeds(message);
    checkAndHandleEmptyEmbeds(message, sent).catch((error) => {
      console.warn("[preview] embed check failed:", error.message);
    });
  } catch (error) {
    for (const url of urls) {
      recentReplies.delete(buildReplyCacheKey(message, url));
    }
    console.error(
      `[preview] failed ${describeMessageLocation(message)}:`,
      error,
    );
  } finally {
    inFlightReplies.delete(processingKey);
  }
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    process.exit(0);
  });
}

client.login(DISCORD_TOKEN);
