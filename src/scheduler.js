const cron = require("node-cron");
const { getAllSchedules, getScheduleById, updateSchedule } = require("./schedule-store");
const { getTierConfig } = require("./tier-config");
const { trimDescription } = require("./utils");
const { AI_PROVIDER_CHAIN, runProviderChain } = require("./ai/chain");
const {
  getFamiliarityRoster,
  buildFamiliarityBlock,
} = require("./familiarity");
const {
  fetchGuildMessages,
  buildRecapStats,
  buildRecapPrompt,
} = require("./daily-recap");

// ── Task types ──────────────────────────────────────────────────────────
// Static tasks have a `prompt` string; dynamic tasks have a `buildPrompt`
// async function that receives (channel, client) and returns a prompt string.
const TASK_TYPES = {
  bedtime_story: {
    label: "床邊故事",
    prompt:
      "（系統提示：現在是睡前時間。請主動講一個短短的原創床邊故事，溫馨可愛的那種。每次要講不同的故事。故事講完後，用你平常的語氣哄大家去睡覺。）",
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

// ── Task execution ──────────────────────────────────────────────────────

async function executeScheduledTask(schedule, client) {
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
  if (taskDef && taskDef.buildPrompt) {
    prompt = await taskDef.buildPrompt(channel, client);
  } else {
    prompt = customPrompt || (taskDef && taskDef.prompt);
  }

  if (!prompt) {
    console.warn(
      `[scheduler] empty prompt for schedule=${schedule.id}`,
    );
    return;
  }

  if (AI_PROVIDER_CHAIN.length === 0) {
    console.warn("[scheduler] no AI providers, skipping scheduled task");
    return;
  }

  const tierConfig = getTierConfig(guildId);
  let persona = tierConfig.persona;

  // Append familiarity roster so 西寶 knows who's who, same as live replies.
  const roster = getFamiliarityRoster(guildId);
  if (roster.length > 0) {
    persona += buildFamiliarityBlock(roster);
  }

  const turns = [{ role: "user", content: prompt }];

  try {
    const result = await runProviderChain(
      AI_PROVIDER_CHAIN,
      turns,
      persona,
      tierConfig.maxTokens,
    );

    if (!result) {
      console.warn(
        `[scheduler] AI chain exhausted for schedule=${schedule.id}`,
      );
      return;
    }

    const text = trimDescription(result.text, tierConfig.maxReplyChars);
    const sent = await channel.send({ content: text });
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

function registerJob(schedule, client) {
  if (activeJobs.has(schedule.id)) {
    // Already registered — unregister first to avoid duplicates.
    unregisterJob(schedule.id);
  }

  const cronExpr = buildCronExpression(schedule.hour, schedule.minute);
  const tz = schedule.timezone || "Asia/Taipei";

  const task = cron.schedule(
    cronExpr,
    () => {
      // Re-read the schedule from store in case it was disabled/removed
      // between registration and execution.
      const current = getScheduleById(schedule.id);
      if (!current || !current.enabled) {
        console.log(
          `[scheduler] skipping disabled/removed schedule=${schedule.id}`,
        );
        return;
      }
      executeScheduledTask(current, client).catch((err) => {
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
  TASK_TYPES,
  VALID_TASK_TYPES,
  startScheduler,
  stopScheduler,
  registerJob,
  unregisterJob,
  executeScheduledTask,
};
