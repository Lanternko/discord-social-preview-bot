const { MessageFlags, PermissionsBitField, ChannelType } = require("discord.js");
const { getMissingChannelPermissions } = require("./discord-io");
const { getGuildTier, setGuildTier, isValidTier } = require("./tier-store");
const { TIER_UI_LABELS } = require("./tier-config");
const {
  getGuildSchedules,
  getScheduleById,
  addSchedule,
  removeSchedule,
} = require("./schedule-store");
const {
  TASK_TYPES,
  VALID_TASK_TYPES,
  registerJob,
  unregisterJob,
} = require("./scheduler");

const SERVER_COUNT_COMMAND = {
  name: "servers",
  description: "顯示目前機器人加入的伺服器數量",
};

const DEBUG_PERMS_COMMAND = {
  name: "debug-perms",
  description: "檢查目前頻道裡機器人的權限",
};

// View (no arg) is open to anyone — the actual setter still gates on
// ManageGuild inside handleTierCommand. We intentionally do NOT set
// defaultMemberPermissions so non-admins can still query the current value.
const TIER_COMMAND = {
  name: "tier",
  description: "查看西寶的回覆詳細度（切換需管理伺服器權限）",
  options: [
    {
      name: "level",
      description: "要切換的詳細度（不填則顯示目前設定）",
      type: 3, // STRING
      required: false,
      choices: [
        { name: "簡短", value: "brief" },
        { name: "標準", value: "standard" },
        { name: "精細", value: "detailed" },
      ],
    },
  ],
};

const SCHEDULE_COMMAND = {
  name: "schedule",
  description: "管理西寶的定時任務（新增 / 列出 / 刪除）",
  options: [
    {
      name: "add",
      description: "新增定時任務",
      type: 1, // SUB_COMMAND
      options: [
        {
          name: "channel",
          description: "要發送的頻道",
          type: 7, // CHANNEL
          required: true,
          channel_types: [ChannelType.GuildText],
        },
        {
          name: "time",
          description: "每天執行時間（24小時制，如 23:00）",
          type: 3, // STRING
          required: true,
        },
        {
          name: "task",
          description: "任務類型",
          type: 3, // STRING
          required: true,
          choices: VALID_TASK_TYPES.map((key) => ({
            name: TASK_TYPES[key].label,
            value: key,
          })),
        },
      ],
    },
    {
      name: "list",
      description: "列出這個伺服器的所有定時任務",
      type: 1, // SUB_COMMAND
    },
    {
      name: "remove",
      description: "刪除定時任務",
      type: 1, // SUB_COMMAND
      options: [
        {
          name: "id",
          description: "要刪除的任務 ID（用 /schedule list 查看）",
          type: 3, // STRING
          required: true,
        },
      ],
    },
  ],
};

// Returns true when the registered command matches the expected spec on the
// fields we care about. Currently checks description + defaultMemberPermissions
// — extend here if we ever start diffing options.
function commandSpecMatches(existing, expected) {
  if (existing.description !== expected.description) return false;

  const expectedDmpRaw = expected.defaultMemberPermissions;
  const hasExpectedDmp =
    expectedDmpRaw !== undefined && expectedDmpRaw !== null;
  const hasExistingDmp =
    existing.defaultMemberPermissions !== null &&
    existing.defaultMemberPermissions !== undefined;
  if (hasExpectedDmp !== hasExistingDmp) return false;
  if (
    hasExpectedDmp &&
    !existing.defaultMemberPermissions.equals(BigInt(expectedDmpRaw))
  ) {
    return false;
  }

  return true;
}

async function ensureApplicationCommands(client) {
  const expectedCommands = [
    SERVER_COUNT_COMMAND,
    DEBUG_PERMS_COMMAND,
    TIER_COMMAND,
    SCHEDULE_COMMAND,
  ];
  const commands = await client.application.commands.fetch();
  for (const expectedCommand of expectedCommands) {
    const existing = commands.find((c) => c.name === expectedCommand.name);

    if (!existing) {
      await client.application.commands.create(expectedCommand);
      console.log(`[commands] registered /${expectedCommand.name}`);
      continue;
    }

    if (!commandSpecMatches(existing, expectedCommand)) {
      await existing.edit(expectedCommand);
      console.log(`[commands] updated /${expectedCommand.name}`);
    }
  }
}

