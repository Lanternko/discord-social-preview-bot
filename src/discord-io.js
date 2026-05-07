const { PermissionsBitField } = require("discord.js");
const {
  SUPPRESS_ORIGINAL_EMBEDS,
  REPLY_MODE,
  EMBED_CHECK_DELAY_MS,
  DEDUPE_WINDOW_MS,
} = require("./config");

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

async function checkAndHandleEmptyEmbeds(originalMessage, sent) {
  const urlMessages = sent.filter((s) => s.isUrlOnly);
  if (urlMessages.length === 0) return;

  await new Promise((resolve) => setTimeout(resolve, EMBED_CHECK_DELAY_MS));

  for (const { sentMessage, fallbackContent, embedFallback } of urlMessages) {
    let fetched;
    try {
      fetched = await sentMessage.fetch();
    } catch {
      continue;
    }

    if (fetched.embeds.length > 0) continue;

    console.log(`[preview] empty-embed detected ${fetched.id}`);

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

      console.log(`[preview] fallback also empty ${refetched.id}`);
      if (embedFallback) {
        try {
          await refetched.edit({
            content: "",
            ...embedFallback,
            allowedMentions: { repliedUser: false },
          });
          console.log(`[preview] embed fallback used ${refetched.id}`);
          continue;
        } catch (error) {
          console.warn(
            "[preview] could not edit to embed fallback:",
            error.message,
          );
        }
      }
      try {
        await refetched.delete();
      } catch (error) {
        console.warn(
          "[preview] could not delete failed fallback message:",
          error.message,
        );
      }
      await apologyReply(originalMessage);
      continue;
    }

    if (embedFallback) {
      try {
        await fetched.edit({
          content: "",
          ...embedFallback,
          allowedMentions: { repliedUser: false },
        });
        console.log(`[preview] embed fallback used ${fetched.id}`);
        continue;
      } catch (error) {
        console.warn(
          "[preview] could not edit to embed fallback:",
          error.message,
        );
      }
    }
    try {
      await fetched.delete();
    } catch (error) {
      console.warn(
        "[preview] could not delete empty embed message:",
        error.message,
      );
    }
    await apologyReply(originalMessage);
  }
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
