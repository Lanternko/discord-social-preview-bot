require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
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

const SUPPORTED_HOSTS = new Set([
  ...THREADS_HOSTS,
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "instagram.com",
  "www.instagram.com",
  "reddit.com",
  "www.reddit.com",
  "redd.it",
  "pixiv.net",
  "www.pixiv.net",
  "bsky.app",
  "www.bsky.app",
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

function normalizeUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.searchParams.delete("xmt");
  url.searchParams.delete("slof");
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
  url.searchParams.delete("utm_source");
  url.searchParams.delete("utm_medium");
  url.searchParams.delete("utm_campaign");
  url.searchParams.delete("utm_term");
  url.searchParams.delete("utm_content");
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

function buildEmbedUrl(originalUrl) {
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
          payloads.push({ content: buildEmbedUrl(url) });
          continue;
        }

        console.log(`[preview] bahamut-custom ${url}`);
        payloads.push({ embeds: [buildBahamutEmbed(url, metadata)] });
        continue;
      } catch (error) {
        console.warn(`Could not fetch Bahamut metadata for ${url}:`, error.message);
      }

      console.log(`[preview] fixembed fallback ${url}`);
      payloads.push({ content: buildEmbedUrl(url) });
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

      console.log(`[preview] fixembed fallback ${url}`);
      payloads.push({ content: buildEmbedUrl(url) });
      continue;
    }

    if (!isThreadsUrl(url)) {
      if (isBilibiliUrl(url)) {
        try {
          const metadata = await fetchBilibiliMetadata(url);
          console.log(`[preview] bilibili-custom ${url}`);
          payloads.push({ embeds: [buildBilibiliEmbed(url, metadata)] });
          continue;
        } catch (error) {
          console.warn(`Could not fetch Bilibili metadata for ${url}:`, error.message);
        }
      }

      console.log(`[preview] fixembed non-threads ${url}`);
      payloads.push({ content: buildEmbedUrl(url) });
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
        console.log(
          `[preview] fixembed video ${url}`,
        );
        payloads.push({ content: buildEmbedUrl(url) });
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

    console.log(`[preview] fixembed fallback ${url}`);
    payloads.push({ content: buildEmbedUrl(url) });
  }

  return payloads;
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
    return;
  }

  try {
    await message.suppressEmbeds(true);
  } catch (error) {
    console.warn("Could not suppress original embeds:", error.message);
  }
}

async function sendPreviews(message, payloads) {
  for (const payload of payloads) {
    const outgoing = {
      ...payload,
      allowedMentions: { repliedUser: false },
    };

    if (REPLY_MODE === "send") {
      await message.channel.send(outgoing);
      continue;
    }

    await message.reply(outgoing);
  }
}

client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (shouldIgnoreMessage(message)) {
    return;
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
    await sendPreviews(message, payloads);
    await suppressOriginalEmbeds(message);
  } catch (error) {
    for (const url of urls) {
      recentReplies.delete(buildReplyCacheKey(message, url));
    }
    console.error("Failed to create preview:", error);
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