function buildPermissionDebugMessage(interaction) {
  if (!interaction.inGuild() || !interaction.guild) {
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

  lines.push(`ManageMessages：${hasManageMessages ? "有" : "沒有"}`);

  return lines.join("\n");
}

async function handleTierCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "這個指令只能在伺服器裡使用。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const level = interaction.options.getString("level");
  const guildId = interaction.guildId;

  if (!level) {
    const current = getGuildTier(guildId);
    await interaction.reply({
      content: `目前西寶的詳細度：**${TIER_UI_LABELS[current]}**\n（可切換：簡短 / 標準 / 精細；需管理伺服器權限）`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isValidTier(level)) {
    await interaction.reply({
      content: `未知的詳細度：${level}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Defence in depth: defaultMemberPermissions already gates at Discord
  // level, but re-check so a mis-configured server can't bypass.
  const member = interaction.member;
  const canManageGuild = member?.permissions?.has?.(
    PermissionsBitField.Flags.ManageGuild,
  );
  if (!canManageGuild) {
    await interaction.reply({
      content: "需要「管理伺服器」權限才能切換詳細度。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    setGuildTier(guildId, level);
    console.log(`[tier] guild=${guildId} set tier=${level} by user=${interaction.user.id}`);
    await interaction.reply({
      content: `西寶的詳細度已切換為 **${TIER_UI_LABELS[level]}**。`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (err) {
    console.warn(`[tier] setGuildTier failed: ${err.message}`);
    await interaction.reply({
      content: "切換失敗，請稍後再試。",
      flags: MessageFlags.Ephemeral,
    });
  }
}

// ── Time parsing ──────────────────────────────────────────────────────
function parseTime(str) {
  const m = str.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

// ── /schedule handler ─────────────────────────────────────────────────
async function handleScheduleCommand(interaction, client) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "這個指令只能在伺服器裡使用。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  // ── list ──
  if (sub === "list") {
    const schedules = getGuildSchedules(guildId);
    if (schedules.length === 0) {
      await interaction.reply({
        content: "這個伺服器還沒有任何定時任務。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const lines = schedules.map((s) => {
      const taskLabel = TASK_TYPES[s.taskType]?.label ?? s.taskType;
      const time = `${String(s.hour).padStart(2, "0")}:${String(s.minute).padStart(2, "0")}`;
      const status = s.enabled ? "✅" : "⏸️";
      return `${status} \`${s.id}\` — <#${s.channelId}> 每天 ${time}　${taskLabel}`;
    });
    await interaction.reply({
      content: `**定時任務列表**\n${lines.join("\n")}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ── add / remove require ManageGuild ──
  const canManage = interaction.member?.permissions?.has?.(
    PermissionsBitField.Flags.ManageGuild,
  );
  if (!canManage) {
    await interaction.reply({
      content: "需要「管理伺服器」權限才能新增或刪除定時任務。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // ── add ──
  if (sub === "add") {
    const channel = interaction.options.getChannel("channel");
    const timeStr = interaction.options.getString("time");
    const taskType = interaction.options.getString("task");

    const parsed = parseTime(timeStr);
    if (!parsed) {
      await interaction.reply({
        content: "時間格式錯誤，請用 24 小時制如 `23:00`。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    try {
      const entry = addSchedule({
        guildId,
        channelId: channel.id,
        hour: parsed.hour,
        minute: parsed.minute,
        taskType,
        timezone: "Asia/Taipei",
        createdBy: interaction.user.id,
      });
      registerJob(entry, client);
      const taskLabel = TASK_TYPES[taskType]?.label ?? taskType;
      const time = `${String(parsed.hour).padStart(2, "0")}:${String(parsed.minute).padStart(2, "0")}`;
      console.log(
        `[scheduler] added schedule=${entry.id} guild=${guildId} channel=${channel.id} time=${time} task=${taskType} by=${interaction.user.id}`,
      );
      await interaction.reply({
        content: `已新增定時任務！\n📋 ID: \`${entry.id}\`\n📍 頻道: <#${channel.id}>\n🕐 時間: 每天 ${time}\n📝 任務: ${taskLabel}`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      await interaction.reply({
        content: `新增失敗：${err.message}`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  // ── remove ──
  if (sub === "remove") {
    const id = interaction.options.getString("id");
    const schedule = getScheduleById(id);

    if (!schedule || schedule.guildId !== guildId) {
      await interaction.reply({
        content: `找不到 ID 為 \`${id}\` 的任務（用 \`/schedule list\` 查看）。`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    removeSchedule(id);
    unregisterJob(id);
    const taskLabel = TASK_TYPES[schedule.taskType]?.label ?? schedule.taskType;
    console.log(
      `[scheduler] removed schedule=${id} guild=${guildId} by=${interaction.user.id}`,
    );
    await interaction.reply({
      content: `已刪除定時任務 \`${id}\`（${taskLabel}）。`,
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function handleInteraction(interaction, client) {
  if (!interaction.isChatInputCommand()) return;

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
    return;
  }

  if (interaction.commandName === TIER_COMMAND.name) {
    await handleTierCommand(interaction);
    return;
  }

  if (interaction.commandName === SCHEDULE_COMMAND.name) {
    await handleScheduleCommand(interaction, client);
  }
}

module.exports = {
  SERVER_COUNT_COMMAND,
  DEBUG_PERMS_COMMAND,
  TIER_COMMAND,
  SCHEDULE_COMMAND,
  ensureApplicationCommands,
  buildPermissionDebugMessage,
  handleTierCommand,
  handleScheduleCommand,
  handleInteraction,
};
