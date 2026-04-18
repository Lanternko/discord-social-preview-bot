const fs = require("fs");
const path = require("path");

const TIER_STORE_PATH = path.join(
  __dirname,
  "..",
  "data",
  "tier-settings.json",
);
const VALID_TIERS = ["brief", "standard", "detailed"];
const DEFAULT_TIER = "brief";

let cache = null;

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(TIER_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(
        `[tier] failed to read ${TIER_STORE_PATH}: ${err.message}`,
      );
    }
    cache = {};
  }
  return cache;
}

function save() {
  const settings = cache ?? {};
  fs.mkdirSync(path.dirname(TIER_STORE_PATH), { recursive: true });
  fs.writeFileSync(TIER_STORE_PATH, JSON.stringify(settings, null, 2));
}

function isValidTier(tier) {
  return VALID_TIERS.includes(tier);
}

function getGuildTier(guildId) {
  if (!guildId) return DEFAULT_TIER;
  const settings = load();
  const tier = settings[guildId];
  return isValidTier(tier) ? tier : DEFAULT_TIER;
}

function setGuildTier(guildId, tier) {
  if (!guildId) throw new Error("guildId required");
  if (!isValidTier(tier)) throw new Error(`invalid tier: ${tier}`);
  const settings = load();
  settings[guildId] = tier;
  save();
}

function resetCacheForTests() {
  cache = null;
}

module.exports = {
  TIER_STORE_PATH,
  VALID_TIERS,
  DEFAULT_TIER,
  isValidTier,
  getGuildTier,
  setGuildTier,
  resetCacheForTests,
};
