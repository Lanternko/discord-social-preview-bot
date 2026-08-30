const { PermissionsBitField, AttachmentBuilder } = require("discord.js");
const {
  SUPPRESS_ORIGINAL_EMBEDS,
  REPLY_MODE,
  EMBED_CHECK_DELAY_MS,
  DEDUPE_WINDOW_MS,
} = require("./config");
const { tryRecoverEmbedFromUrls } = require("./og-fallback");
const { fetchVideoAttachment } = require("./video");

const REQUIRED_CHANNEL_PERMISSIONS = [
  { flag: PermissionsBitField.Flags.ViewChannel, name: "ViewChannel" },
  { flag: PermissionsBitField.Flags.SendMessages, name: "SendMessages" },
  {
    flag: PermissionsBitField.Flags.ReadMessageHistory,
    name: "ReadMessageHistory",
  },
  { flag: PermissionsBitField.Flags.EmbedLinks, name: "EmbedLinks" },
];

const recentReplies = new Map();
const inFlightReplies = new Set();

function buildReplyCacheKey(message, url) {
  return `${message.channelId}:${url}`;
}

function buildMessageProcessingKey(message, urls) {
  return `${message.id}:${urls.join("|")}`;
}

function cleanupRecentReplies() {
  const now = Date.now();
  for (const [key, timestamp] of recentReplies.entries()) {
    if (now - timestamp > DEDUPE_WINDOW_MS) {
      recentReplies.delete(key);
    }
  }
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

function describeMessageLocation(message) {
  const guildName = message.guild?.name || "DM";
  const channelName =
    "name" in message.channel && message.channel.name
      ? `#${message.channel.name}`
      : message.channelId;
  return `guild="${guildName}" channel="${channelName}"`;
}

function getMissingChannelPermissions(message) {
  if (!message.inGuild()) return [];
  // inGuild() can be true while .guild is null when the bot isn't in
  // the guild's cache (e.g. kicked/restored mid-session). Guard so the
  // caller doesn't blow up reading .members on null.
  if (!message.guild) return ["GuildUnavailable"];
  const me = message.guild.members.me;
  if (!me) return ["BotMemberUnavailable"];
  const permissions = message.channel.permissionsFor(me);
  if (!permissions) return ["PermissionsUnavailable"];
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
  const missing = [];
  if (code === 160002 || /read message history/i.test(message)) {
    missing.push("ReadMessageHistory");
  }
  if (code === 50013 || /missing permissions/i.test(message)) {
    missing.push("MissingPermissions");
  }
  return [...new Set(missing)];
}

async function suppressOriginalEmbeds(message) {
  if (!SUPPRESS_ORIGINAL_EMBEDS || !message.inGuild()) return;
  const me = message.guild.members.me;
  if (!me) return;
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

function readEmbedValue(embed, key) {
  return embed?.[key] ?? embed?.data?.[key] ?? null;
}

function isUsefulThreadsViewerEmbed(embed) {
  const title = String(readEmbedValue(embed, "title") || "").trim();
  const description = String(
    readEmbedValue(embed, "description") || "",
  ).trim();
  const author = String(readEmbedValue(embed, "author")?.name || "").trim();
  const fieldText = (readEmbedValue(embed, "fields") || [])
    .flatMap((field) => [field?.name, field?.value])
    .filter(Boolean)
    .join(" ")
    .trim();
  const visibleText = [title, description, author, fieldText]
    .filter(Boolean)
    .join(" ");

  if (
    /\bthreads?\b[^\n]{0,12}\blog\s*in\b/i.test(visibleText) ||
    /join\s+threads\b/i.test(visibleText)
  ) {
    return false;
  }

  const hasMedia = Boolean(
    readEmbedValue(embed, "image") ||
      readEmbedValue(embed, "thumbnail") ||
      readEmbedValue(embed, "video"),
  );
  const meaningfulText = [title, description, author, fieldText].some(
    (value) => value && !/^threads?$/i.test(value),
  );
  const genericTitleOnly = /^threads?$/i.test(title) && !meaningfulText;
  return !genericTitleOnly && (hasMedia || meaningfulText);
}

function isUsefulInstagramViewerEmbed(embed) {
  const title = String(readEmbedValue(embed, "title") || "").trim();
  const description = String(
    readEmbedValue(embed, "description") || "",
  ).trim();
  const author = String(readEmbedValue(embed, "author")?.name || "").trim();
  const fieldText = (readEmbedValue(embed, "fields") || [])
    .flatMap((field) => [field?.name, field?.value])
    .filter(Boolean)
    .join(" ")
    .trim();
  const visibleText = [title, description, author, fieldText]
    .filter(Boolean)
    .join(" ");

  if (
    /instagram[^\n]{0,16}log\s*in|log\s*in[^\n]{0,16}instagram/i.test(
      visibleText,
    ) ||
    /post\s+not\s+found|content\s+(?:isn't|is not)\s+available|page\s+(?:isn't|is not)\s+available/i.test(
      visibleText,
    )
  ) {
    return false;
  }

  const hasMedia = Boolean(
    readEmbedValue(embed, "image") ||
      readEmbedValue(embed, "thumbnail") ||
      readEmbedValue(embed, "video"),
  );
  const meaningfulText = [title, description, author, fieldText].some(
    (value) =>
      value &&
      !/^(?:instagram|post|reel|vxinstagram|fxinstagram|deinstagram media)$/i.test(
        value,
      ),
  );
  return hasMedia || meaningfulText;
}

function isViewerPreviewUseful(embeds, viewerValidation = null) {
  if (!Array.isArray(embeds) || embeds.length === 0) return false;
  if (viewerValidation === "threads") {
    return embeds.some(isUsefulThreadsViewerEmbed);
  }
  if (viewerValidation === "instagram") {
    return embeds.some(isUsefulInstagramViewerEmbed);
  }
  return true;
}

// A payload may carry `videoAttachment` (a direct mp4 URL). Try to download +
// re-upload it so Discord shows a real playable video the bot controls; on a
// miss (too big / disabled / at capacity / fetch fail) the payload keeps its
// existing behaviour — the carousel for a MIXED post, the fixer chain for a
// video-only post — unless it supplied `videoAttachmentMissContent`, a fixer
// URL to swap in instead: Discord unfurls the fixer's og:video by streaming
// the remote mp4, so a video over the guild's upload cap still gets a native
// player. Returns the message body to send.
async function resolveOutgoing(payload, message, options = {}) {
  const base = { ...payload };
  const videoUrl = base.videoAttachment;
  const attachmentEmbeds = base.videoAttachmentEmbeds;
  const attachmentContent = base.videoAttachmentContent;
  const missContent = base.videoAttachmentMissContent;
  delete base.videoAttachment;
  delete base.videoAttachmentEmbeds;
  delete base.videoAttachmentContent;
  delete base.videoAttachmentMissContent;
  if (!videoUrl) return base;

  const fetchAttachment = options.fetchVideoAttachment || fetchVideoAttachment;
  const attachment = await fetchAttachment(videoUrl, message.guild);
  if (!attachment) {
    if (typeof missContent === "string" && missContent) {
      console.log(`[video] miss → fixer unfurl ${missContent}`);
      base.content = missContent;
      delete base.embeds;
    }
    return base;
  }

  base.files = [
    new AttachmentBuilder(attachment.buffer, { name: attachment.name }),
  ];
  // Now that the video attached, pick how the caption rides with it:
  //   1. `videoAttachmentContent` (Bilibili) — a text info bar shown as message
  //      content ABOVE the player, replacing the embed box entirely (clickable
  //      title + mark, no duplicate cover).
  //   2. `videoAttachmentEmbeds` (Threads video-only) — a cover-less embed that
  //      replaces the fixer link.
  //   3. neither (Threads MIXED carousel, whose gallery differs from the video)
  //      — keep the original embeds untouched.
  if (typeof attachmentContent === "string" && attachmentContent) {
    base.content = attachmentContent;
    delete base.embeds;
  } else if (Array.isArray(attachmentEmbeds)) {
    base.embeds = attachmentEmbeds;
  }
  // Video-only posts carry the fixer URL as `content`; now that the video is a
  // real attachment, drop that link (and its secondary) so the post isn't a
  // bare player sitting under a link unfurl. (Skipped for the info-bar case —
  // that content isn't an http URL.)
  if (typeof base.content === "string" && base.content.startsWith("http")) {
    delete base.content;
    delete base.fallbackContent;
    delete base.fallbackContents;
  }
  return base;
}

async function sendPreviews(message, payloads) {
  const missingPermissions = getMissingChannelPermissions(message);
  if (missingPermissions.length > 0) {
    logMissingChannelPermissions(message, missingPermissions);
    return false;
  }

  const sent = [];

  for (const payload of payloads) {
    const base = await resolveOutgoing(payload, message);
    const outgoing = {
      ...base,
      allowedMentions: { repliedUser: false },
    };

    let sentMessage;
    if (REPLY_MODE === "send") {
      try {
        sentMessage = await message.channel.send(outgoing);
      } catch (error) {
        const inferred = inferMissingPermissionsFromError(error);
        if (inferred.length > 0) logMissingChannelPermissions(message, inferred);
        throw error;
      }
    } else {
      try {
        sentMessage = await message.reply(outgoing);
      } catch (error) {
        const inferred = inferMissingPermissionsFromError(error);
        if (inferred.length > 0) logMissingChannelPermissions(message, inferred);
        throw error;
      }
    }

    // A resolved video attachment adds `files` and clears the fixer `content`,
    // so a successful upload counts as a pre-rendered (not url-only) preview and
    // skips the empty-embed delete path.
    const isUrlOnly = Boolean(
      base.content &&
        !base.embeds &&
        !base.files &&
        base.content.startsWith("http"),
    );
    sent.push({
      sentMessage,
      isUrlOnly,
      fallbackContents: Array.isArray(base.fallbackContents)
        ? base.fallbackContents.filter(
            (candidate) =>
              typeof candidate === "string" && candidate.startsWith("http"),
          )
        : typeof base.fallbackContent === "string" && base.fallbackContent
          ? [base.fallbackContent]
          : [],
      viewerValidation: base.viewerValidation ?? null,
      embedFallback: base.embedFallback ?? null,
      recoverUrls: Array.isArray(base.recoverUrls) ? base.recoverUrls : null,
      recoverEmbedOptions: base.recoverEmbedOptions ?? null,
      sourceUrl: base.sourceUrl ?? null,
    });
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

async function tryOgRecover(target, recoverUrls, sourceUrl, embedOptions) {
  if (!Array.isArray(recoverUrls) || recoverUrls.length === 0) return false;
  let recovered;
  try {
    recovered = await tryRecoverEmbedFromUrls(recoverUrls, {
      sourceUrl: sourceUrl || recoverUrls[0],
      embedOptions: embedOptions || undefined,
    });
  } catch (error) {
    console.warn("[preview] og-recover threw:", error.message);
    return false;
  }
  if (!recovered) return false;
  try {
    await target.edit({
      content: "",
      embeds: [recovered.embed],
      allowedMentions: { repliedUser: false },
    });
    console.log(
      `[preview] og-recover used target=${target.id} source=${recovered.source}`,
    );
    return true;
  } catch (error) {
    console.warn("[preview] og-recover edit failed:", error.message);
    return false;
  }
}

async function checkAndHandleEmptyEmbeds(originalMessage, sent) {
  const urlMessages = sent.filter((s) => s.isUrlOnly);
  // If we sent only pre-rendered embed payloads, there's nothing to verify.
  if (urlMessages.length === 0) return { allSucceeded: true };

  let allSucceeded = true;

  await new Promise((resolve) => setTimeout(resolve, EMBED_CHECK_DELAY_MS));

  for (const item of urlMessages) {
    const {
      sentMessage,
      fallbackContents,
      viewerValidation,
      embedFallback,
      recoverUrls,
      recoverEmbedOptions,
      sourceUrl,
    } = item;

    let fetched;
    try {
      fetched = await sentMessage.fetch();
    } catch (error) {
      console.warn(
        `[preview] empty-embed fetch failed id=${sentMessage.id} reason=${error.message}`,
      );
      continue;
    }

    if (isViewerPreviewUseful(fetched.embeds, viewerValidation)) continue;

    console.log(`[preview] empty-or-useless-embed detected ${fetched.id}`);

    let current = fetched;

    let viewerSucceeded = false;
    for (const fallbackContent of fallbackContents || []) {
      console.log(`[preview] trying fallback url ${current.id}`);
      try {
        await current.edit({
          content: fallbackContent,
          allowedMentions: { repliedUser: false },
        });
      } catch (error) {
        console.warn("[preview] could not edit to fallback:", error.message);
      }

      await new Promise((resolve) => setTimeout(resolve, EMBED_CHECK_DELAY_MS));

      try {
        current = await current.fetch();
      } catch (error) {
        console.warn(
          `[preview] refetch after fallback failed id=${current.id} reason=${error.message}`,
        );
      }

      if (isViewerPreviewUseful(current?.embeds, viewerValidation)) {
        console.log(`[preview] fallback url succeeded ${current.id}`);
        viewerSucceeded = true;
        break;
      }
      console.log(`[preview] fallback url empty or useless ${current.id}`);
    }
    if (viewerSucceeded) continue;

    if (embedFallback) {
      try {
        await current.edit({
          content: "",
          ...embedFallback,
          allowedMentions: { repliedUser: false },
        });
        console.log(`[preview] embed fallback used ${current.id}`);
        continue;
      } catch (error) {
        console.warn(
          "[preview] could not edit to embed fallback:",
          error.message,
        );
      }
    }

    if (
      await tryOgRecover(current, recoverUrls, sourceUrl, recoverEmbedOptions)
    ) {
      continue;
    }

    try {
      await current.delete();
    } catch (error) {
      console.warn(
        "[preview] could not delete empty embed message:",
        error.message,
      );
    }
    await apologyReply(originalMessage);
    allSucceeded = false;
  }

  return { allSucceeded };
}

module.exports = {
  REQUIRED_CHANNEL_PERMISSIONS,
  recentReplies,
  inFlightReplies,
  buildReplyCacheKey,
  buildMessageProcessingKey,
  cleanupRecentReplies,
  shouldSkipRecentReply,
  markRecentReplies,
  describeMessageLocation,
  getMissingChannelPermissions,
  logMissingChannelPermissions,
  inferMissingPermissionsFromError,
  suppressOriginalEmbeds,
  isUsefulThreadsViewerEmbed,
  isUsefulInstagramViewerEmbed,
  isViewerPreviewUseful,
  resolveOutgoing,
  sendPreviews,
  apologyReply,
  checkAndHandleEmptyEmbeds,
};
