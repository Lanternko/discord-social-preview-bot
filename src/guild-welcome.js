// 加入新伺服器時的自我介紹。
//
// Fixed text on purpose, not an AI call: it has to land even when the whole
// provider chain is dead, and it must not spend the new guild's daily quota
// before anyone has said a word.

const { ChannelType, PermissionFlagsBits } = require("discord.js");
const { AI_FREE_DAILY_LIMIT } = require("./config");

const REQUIRED_PERMS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
];

function canPostIn(channel, me) {
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  const perms = channel.permissionsFor(me);
  return Boolean(perms && perms.has(REQUIRED_PERMS));
}

// The server's system channel (where Discord posts "X joined") is where admins
// expect a bot to introduce itself. Fall back to the top-most text channel we
// can actually speak in, so a locked-down system channel doesn't mean silence.
function pickWelcomeChannel(guild) {
  const me = guild.members?.me;
  if (!me) return null;
  if (canPostIn(guild.systemChannel, me)) return guild.systemChannel;
  const candidates = [...guild.channels.cache.values()]
    .filter((ch) => canPostIn(ch, me))
    .sort((a, b) => a.rawPosition - b.rawPosition);
  return candidates[0] || null;
}

function buildWelcomeMessage({ dailyLimit = AI_FREE_DAILY_LIMIT } = {}) {
  return [
    "大家好，我是西寶 👋 謝謝邀請我進來～",
    "",
    "- 貼 Threads、X、IG、Reddit、Pixiv、Bilibili、巴哈、PTT 等連結，我會幫忙補上完整預覽（影片會直接上傳成能播的）",
    `- \`@西寶\` 可以跟我聊天，整個伺服器每天免費 ${dailyLimit} 次；管理員用 \`/ai-key\` 放 DeepSeek 金鑰就能解鎖更多`,
    "- 管理員可以用 `/schedule` 排床邊故事、早安問候或今日回顧",
    "- 預覽貼錯了，在我的訊息按 🗑️ 就會收掉",
    "",
    "想知道我還會什麼，就 @我問，或打 `/help` 看完整說明 ✨",
  ].join("\n");
}

async function sendGuildWelcome(guild) {
  const channel = pickWelcomeChannel(guild);
  if (!channel) {
    console.log(`[welcome] no postable channel guild=${guild.id} (${guild.name})`);
    return false;
  }
  try {
    await channel.send({ content: buildWelcomeMessage() });
    console.log(`[welcome] sent guild=${guild.id} channel=${channel.id}`);
    return true;
  } catch (error) {
    console.warn(`[welcome] send failed guild=${guild.id}: ${error.message}`);
    return false;
  }
}

module.exports = { pickWelcomeChannel, buildWelcomeMessage, sendGuildWelcome };
