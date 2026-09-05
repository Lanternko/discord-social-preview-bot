require("dotenv").config();

const { Client, GatewayIntentBits, MessageFlags, Partials } = require("discord.js");

const {
  DISCORD_TOKEN,
  AI_TIMEOUT_MS,
  APP_EMOJI_ENABLED,
  STICKER_REPLY_ENABLED,
} = require("./config");
const { shouldIgnoreMessage, extractSupportedUrls } = require("./url-routing");
const { buildPreviewPayloads } = require("./preview");
const {
  inFlightReplies,
  recentReplies,
  buildReplyCacheKey,
  buildMessageProcessingKey,
  shouldSkipRecentReply,
  markRecentReplies,
  describeMessageLocation,
  sendPreviews,
  suppressOriginalEmbeds,
  checkAndHandleEmptyEmbeds,
} = require("./discord-io");
const { isMentioningBot, handleMention } = require("./mention");
const { handleReactionDelete } = require("./reaction-delete");
const { loadStickerLibrary } = require("./stickers");
const { ensureApplicationCommands, handleInteraction } = require("./commands");
const { AI_PROVIDER_CHAIN } = require("./ai/chain");
const { startMemorySweepTimer, stopMemorySweepTimer } = require("./ai/memory");
const { startProfileSweepTimer, stopProfileSweepTimer } = require("./ai/profile-sweep");
const { startScheduler, stopScheduler } = require("./scheduler");
const {
  recordMessage: recordFamiliarityMessage,
  flush: flushFamiliarity,
  stopFlushTimer: stopFamiliarityFlushTimer,
} = require("./familiarity");

if (!DISCORD_TOKEN) {
  throw new Error("Missing DISCORD_TOKEN. Add it to your .env file.");
}

const client = new Client({
  // failIfNotExists:false — when the bot replies to a message that was
  // deleted mid-flight, Discord otherwise rejects with 50035 (MESSAGE_
  // REFERENCE_UNKNOWN_MESSAGE). With a 25s AI timeout the delete window is
  // wide: a user @s 西寶, removes the message, then the reply lands. Degrade
  // to a plain message instead of throwing. Covers every message.reply().
  failIfNotExists: false,
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    // Without this, guild.emojis.cache is only populated at GUILD_CREATE
    // (startup): an emoji added while the bot is running stays invisible to
    // 西寶's emoji prompt table until the next restart. GuildExpressions
    // delivers GuildEmojisUpdate so the cache tracks live adds/removals.
    // Non-privileged — no Dev Portal toggle needed.
    GatewayIntentBits.GuildExpressions,
  ],
  // A 🗑️ reaction on one of 西寶's own messages requests its deletion. The
  // target preview is usually recent (a just-sent wrong-link reply), but a
  // reaction on a message sent before the last restart arrives as a partial —
  // these partials let messageReactionAdd fire for uncached messages so the
  // handler can fetch + act on them instead of silently dropping the event.
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`目前已加入 ${client.guilds.cache.size} 個伺服器`);
  const chainLabel =
    AI_PROVIDER_CHAIN.length > 0
      ? AI_PROVIDER_CHAIN.map((p) => p.label).join(" → ")
      : "none (hardcoded replies only)";
  console.log(`[ai] chain=${chainLabel} timeout=${AI_TIMEOUT_MS}ms`);

  try {
    await ensureApplicationCommands(client);
  } catch (error) {
    console.error("Failed to register application commands:", error);
  }

  // Application-owned emoji are NOT pushed by the gateway the way guild emoji
  // are (there is no GUILD_CREATE equivalent), so the cache stays empty until
  // something fetches it — and an empty cache silently means 西寶's entire
  // private emoji library is invisible to the prompt table. Fetch once here.
  if (APP_EMOJI_ENABLED) {
    try {
      const appEmojis = await client.application.emojis.fetch();
      console.log(`[emoji] 機器人自己的 emoji 庫：${appEmojis.size} 個`);
    } catch (error) {
      console.warn(`[emoji] application emoji fetch failed: ${error.message}`);
    }
  }

  if (STICKER_REPLY_ENABLED) {
    console.log(`[sticker] 自帶貼圖庫：${loadStickerLibrary().size} 張`);
  }

  startScheduler(client);
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
  // Any throw here propagates to the Client 'error' event and crashes
  // the whole process (no auto-restart). Swallow + log so a bug in one
  // handler can't take 西寶 offline.
  try {
    await handleInteraction(interaction, client);
  } catch (err) {
    console.error(
      `[commands] interaction handler error name=${interaction.commandName} guildId=${interaction.guildId ?? "none"}: ${err?.stack || err}`,
    );
    try {
      const replyPayload = {
        content: "指令執行失敗了…抱歉 🙏",
        flags: MessageFlags.Ephemeral,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(replyPayload);
      } else if (interaction.isRepliable()) {
        await interaction.reply(replyPayload);
      }
    } catch (replyErr) {
      console.warn(
        `[commands] failed to send error reply: ${replyErr?.message || replyErr}`,
      );
    }
  }
});

