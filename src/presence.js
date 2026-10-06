const { ActivityType } = require("discord.js");

// 西寶's custom status bubble: "正在陪 N 個伺服器聊天".
//
// Updated on guild join/leave, but debounced: presence updates are rate
// limited by the gateway (~5 per 20 s), so a burst of joins/leaves collapses
// into one update carrying the final count. A periodic refresh re-asserts the
// status because a gateway re-identify can drop it, and keeps the count honest
// if an event was ever missed. Presence is global (not per guild), so the text
// stays in 西寶's own voice instead of following /language.

const UPDATE_DEBOUNCE_MS = 30_000;
const REFRESH_INTERVAL_MS = 10 * 60_000;

let debounceTimer = null;
let refreshTimer = null;

function formatGuildCountStatus(count) {
  return `正在陪 ${count} 個伺服器聊天`;
}

function applyGuildCountStatus(client) {
  if (!client.user) return;
  try {
    client.user.setPresence({
      activities: [
        {
          type: ActivityType.Custom,
          name: "custom", // required by the API, never displayed for Custom
          state: formatGuildCountStatus(client.guilds.cache.size),
        },
      ],
      status: "online",
    });
  } catch (error) {
    console.warn(`[presence] update failed: ${error.message}`);
  }
}

function scheduleGuildCountStatus(client) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    applyGuildCountStatus(client);
  }, UPDATE_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

function startPresenceRefresh(client) {
  applyGuildCountStatus(client);
  if (refreshTimer) return;
  refreshTimer = setInterval(() => applyGuildCountStatus(client), REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();
}

function stopPresenceRefresh() {
  if (debounceTimer) clearTimeout(debounceTimer);
  if (refreshTimer) clearInterval(refreshTimer);
  debounceTimer = null;
  refreshTimer = null;
}

module.exports = {
  formatGuildCountStatus,
  applyGuildCountStatus,
  scheduleGuildCountStatus,
  startPresenceRefresh,
  stopPresenceRefresh,
};
