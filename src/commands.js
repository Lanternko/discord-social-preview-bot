const { MessageFlags, PermissionsBitField } = require("discord.js");
const { getMissingChannelPermissions } = require("./discord-io");

const SERVER_COUNT_COMMAND = {
  name: "servers",
  description: "顯示目前機器人加入的伺服器數量",
};

const DEBUG_PERMS_COMMAND = {
  name: "debug-perms",
  description: "檢查目前頻道裡機器人的權限",
};

async function ensureApplicationCommands(client) {
  const expectedCommands = [SERVER_COUNT_COMMAND, DEBUG_PERMS_COMMAND];
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
  }
}

module.exports = {
  SERVER_COUNT_COMMAND,
  DEBUG_PERMS_COMMAND,
  ensureApplicationCommands,
  buildPermissionDebugMessage,
  handleInteraction,
};
