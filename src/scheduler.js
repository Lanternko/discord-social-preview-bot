const cron = require("node-cron");
const { EMOJI_TRUSTED_GUILD_IDS, RECAP_DEEPSEEK_MAX_TOKENS } = require("./config");
const { getAllSchedules, getScheduleById, updateSchedule } = require("./schedule-store");
const { getTierConfig } = require("./tier-config");
const { trimDescription } = require("./utils");
const {
  AI_PROVIDER_CHAIN,
  RECAP_PROVIDER_CHAIN,
  STORY_PROVIDER_CHAIN,
  runProviderChain,
} = require("./ai/chain");
const { recordAITurn } = require("./ai/memory");
const {
  buildEmojiMap,
  buildEmojiPromptBlock,
  resolveCustomEmojis,
} = require("./ai/emoji-resolver");
const {
  getFamiliarityRoster,
  buildFamiliarityBlock,
} = require("./familiarity");
const {
  fetchGuildMessages,
  buildRecapStats,
  buildRecapPrompt,
} = require("./daily-recap");
const {
  BEDTIME_LOOKBACK_MS,
  buildBedtimeStoryPrompt,
  markBedtimeStoryUsed,
} = require("./bedtime-story");

// ── Task types ──────────────────────────────────────────────────────────
// Static tasks have a `prompt` string; dynamic tasks have a `buildPrompt`
// async function that receives (channel, client) and returns a prompt string.
const TASK_TYPES = {
  bedtime_story: {
    label: "床邊故事",
    buildPrompt: async (channel, client, schedule) => {
      const guild = channel.guild;
      if (!guild) {
        console.warn("[bedtime-story] no guild for channel, falling back");
        return {
          prompt:
            "（系統提示：現在是睡前時間。請主動講一個短短的原創故事，有一個小轉折。自己決定場景和結尾，不要硬接到睡覺。）",
        };
      }

      const { messages, channelStats } = await fetchGuildMessages(
        guild,
        BEDTIME_LOOKBACK_MS,
      );
      const built = buildBedtimeStoryPrompt({
        guildName: guild.name,
        messages,
        channelStats,
        schedule,
      });
      console.log(
        `[bedtime-story] guild=${guild.name} ingredients=${built.ingredientCount} scanned=${messages.length}`,
      );
      return {
        prompt: built.prompt,
        onSuccess: () => markBedtimeStoryUsed(schedule, built.dateKey),
      };
    },
  },
  morning_greeting: {
    label: "早安問候",
    prompt:
      "（系統提示：現在是早上了。請主動跟大家說早安，簡短溫馨就好，可以聊聊今天的心情或天氣之類的。）",
  },
  daily_recap: {
    label: "今日回顧",
    pin: true,
    buildPrompt: async (channel, client) => {
      const guild = channel.guild;
      if (!guild) {
        console.warn("[daily-recap] no guild for channel, falling back");
        return "（系統提示：無法取得伺服器資訊。請用你的風格說今天的回顧出了點問題。）";
      }
      const { messages, channelStats } = await fetchGuildMessages(guild);
      const stats = buildRecapStats(messages);
      console.log(
        `[daily-recap] guild=${guild.name} stats: ${stats.totalMessages} msgs, ${stats.uniqueAuthors} authors, ${stats.topReacted.length} reacted, ${channelStats.length} active channels`,
      );
      return buildRecapPrompt(stats, channelStats, guild.name);
    },
  },
};

// Valid task type keys for external validation.
const VALID_TASK_TYPES = Object.keys(TASK_TYPES);

// ── Active cron jobs ────────────────────────────────────────────────────
// Map<scheduleId, cron.ScheduledTask>
const activeJobs = new Map();
const RECAP_PREGENERATE_MS = 60 * 1000;

function waitUntil(notBeforeMs, options = {}) {
  if (!Number.isFinite(notBeforeMs)) return Promise.resolve();
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const delayMs = Math.max(0, notBeforeMs - now());
  return delayMs > 0 ? sleep(delayMs) : Promise.resolve();
}

async function sendAtOrAfter(channel, payload, notBeforeMs, options = {}) {
  await waitUntil(notBeforeMs, options);
  return channel.send(payload);
}

// ── Task execution ──────────────────────────────────────────────────────

