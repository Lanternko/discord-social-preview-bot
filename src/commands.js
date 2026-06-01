const { MessageFlags, PermissionsBitField, ChannelType } = require("discord.js");
const { getMissingChannelPermissions } = require("./discord-io");
const { getGuildTier, setGuildTier, isValidTier } = require("./tier-store");
const {
  TIERS,
  TIER_UI_LABELS,
  TIER_REQUIRES_KEY,
} = require("./tier-config");
const {
  getGuildSchedules,
  getScheduleById,
  addSchedule,
  removeSchedule,
} = require("./schedule-store");
const {
  getUserProfile,
  deleteUserProfile,
} = require("./user-profile-store");
const {
  getGuildProfile,
} = require("./guild-profile-store");
const {
  TASK_TYPES,
  VALID_TASK_TYPES,
  registerJob,
  unregisterJob,
} = require("./scheduler");
const {
  hasGuildApiKey,
  setGuildApiKey,
  removeGuildApiKey,
} = require("./ai/guild-key-store");
const { getUsage } = require("./ai/rate-limiter");
const {
  DEEPSEEK_MODEL,
  DEEPSEEK_MODEL_FREE,
  DEEPSEEK_PREMIUM_GUILD_IDS,
  AI_FREE_DAILY_LIMIT,
} = require("./config");

const SERVER_COUNT_COMMAND = {
  name: "servers",
  description: "顯示目前機器人加入的伺服器數量",
};

const DEBUG_PERMS_COMMAND = {
  name: "debug-perms",
  description: "檢查目前頻道裡機器人的權限",
};