client.on("messageReactionAdd", async (reaction, user) => {
  // Symmetric with the handlers above: a throw inside handleReactionDelete
  // (e.g. a Discord API reject on the delete) must not escape this async
  // listener and crash the process. Log with context and move on.
  try {
    await handleReactionDelete(reaction, user, client);
  } catch (err) {
    console.error(`[delete] reaction handler error: ${err?.stack || err}`);
  }
});

client.on("messageCreate", async (message) => {
  // Tally per-guild speaking count for any human message, regardless of
  // ignore markers — nopreview/fxignore suppress the preview feature, not
  // the user's existence in the channel.
  if (!message.author?.bot && message.guildId) {
    const displayName =
      message.member?.displayName ||
      message.author?.globalName ||
      message.author?.username;
    recordFamiliarityMessage(message.guildId, message.author.id, displayName);
  }

  if (shouldIgnoreMessage(message)) return;

  if (isMentioningBot(message, client)) {
    // Dedup: messageCreate can fire twice for the same message (Discord
    // gateway reconnects). Without this, two parallel generateAIReply calls
    // race — one may fall through to the hardcoded fallback while the other
    // returns a successful AI reply, sending both to the user.
    const mentionKey = `mention:${message.id}`;
    if (inFlightReplies.has(mentionKey)) {
      console.log(`[mention] inflight skip ${message.id}`);
      return;
    }
    inFlightReplies.add(mentionKey);

    try {
      await handleMention(message, client);
    } catch (err) {
      // Symmetric with interactionCreate above: a throw inside handleMention
      // (e.g. a Discord API reject on the reply) must not escape this async
      // listener and crash the process. Log with context and move on.
      console.error(
        `[mention] handler error ${describeMessageLocation(message)}: ${err?.stack || err}`,
      );
    } finally {
      inFlightReplies.delete(mentionKey);
    }
    return;
  }

  const urls = extractSupportedUrls(message.content);
  if (urls.length === 0) return;

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
    if (!sent) return;

    const hasUrlOnly = sent.some((s) => s.isUrlOnly);
    if (!hasUrlOnly) {
      // All payloads are pre-rendered embeds — guaranteed to render, safe to
      // suppress the user's native embed immediately.
      await suppressOriginalEmbeds(message);
    } else {
      // Defer suppression until empty-embed check resolves. If our preview
      // ends up deleted (every fallback + OG-recover failed), we keep the
      // user's native Discord embed visible so they don't lose all preview.
      checkAndHandleEmptyEmbeds(message, sent)
        .then(async (result) => {
          if (result?.allSucceeded) {
            await suppressOriginalEmbeds(message);
          } else {
            console.log(
              `[preview] kept original — preview failed ${describeMessageLocation(message)}`,
            );
          }
        })
        .catch((error) => {
          console.warn("[preview] embed check failed:", error.message);
        });
    }
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

startMemorySweepTimer();
startProfileSweepTimer();

// Last-resort safety net. The watchdog cron is currently disabled, so a
// process exit means 西寶 stays dead until a manual restart. A single
// unhandled async error (the original crash was a 50035 reject on a reply to
// a deleted message) must not take the whole bot offline — same availability-
// over-strictness philosophy as the per-handler try/catch above. Log and run.
process.on("unhandledRejection", (reason) => {
  console.error(`[fatal] unhandledRejection: ${reason?.stack || reason}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[fatal] uncaughtException: ${err?.stack || err}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopScheduler();
    stopMemorySweepTimer();
    stopProfileSweepTimer();
    flushFamiliarity();
    stopFamiliarityFlushTimer();
    process.exit(0);
  });
}

if (require.main === module) {
  client.login(DISCORD_TOKEN);
}

module.exports = { client };
