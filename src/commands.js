const { MessageFlags, PermissionsBitField } = require("discord.js");
const { getMissingChannelPermissions } = require("./discord-io");
const { getGuildTier, setGuildTier, isValidTier } = require("./tier-store");
const { TIER_UI_LABELS } = require("./tier-config");

const SERVER_COUNT_COMMAND = {
  name: "servers",
  description: "顯示目前機器人加入的伺服器數量",
};

const DEBUG_PERMS_COMMAND = {
  name: "debug-perms",
  description: "檢查目前頻道裡機器人的權限",
};

const TIER_COMMAND = {
  name: "tier",
  description: "查看或切換西寶的回覆詳細度（需管理伺服器權限）",
  defaultMemberPermissions: PermissionsBitField.Flags.ManageGuild,
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

async function ensureApplicationCommands(client) {
  const expectedCommands = [
    SERVER_COUNT_COMMAND,
    DEBUG_PERMS_COMMAND,
    TIER_COMMAND,
  ];
  const commands = await client.application.commands.fetch();
  for (const expectedCommand of expectedCommands) {
    const existing = commands.find((c) => c.name === expectedCommand.name);

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
  }
}

module.exports = {
  SERVER_COUNT_COMMAND,
  DEBUG_PERMS_COMMAND,
  TIER_COMMAND,
  ensureApplicationCommands,
  buildPermissionDebugMessage,
  handleTierCommand,
  handleInteraction,
};