const TIER_COMMAND = {
  name: "ai-tier",
  description: "查看或切換西寶的 AI 方案（切換需管理伺服器權限）",
  options: [
    {
      name: "level",
      description: "要切換的方案（不填則顯示目前設定）",
      type: 3, // STRING
      required: false,
      choices: [
        { name: "入門 — flash，1~4 句", value: "brief" },
        { name: "標準 — pro，2~8 句（需 API 金鑰）", value: "standard" },
        { name: "精細 — pro，3~15 句（需 API 金鑰）", value: "detailed" },
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

const MEMORY_COMMAND = {
  name: "memory",
  description: "查看或刪除西寶對你的長期記憶",
  options: [
    {
      name: "show",
      description: "查看西寶對你的記憶",
      type: 1, // SUB_COMMAND
    },
    {
      name: "forget-me",
      description: "刪除西寶對你的所有記憶",
      type: 1, // SUB_COMMAND
    },
    {
      name: "forget-user",
      description: "刪除西寶對指定使用者的記憶（需管理伺服器權限）",
      type: 1, // SUB_COMMAND
      options: [
        {
          name: "user",
          description: "要刪除記憶的使用者",
          type: 6, // USER
          required: true,
        },
      ],
    },
    {
      name: "guild",
      description: "查看西寶對這個群的記憶",
      type: 1, // SUB_COMMAND
    },
  ],
};

const AI_KEY_COMMAND = {
  name: "ai-key",
  description: "管理這個伺服器的 AI API 金鑰",
  options: [
    {
      name: "status",
      description: "查看目前的 AI 方案狀態",
      type: 1, // SUB_COMMAND
    },
    {
      name: "set",
      description: "設定 DeepSeek API 金鑰（解鎖進階模型 + 無限額度）",
      type: 1, // SUB_COMMAND
      options: [
        {
          name: "key",
          description: "你的 DeepSeek API 金鑰",
          type: 3, // STRING
          required: true,
        },
      ],
    },
    {
      name: "remove",
      description: "移除已設定的 API 金鑰",
      type: 1, // SUB_COMMAND
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
    MEMORY_COMMAND,
    AI_KEY_COMMAND,
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

  const expectedNames = new Set(expectedCommands.map((c) => c.name));
  for (const [, cmd] of commands) {
    if (!expectedNames.has(cmd.name)) {
      await cmd.delete();
      console.log(`[commands] deleted stale /${cmd.name}`);
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

function getTierModelLabel(tierKey) {
  if (tierKey === "brief") return `\`${DEEPSEEK_MODEL_FREE}\`（flash）`;
  return `\`${DEEPSEEK_MODEL}\`（pro）`;
}

function getTierContextLabel(tierConfig) {
  if (!tierConfig.groupContextCount) return "不讀群組脈絡";
  return `會讀被 @ 前最近 ${tierConfig.groupContextCount} 則非 bot 訊息`;
}

function getTierQuotaLine(tierKey, { hasKey, isWhitelisted, usage }) {
  if (TIER_REQUIRES_KEY[tierKey]) {
    if (hasKey) return "額度：無限制（使用本伺服器自訂 DeepSeek API 金鑰）";
    if (isWhitelisted) return "額度：無限制（白名單使用維護者金鑰）";
    return "額度：需要先用 `/ai-key set` 設定 DeepSeek API 金鑰";
  }

  if (hasKey) {
    return "額度：無限制（已有自訂金鑰；入門仍使用 flash 模型）";
  }
  if (isWhitelisted) {
    return "額度：無限制（白名單；入門仍使用 flash 模型）";
  }
  return `每日免費額度：${usage?.count ?? 0} / ${AI_FREE_DAILY_LIMIT}（超過後改用 Groq / Gemini 備援）`;
}

function buildTierDetailLines(tierKey, status) {
  const tierConfig = TIERS[tierKey];
  return [
    `模型：${getTierModelLabel(tierKey)}`,
    `回覆：${tierConfig.sentenceMin}~${tierConfig.sentenceMax} 句，最多 ${tierConfig.maxReplyChars} 字`,
    `短期記憶：每頻道最近 ${tierConfig.memoryMaxTurns} 輪，30 分鐘沒聊天會清空`,
    `群組脈絡：${getTierContextLabel(tierConfig)}`,
    getTierQuotaLine(tierKey, status),
  ];
}

function buildTierOptionLine(tierKey, current, hasKey, isWhitelisted) {
  const tierConfig = TIERS[tierKey];
  const marker = tierKey === current ? "（目前）" : "";
  const lock = TIER_REQUIRES_KEY[tierKey] && !hasKey && !isWhitelisted ? " 🔒" : "";
  const keyRequirement = TIER_REQUIRES_KEY[tierKey] ? "需金鑰" : `${AI_FREE_DAILY_LIMIT}/天免費`;
  return [
    `**${TIER_UI_LABELS[tierKey]}**${marker}${lock} — ${getTierModelLabel(tierKey)}，${tierConfig.sentenceMin}~${tierConfig.sentenceMax} 句`,
    `　記憶 ${tierConfig.memoryMaxTurns} 輪；${getTierContextLabel(tierConfig)}；${keyRequirement}`,
  ];
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
    const hasKey = hasGuildApiKey(guildId);
    const isWhitelisted = DEEPSEEK_PREMIUM_GUILD_IDS.includes(guildId);
    const usage = getUsage(guildId);

    const status = { hasKey, isWhitelisted, usage };
    const lines = [
      `**目前方案：${TIER_UI_LABELS[current]}**`,
      ...buildTierDetailLines(current, status),
    ];
    lines.push("");
    lines.push("**方案差異：**");
    for (const key of Object.keys(TIER_UI_LABELS)) {
      lines.push(...buildTierOptionLine(key, current, hasKey, isWhitelisted));
    }
    if (!hasKey && !isWhitelisted) {
      lines.push("");
      lines.push("🔒 = 需先用 `/ai-key set` 設定 DeepSeek API 金鑰");
    }
    lines.push("");
    lines.push("所有成員都能查看；切換方案需要「管理伺服器」權限。");
    await interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isValidTier(level)) {
    await interaction.reply({
      content: `未知的方案：${level}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member;
  const canManageGuild = member?.permissions?.has?.(
    PermissionsBitField.Flags.ManageGuild,
  );
  if (!canManageGuild) {
    await interaction.reply({
      content: "需要「管理伺服器」權限才能切換方案。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (TIER_REQUIRES_KEY[level] && !hasGuildApiKey(guildId) && !DEEPSEEK_PREMIUM_GUILD_IDS.includes(guildId)) {
    await interaction.reply({
      content: `**${TIER_UI_LABELS[level]}**方案需要 DeepSeek API 金鑰。\n請先使用 \`/ai-key set\` 設定金鑰後再切換。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  try {
    setGuildTier(guildId, level);
    console.log(`[tier] guild=${guildId} set tier=${level} by user=${interaction.user.id}`);
    const status = {
      hasKey: hasGuildApiKey(guildId),
      isWhitelisted: DEEPSEEK_PREMIUM_GUILD_IDS.includes(guildId),
      usage: getUsage(guildId),
    };
    await interaction.reply({
      content: [
        `已切換為 **${TIER_UI_LABELS[level]}** 方案。`,
        ...buildTierDetailLines(level, status),
        "",
        "這個設定已儲存，重啟後仍會保留。",
      ].join("\n"),
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

async function handleMemoryCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "這個指令只能在伺服器裡使用。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (sub === "show") {
    const profile = getUserProfile(guildId, interaction.user.id);
    if (!profile) {
      await interaction.reply({
        content: "西寶目前對你還沒有任何記憶。多跟她聊聊吧！",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines = [`**西寶對你的記憶**`];
    lines.push(`暱稱：${profile.name || "未知"}`);

    if (profile.profile) {
      lines.push(`\n📝 **人格摘要**\n${profile.profile}`);
    }

    const obs = profile.observations || [];
    if (obs.length > 0) {
      lines.push(`\n🔍 **待整理的觀察（${obs.length} 條）**`);
      for (const o of obs.slice(0, 10)) {
        lines.push(`- ${o.text}（信心 ${o.confidence}）`);
      }
      if (obs.length > 10) lines.push(`…還有 ${obs.length - 10} 條`);
    }

    const pending = profile.pendingInteractions || [];
    if (pending.length > 0) {
      lines.push(`\n⏳ 待萃取互動：${pending.length} 筆`);
    }

    await interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "forget-me") {
    const deleted = deleteUserProfile(guildId, interaction.user.id);
    if (deleted) {
      console.log(`[memory] user=${interaction.user.id} guild=${guildId} self-deleted`);
      await interaction.reply({
        content: "已刪除西寶對你的所有記憶。",
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: "西寶本來就沒有你的記憶。",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (sub === "forget-user") {
    const canManageGuild = interaction.member?.permissions?.has?.(
      PermissionsBitField.Flags.ManageGuild,
    );
    if (!canManageGuild) {
      await interaction.reply({
        content: "需要「管理伺服器」權限才能刪除別人的記憶。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const target = interaction.options.getUser("user");
    const deleted = deleteUserProfile(guildId, target.id);
    if (deleted) {
      console.log(`[memory] user=${target.id} guild=${guildId} deleted by admin=${interaction.user.id}`);
      await interaction.reply({
        content: `已刪除西寶對 **${target.username}** 的所有記憶。`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: `西寶沒有 **${target.username}** 的記憶。`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (sub === "guild") {
    const guildProfile = getGuildProfile(guildId);
    if (!guildProfile) {
      await interaction.reply({
        content: "西寶目前對這個群還沒有印象。多聊聊就會有了！",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const lines = [`**西寶對這個群的印象**`];
    if (guildProfile.profile) {
      lines.push(`\n📝 **群組摘要**\n${guildProfile.profile}`);
    }

    const obs = guildProfile.observations || [];
    if (obs.length > 0) {
      lines.push(`\n🔍 **待整理的觀察（${obs.length} 條）**`);
      for (const o of obs.slice(0, 10)) {
        lines.push(`- ${o.text}（信心 ${o.confidence}）`);
      }
      if (obs.length > 10) lines.push(`…還有 ${obs.length - 10} 條`);
    }

    const pending = guildProfile.pendingContexts || [];
    if (pending.length > 0) {
      lines.push(`\n⏳ 待萃取上下文：${pending.length} 筆`);
    }

    if (!guildProfile.profile && obs.length === 0 && pending.length === 0) {
      lines.push("還沒有任何資料，多聊聊就會有了！");
    }

    await interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
}

async function handleAiKeyCommand(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "這個指令只能在伺服器裡使用。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  if (sub === "status") {
    const hasKey = hasGuildApiKey(guildId);
    const isWhitelisted = DEEPSEEK_PREMIUM_GUILD_IDS.includes(guildId);
    const isPremium = hasKey || isWhitelisted;

    const lines = ["**AI 方案狀態**"];
    if (hasKey) {
      lines.push("方案：進階（自訂金鑰）");
      lines.push(`模型：\`${DEEPSEEK_MODEL}\``);
      lines.push("額度：無限制");
    } else if (isWhitelisted) {
      lines.push("方案：進階（白名單）");
      lines.push(`模型：\`${DEEPSEEK_MODEL}\``);
      lines.push("額度：無限制");
    } else {
      const usage = getUsage(guildId);
      lines.push("方案：免費");
      lines.push(`模型：\`${DEEPSEEK_MODEL_FREE}\`（超過額度後使用備用模型）`);
      lines.push(`今日用量：${usage?.count ?? 0} / ${AI_FREE_DAILY_LIMIT}`);
    }
    await interaction.reply({
      content: lines.join("\n"),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const canManageGuild = interaction.member?.permissions?.has?.(
    PermissionsBitField.Flags.ManageGuild,
  );
  if (!canManageGuild) {
    await interaction.reply({
      content: "需要「管理伺服器」權限才能設定或移除 API 金鑰。",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (sub === "set") {
    const key = interaction.options.getString("key");
    if (!key || !key.startsWith("sk-")) {
      await interaction.reply({
        content: "金鑰格式不正確，DeepSeek API 金鑰應以 `sk-` 開頭。",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    try {
      setGuildApiKey(guildId, key);
      console.log(`[ai-key] guild=${guildId} set by user=${interaction.user.id}`);
      await interaction.reply({
        content: `已設定 API 金鑰，本伺服器已升級為進階方案。\n模型：\`${DEEPSEEK_MODEL}\`\n額度：無限制`,
        flags: MessageFlags.Ephemeral,
      });
    } catch (err) {
      console.warn(`[ai-key] setGuildApiKey failed: ${err.message}`);
      await interaction.reply({
        content: "設定失敗，請稍後再試。",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  if (sub === "remove") {
    const removed = removeGuildApiKey(guildId);
    if (removed) {
      console.log(`[ai-key] guild=${guildId} removed by user=${interaction.user.id}`);
      await interaction.reply({
        content: `已移除 API 金鑰，本伺服器已回到免費方案。\n模型：\`${DEEPSEEK_MODEL_FREE}\`\n每日額度：${AI_FREE_DAILY_LIMIT} 次`,
        flags: MessageFlags.Ephemeral,
      });
    } else {
      await interaction.reply({
        content: "本伺服器沒有設定過 API 金鑰。",
        flags: MessageFlags.Ephemeral,
      });
    }
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
    return;
  }

  if (interaction.commandName === MEMORY_COMMAND.name) {
    await handleMemoryCommand(interaction);
    return;
  }

  if (interaction.commandName === AI_KEY_COMMAND.name) {
    await handleAiKeyCommand(interaction);
  }
}

module.exports = {
  SERVER_COUNT_COMMAND,
  DEBUG_PERMS_COMMAND,
  TIER_COMMAND,
  SCHEDULE_COMMAND,
  MEMORY_COMMAND,
  AI_KEY_COMMAND,
  ensureApplicationCommands,
  buildPermissionDebugMessage,
  handleTierCommand,
  handleScheduleCommand,
  handleMemoryCommand,
  handleAiKeyCommand,
  handleInteraction,
};