async function executeScheduledTask(schedule, client, options = {}) {
  const { channelId, guildId, taskType, customPrompt } = schedule;

  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.warn(
      `[scheduler] channel not found id=${channelId} schedule=${schedule.id}, skipping`,
    );
    return;
  }

  // Resolve prompt — dynamic builder → custom override → static predefined.
  const taskDef = TASK_TYPES[taskType];
  if (!taskDef && !customPrompt) {
    console.warn(
      `[scheduler] unknown task type=${taskType} schedule=${schedule.id}`,
    );
    return;
  }

  let prompt;
  let onSuccess;
  if (taskDef && taskDef.buildPrompt) {
    const built = await taskDef.buildPrompt(channel, client, schedule);
    if (built && typeof built === "object" && !Array.isArray(built)) {
      prompt = built.prompt;
      onSuccess = built.onSuccess;
    } else {
      prompt = built;
    }
  } else {
    prompt = customPrompt || (taskDef && taskDef.prompt);
  }

  if (!prompt) {
    console.warn(
      `[scheduler] empty prompt for schedule=${schedule.id}`,
    );
    return;
  }

  const providerChain = taskType === "daily_recap"
    ? RECAP_PROVIDER_CHAIN
    : taskType === "bedtime_story"
      ? STORY_PROVIDER_CHAIN
      : AI_PROVIDER_CHAIN;
  if (providerChain.length === 0) {
    console.warn("[scheduler] no AI providers, skipping scheduled task");
    return;
  }

  const tierConfig = getTierConfig(guildId);
  let persona = tierConfig.persona;
  const emojiMap = buildEmojiMap(client, guildId, EMOJI_TRUSTED_GUILD_IDS);
  persona += buildEmojiPromptBlock(emojiMap);

  // Append familiarity roster so 西寶 knows who's who, same as live replies.
  const roster = getFamiliarityRoster(guildId);
  if (roster.length > 0) {
    persona += buildFamiliarityBlock(roster);
  }

  const turns = [{ role: "user", content: prompt }];
  const maxTokens = taskType === "daily_recap"
    ? Math.max(tierConfig.maxTokens, RECAP_DEEPSEEK_MAX_TOKENS)
    : tierConfig.maxTokens;
  if (taskType === "daily_recap") {
    console.log(
      `[daily-recap] promptChars=${prompt.length} personaChars=${persona.length} maxTokens=${maxTokens}`,
    );
  }

  try {
    const result = await runProviderChain(
      providerChain,
      turns,
      persona,
      maxTokens,
    );

    if (!result) {
      console.warn(
        `[scheduler] AI chain exhausted for schedule=${schedule.id}`,
      );
      return;
    }

    const capped = trimDescription(result.text, tierConfig.maxReplyChars);
    const text = resolveCustomEmojis(capped, emojiMap);
    // Generation starts one minute early, but publication must never happen
    // before the user-configured wall-clock time. Awaiting a timer is
    // non-blocking; if generation ran long, waitUntil resolves immediately.
    const sent = await sendAtOrAfter(
      channel,
      { content: text },
      options.notBeforeMs,
      options,
    );

    // Record this post into the channel's short-term memory so that when
    // someone @s or replies to 西寶 shortly after, she remembers having
    // posted it. TWO turns, not one: a bare assistant turn with no preceding
    // user turn — written in the recap/story register her chat persona says
    // she'd never use — reads to the model as a foreign blob, and she disowns
    // it as someone else's bait（「上面那個不是我寫的」, 2026-07-15 incident）.
    // The system-style user turn pins authorship. Its meta carries no userId,
    // so long-term memory extraction (observation-extractor guards on
    // `!userId`) never attributes it to a member. Store the UNRESOLVED
    // `capped` text (`:name:` form), same reasoning as ai/chain.js.
    const taskLabel = (taskDef && taskDef.label) || "排程訊息";
    recordAITurn(
      channelId,
      "user",
      `（系統：接下來這一則「${taskLabel}」是你自己按排程主動發到頻道的——是你本人發的，不是任何群友貼的。）`,
      tierConfig.memoryMaxTurns,
      { guildId },
    );
    recordAITurn(channelId, "assistant", capped, tierConfig.memoryMaxTurns, {
      guildId,
      userId: client.user?.id,
      displayName: client.user?.username || "西寶",
    });

    if (typeof onSuccess === "function") {
      try {
        onSuccess({ text, sent });
      } catch (hookErr) {
        console.warn(
          `[scheduler] post-send hook failed schedule=${schedule.id}: ${hookErr.message}`,
        );
      }
    }
    console.log(
      `[scheduler] sent task=${taskType} schedule=${schedule.id} channel=${channelId} provider=${result.provider.label} len=${text.length}`,
    );

    // Pin the new message and unpin the previous one if the task type requests it.
    if (taskDef && taskDef.pin) {
      // Unpin previous recap message.
      if (schedule.lastPinnedMessageId) {
        try {
          const oldMsg = await channel.messages.fetch(schedule.lastPinnedMessageId);
          if (oldMsg && oldMsg.pinned) {
            await oldMsg.unpin();
            console.log(`[scheduler] unpinned old message=${schedule.lastPinnedMessageId}`);
          }
        } catch (unpinErr) {
          // Message might have been deleted or already unpinned — that's fine.
          console.log(`[scheduler] could not unpin old message=${schedule.lastPinnedMessageId}: ${unpinErr.message}`);
        }
      }

      // Pin new message.
      try {
        await sent.pin();
        updateSchedule(schedule.id, { lastPinnedMessageId: sent.id });
        console.log(`[scheduler] pinned new message=${sent.id}`);
      } catch (pinErr) {
        console.warn(`[scheduler] failed to pin message=${sent.id}: ${pinErr.message}`);
      }
    }
  } catch (err) {
    console.error(
      `[scheduler] failed schedule=${schedule.id}: ${err?.stack || err}`,
    );
  }
}

