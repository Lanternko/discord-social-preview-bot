const fs = require("fs");
const path = require("path");
const { DEFAULT_LANGUAGE, isValidLanguage } = require("./reply-language");

const LANGUAGE_STORE_PATH = path.join(
  __dirname,
  "..",
  "data",
  "language-settings.json",
);

let cache = null;

function load() {
  if (cache !== null) return cache;
  try {
    const raw = fs.readFileSync(LANGUAGE_STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    cache = parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(
        `[language] failed to read ${LANGUAGE_STORE_PATH}: ${err.message}`,
      );
    }
    cache = {};
  }
  return cache;
}

function save() {
  const settings = cache ?? {};
  fs.mkdirSync(path.dirname(LANGUAGE_STORE_PATH), { recursive: true });
  const tmp = LANGUAGE_STORE_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, LANGUAGE_STORE_PATH);
}

function getGuildLanguage(guildId) {
  if (!guildId) return DEFAULT_LANGUAGE;
  const code = load()[guildId];
  return isValidLanguage(code) ? code : DEFAULT_LANGUAGE;
}

function setGuildLanguage(guildId, code) {
  if (!guildId) throw new Error("guildId required");
  if (!isValidLanguage(code)) throw new Error(`invalid language: ${code}`);
  const settings = load();
  // The default is stored as absence so the file only lists guilds that
  // actually changed something.
  if (code === DEFAULT_LANGUAGE) delete settings[guildId];
  else settings[guildId] = code;
  save();
}

function resetCacheForTests() {
  cache = null;
}

module.exports = {
  LANGUAGE_STORE_PATH,
  getGuildLanguage,
  setGuildLanguage,
  resetCacheForTests,
};
