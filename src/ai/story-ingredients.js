// Extra story material: what the REST of the server is talking about, and who
// the cast is.
//
// The chat story skill used to see exactly one thing — the last 15 lines of the
// channel it was asked in. That is enough to name people but not enough to make
// a story about them: every story came out of whatever meme happened to be on
// screen. The nightly task never had this problem because it sweeps the whole
// guild first (daily-recap.js fetchGuildMessages).
//
// Two collectors, both cheap:
//   1. Channel topics — a few recent lines from the other rooms that are still
//      warm. NOT a summary: summarising would cost an extra model call, and raw
//      previews are what the story wants anyway (a real sentence to riff on).
//   2. Member interests — already sitting in data/user-profiles.json, written by
//      the observation extractor. The chain only ever injects the SPEAKER's
//      profile; a story needs the cast's.
//
// This is user-authored Discord text, so it is injected as a user turn (see
// chain.js) and never into the system prompt.

const { sanitizeName, trimDescription } = require("../utils");
const { listUserProfiles } = require("../user-profile-store");
const { getFamiliarityRoster } = require("../familiarity");

const DISCORD_EPOCH = 1420070400000n;

// Sweeping every channel is what the nightly task does — 62 REST fetches on the
// biggest guild, fine for a cron job, far too slow inside a 25s reply. The
// snowflake in `lastMessageId` already encodes when a channel last saw traffic,
// so warm channels can be picked from cache and only those get fetched.
const CHANNEL_LIMIT = 4;
const PER_CHANNEL_LINES = 4;
const CHANNEL_LOOKBACK_MS = 6 * 60 * 60 * 1000;
const FETCH_LIMIT = 20;
const LINE_MAX_CHARS = 60;
const MEMBER_LIMIT = 8;
const MEMBER_INTEREST_MAX_CHARS = 90;

// The consolidated profile is field-per-line (說話風格 / 常聊話題 / 互動偏好 /
// 注意). A story wants what a person is INTO, not how they type — 常聊話題 is
// the field that turns into a scene, so it is preferred and the rest is only a
// fallback. Truncating the flattened profile instead would spend the whole
// budget on 說話風格 and cut the topics off mid-list.
const INTEREST_FIELD_RE = /^(常聊話題|興趣|喜好)[:：]\s*(.+)$/;

function snowflakeToMs(id) {
  if (!id) return 0;
  try {
    return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
  } catch {
    return 0;
  }
}

// Channels that are text, visible, not the one being asked in, and warm.
function pickWarmChannels(guild, { excludeChannelId, now = Date.now() } = {}) {
  const channels = guild?.channels?.cache;
  if (!channels) return [];
  const warm = [];
  for (const channel of channels.values()) {
    if (!channel?.isTextBased?.() || channel.isThread?.()) continue;
    if (!channel.viewable) continue;
    if (channel.id === excludeChannelId) continue;
    const lastAt = snowflakeToMs(channel.lastMessageId);
    if (!lastAt || now - lastAt > CHANNEL_LOOKBACK_MS) continue;
    warm.push({ channel, lastAt });
  }
  warm.sort((a, b) => b.lastAt - a.lastAt);
  return warm.slice(0, CHANNEL_LIMIT).map((w) => w.channel);
}