// ── Cron management ─────────────────────────────────────────────────────

function buildCronExpression(hour, minute) {
  return `${minute} ${hour} * * *`;
}

function subtractScheduleMinute(hour, minute) {
  const totalMinutes = (Number(hour) * 60 + Number(minute) - 1 + 24 * 60) % (24 * 60);
  return {
    hour: Math.floor(totalMinutes / 60),
    minute: totalMinutes % 60,
  };
}

function recapNotBeforeMs(taskContext, now = Date.now) {
  const scheduledStart = taskContext?.date;
  const startMs = scheduledStart instanceof Date && Number.isFinite(scheduledStart.getTime())
    ? scheduledStart.getTime()
    : now();
  return startMs + RECAP_PREGENERATE_MS;
}

function registerJob(schedule, client) {
  if (activeJobs.has(schedule.id)) {
    // Already registered — unregister first to avoid duplicates.
    unregisterJob(schedule.id);
  }

  const executionTime = schedule.taskType === "daily_recap"
    ? subtractScheduleMinute(schedule.hour, schedule.minute)
    : { hour: schedule.hour, minute: schedule.minute };
  const cronExpr = buildCronExpression(executionTime.hour, executionTime.minute);
  const tz = schedule.timezone || "Asia/Taipei";

  const task = cron.schedule(
    cronExpr,
    (taskContext) => {
      // Re-read the schedule from store in case it was disabled/removed
      // between registration and execution.
      const current = getScheduleById(schedule.id);
      if (!current || !current.enabled) {
        console.log(
          `[scheduler] skipping disabled/removed schedule=${schedule.id}`,
        );
        return;
      }
      const executionOptions = current.taskType === "daily_recap"
        ? { notBeforeMs: recapNotBeforeMs(taskContext) }
        : {};
      executeScheduledTask(current, client, executionOptions).catch((err) => {
        console.error(
          `[scheduler] unhandled error schedule=${schedule.id}: ${err?.message || err}`,
        );
      });
    },
    { timezone: tz },
  );

  activeJobs.set(schedule.id, task);
}

function unregisterJob(id) {
  const job = activeJobs.get(id);
  if (job) {
    job.stop();
    activeJobs.delete(id);
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────

function startScheduler(client) {
  const schedules = getAllSchedules();
  let count = 0;
  for (const schedule of schedules) {
    if (!schedule.enabled) continue;
    registerJob(schedule, client);
    count++;
  }
  console.log(`[scheduler] loaded ${count} active schedule(s)`);
}

function stopScheduler() {
  for (const [id, job] of activeJobs) {
    job.stop();
  }
  activeJobs.clear();
}

module.exports = {
  RECAP_PREGENERATE_MS,
  TASK_TYPES,
  VALID_TASK_TYPES,
  startScheduler,
  stopScheduler,
  registerJob,
  unregisterJob,
  executeScheduledTask,
  buildCronExpression,
  subtractScheduleMinute,
  recapNotBeforeMs,
  waitUntil,
  sendAtOrAfter,
};
