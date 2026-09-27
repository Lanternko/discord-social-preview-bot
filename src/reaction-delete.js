const { PermissionsBitField } = require("discord.js");
const { BOT_OWNER_IDS } = require("./config");
const { describeMessageLocation } = require("./discord-io");

// 在西寶自己發的訊息上按 🗑️ 反應即可請它刪掉那則（連結傳錯時清掉誤發的預覽）。
// U+1F5D1 是垃圾桶本體；Discord 可能帶或不帶 U+FE0F variation selector，兩種
// 都要接受，所以比較前先去掉 FE0F。
const TRASH_CODEPOINT = "\u{1F5D1}";

function isTrashEmoji(name) {
  if (typeof name !== "string") return false;
  return name.replace(/\uFE0F/g, "") === TRASH_CODEPOINT;
}

// 誰貼的連結：西寶的預覽是對原訊息的 reply，reference 指回原訊息，所以不必額外
// 維護狀態就能認出貼文者。原訊息已被刪 / 非 reply（REPLY_MODE=send）→ 回 null，
// 改由下面的 ManageMessages 授權把關。
async function getTriggerAuthorId(botMessage) {
  if (!botMessage.reference?.messageId) return null;
  if (typeof botMessage.fetchReference !== "function") return null;
  try {
    const original = await botMessage.fetchReference();
    return original.author?.id ?? null;
  } catch {
    return null;
  }
}

// 允許刪除的條件（預設保守，避免路人亂刪）：
//   0. bot owner（BOT_OWNER_IDS）——跨伺服器最高權限，原訊息刪了也能清孤兒預覽
//   1. 貼連結的本人（用 reply reference 認出）
//   2. 該頻道有「管理訊息」權限的管理員（清理誤發／別人觸發的預覽）
async function isAuthorizedToDelete(botMessage, user) {
  if (BOT_OWNER_IDS.includes(user.id)) return true;

  const triggerAuthorId = await getTriggerAuthorId(botMessage);
  if (triggerAuthorId && triggerAuthorId === user.id) return true;

  const guild = botMessage.guild;
  if (!guild) return false;
  let member;
  try {
    member =
      guild.members.cache.get(user.id) || (await guild.members.fetch(user.id));
  } catch {
    return false;
  }
  const perms = botMessage.channel?.permissionsFor(member);
  return Boolean(perms?.has(PermissionsBitField.Flags.ManageMessages));
}

async function handleReactionDelete(reaction, user, client) {
  // 忽略任何機器人（含西寶自己，避免未來若預貼 🗑️ 提示時自我刪除）的反應。
  if (!user || user.bot || !client?.user) return;

  // emoji 身分在 partial 反應上也拿得到，所以先用它過濾——絕大多數反應都不是
  // 🗑️，這樣它們就不會白白觸發一次 fetch。
  if (!isTrashEmoji(reaction.emoji?.name)) return;

  // 訊息可能是 partial：西寶重啟前送出、或已從快取移除的訊息，其反應事件只帶
  // 精簡的訊息物件，得先補齊才能讀 author / reference。
  let message = reaction.message;
  if (message.partial) {
    try {
      message = await message.fetch();
    } catch (error) {
      console.warn(`[delete] message fetch failed: ${error.message}`);
      return;
    }
  }

  // 只刪西寶自己發的訊息，絕不動別人的。
  if (message.author?.id !== client.user.id) return;

  if (!(await isAuthorizedToDelete(message, user))) return;

  try {
    await message.delete();
    console.log(
      `[delete] removed message id=${message.id} by=${user.id} ${describeMessageLocation(message)}`,
    );
  } catch (error) {
    console.warn(`[delete] delete failed id=${message.id}: ${error.message}`);
  }
}

module.exports = {
  TRASH_CODEPOINT,
  isTrashEmoji,
  getTriggerAuthorId,
  isAuthorizedToDelete,
  handleReactionDelete,
};
