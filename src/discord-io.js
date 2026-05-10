const { PermissionsBitField } = require("discord.js");
const {
  SUPPRESS_ORIGINAL_EMBEDS,
  REPLY_MODE,
  EMBED_CHECK_DELAY_MS,
  DEDUPE_WINDOW_MS,
} = require("./config");
const { tryRecoverEmbedFromUrls } = require("./og-fallback");

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

    const isUrlOnly = Boolean(
      payload.content && !payload.embeds && payload.content.startsWith("http"),
    );
    sent.push({
      sentMessage,
      isUrlOnly,
      fallbackContent: payload.fallbackContent ?? null,
      embedFallback: payload.embedFallback ?? null,
      recoverUrls: Array.isArray(payload.recoverUrls)
        ? payload.recoverUrls
        : null,
      recoverEmbedOptions: payload.recoverEmbedOptions ?? null,
      sourceUrl: payload.sourceUrl ?? null,
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
      fallbackContent,
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

    if (fetched.embeds.length > 0) continue;

    console.log(`[preview] empty-embed detected ${fetched.id}`);

    let current = fetched;

    if (fallbackContent) {
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

      if (current?.embeds?.length > 0) {
        console.log(`[preview] fallback url succeeded ${current.id}`);
        continue;
      }
      console.log(`[preview] fallback url also empty ${current.id}`);
    }

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
  sendPreviews,
  apologyReply,
  checkAndHandleEmptyEmbeds,
};