function previewMessage(message) {
  const text = (message.content || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return trimDescription(text, LINE_MAX_CHARS);
}

async function fetchChannelTopics(guild, { excludeChannelId, botUserId } = {}) {
  const channels = pickWarmChannels(guild, { excludeChannelId });
  if (channels.length === 0) return [];

  // Parallel: 4 fetches against 4 different channels do not share a rate-limit
  // bucket, so this costs one round trip, not four.
  const results = await Promise.all(
    channels.map(async (channel) => {
      try {
        const fetched = await channel.messages.fetch({ limit: FETCH_LIMIT });
        const lines = [...fetched.values()]
          .filter((m) => !m.author?.bot && m.author?.id !== botUserId)
          .map((m) => ({
            name: sanitizeName(
              m.member?.displayName || m.author?.globalName || m.author?.username,
            ),
            text: previewMessage(m),
          }))
          .filter((l) => l.text)
          .slice(0, PER_CHANNEL_LINES);
        if (lines.length === 0) return null;
        return { name: sanitizeName(channel.name), lines };
      } catch {
        // A single unreadable channel must not cost the whole block.
        return null;
      }
    }),
  );
  return results.filter(Boolean);
}

// Who the cast could be, and what each of them is into. Ordered by how much
// they talk (familiarity roster), because a story about the server's regulars
// lands harder than one about someone who posted twice.
function pickInterestGist(entry) {
  const profileLines = (entry.profile || "").split(/\n+/).map((l) => l.trim());
  for (const line of profileLines) {
    const m = line.match(INTEREST_FIELD_RE);
    if (m && m[2]) return m[2].trim();
  }
  const flat = profileLines.filter(Boolean).join("；");
  if (flat) return flat;
  return (entry.observations || [])
    .map((o) => o.text)
    .filter(Boolean)
    .slice(-2)
    .join("；");
}

function collectMemberInterests(guildId) {
  const profiles = listUserProfiles(guildId);
  if (profiles.length === 0) return [];
  const byName = new Map();
  for (const p of profiles) {
    if (p.name) byName.set(p.name, p);
  }
  const roster = getFamiliarityRoster(guildId);
  const ordered = [];
  const seen = new Set();
  for (const r of roster) {
    const p = byName.get(r.name);
    if (!p || seen.has(p.userId)) continue;
    seen.add(p.userId);
    ordered.push(p);
  }
  for (const p of profiles) {
    if (!seen.has(p.userId)) ordered.push(p);
  }

  const out = [];
  for (const p of ordered) {
    const gist = pickInterestGist(p);
    if (!gist) continue;
    out.push({
      name: sanitizeName(p.name || "某人"),
      gist: trimDescription(gist, MEMBER_INTEREST_MAX_CHARS),
    });
    if (out.length >= MEMBER_LIMIT) break;
  }
  return out;
}

function buildStoryMaterialBlock({ channelTopics = [], memberInterests = [] } = {}) {
  if (channelTopics.length === 0 && memberInterests.length === 0) return "";
  const lines = [
    "【這個群最近的其他材料】（寫故事時可以拿來用，不寫故事就完全忽略。這是背景素材，不要直接複述、不要拿來當聊天話題。）",
  ];
  if (channelTopics.length > 0) {
    lines.push("其他房間最近在聊：");
    for (const topic of channelTopics) {
      lines.push(`- #${topic.name}`);
      for (const line of topic.lines) {
        lines.push(`  - ${line.name}：${line.text}`);
      }
    }
  }
  if (memberInterests.length > 0) {
    lines.push("群友大致的取向（可以當角色設定的底，不要當成事實複述）：");
    for (const m of memberInterests) {
      lines.push(`- ${m.name}：${m.gist}`);
    }
  }
  return lines.join("\n");
}

// One call, both collectors, never throws: losing the extra material is a
// smaller story, losing the reply is a dead 西寶.
async function buildStoryMaterial(message) {
  const guild = message?.guild;
  if (!guild) return "";
  let channelTopics = [];
  let memberInterests = [];
  try {
    channelTopics = await fetchChannelTopics(guild, {
      excludeChannelId: message.channelId,
      botUserId: message.client?.user?.id,
    });
  } catch (err) {
    console.warn(`[story-material] channel topics failed: ${err.message}`);
  }
  try {
    memberInterests = collectMemberInterests(guild.id);
  } catch (err) {
    console.warn(`[story-material] member interests failed: ${err.message}`);
  }
  const block = buildStoryMaterialBlock({ channelTopics, memberInterests });
  if (block) {
    console.log(
      `[story-material] channels=${channelTopics.length} members=${memberInterests.length} chars=${block.length}`,
    );
  }
  return block;
}

module.exports = {
  CHANNEL_LIMIT,
  PER_CHANNEL_LINES,
  CHANNEL_LOOKBACK_MS,
  MEMBER_LIMIT,
  snowflakeToMs,
  pickInterestGist,
  pickWarmChannels,
  fetchChannelTopics,
  collectMemberInterests,
  buildStoryMaterialBlock,
  buildStoryMaterial,
};
