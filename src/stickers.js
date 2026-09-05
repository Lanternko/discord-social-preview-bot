// Everything sticker-shaped that touches Discord or disk. The pure prompt /
// parse half lives in src/ai/sticker-resolver.js.
//
// Two sources, deliberately different mechanisms:
//
//   kind:"guild"   — a real Discord sticker owned by THIS guild, sent via
//                    message.reply({ stickers: [id] }). Zero storage, and it's
//                    the exact sticker the group is already spamming. Discord
//                    only lets a bot send stickers from the guild it's posting
//                    in (no Nitro for bots), so this source is per-guild.
//   kind:"library" — an image file 西寶 owns, uploaded as an attachment. There
//                    is NO application-owned sticker API (unlike emoji), so a
//                    bot-wide sticker library can only be images. An attachment
//                    with no text renders at sticker size, which is the point:
//                    unlimited count, works in every guild.
//
// Guild stickers win on a name clash: if the group has its own 「起床重睡」,
// 西寶 should post THAT one, not her private copy.

const fs = require("node:fs");
const path = require("node:path");
const { AttachmentBuilder } = require("discord.js");

const {
  STICKER_REPLY_ENABLED,
  STICKER_LIBRARY_DIR,
  STICKER_LIBRARY_MAX_BYTES,
} = require("./config");
const { normalizeStickerName } = require("./ai/sticker-resolver");

// Discord renders these as an image in-chat; anything else would land as a
// generic file card, which is not a sticker in any useful sense.
const IMAGE_EXTS = new Set([".png", ".gif", ".webp", ".jpg", ".jpeg"]);
const INDEX_FILE = "index.json";

let _library = null; // { dir, entries: Map<name, entry> } — memoized per process

// index.json is optional and only supplies human meaning (and a name override):
//   [{ "name": "起床重睡", "file": "wakeup.png", "meaning": "賴床/起床氣" }]
// Files with no entry still load, named after the filename stem — dropping a
// PNG into the folder is enough to make it postable.
function readLibraryIndex(dir) {
  const indexPath = path.join(dir, INDEX_FILE);
  let raw;
  try {
    raw = fs.readFileSync(indexPath, "utf8");
  } catch {
    return new Map();
  }
  try {
    const parsed = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [];
    const byFile = new Map();
    for (const row of rows) {
      if (!row || typeof row.file !== "string") continue;
      byFile.set(row.file, {
        name: typeof row.name === "string" ? row.name : null,
        meaning: typeof row.meaning === "string" ? row.meaning : null,
      });
    }
    return byFile;
  } catch (err) {
    console.warn(`[sticker] bad ${INDEX_FILE}: ${err.message}`);
    return new Map();
  }
}

// Scans STICKER_LIBRARY_DIR once per process. A restart is the reload — the
// folder is deploy-time content, not something that changes mid-session.
function loadStickerLibrary(dir = STICKER_LIBRARY_DIR) {
  if (_library && _library.dir === dir) return _library.entries;

  const entries = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    // No library folder is the normal case for a fresh checkout.
    _library = { dir, entries };
    return entries;
  }

  const index = readLibraryIndex(dir);
  for (const file of files.sort()) {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTS.has(ext)) continue;

    const full = path.join(dir, file);
    let size = 0;
    try {
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue;
      size = stat.size;
    } catch {
      continue;
    }
    // Oversized files would fail the upload at send time, i.e. 西寶 picks a
    // sticker and then silently posts nothing. Drop them at load instead.
    if (size > STICKER_LIBRARY_MAX_BYTES) {
      console.warn(
        `[sticker] skip oversized ${file} (${size} > ${STICKER_LIBRARY_MAX_BYTES})`,
      );
      continue;
    }

    const meta = index.get(file) || {};
    const name = normalizeStickerName(meta.name || path.basename(file, ext));
    if (!name || entries.has(name)) continue;
    entries.set(name, {
      kind: "library",
      name,
      meaning: meta.meaning || null,
      file: full,
      basename: file,
      size,
    });
  }

  _library = { dir, entries };
  return entries;
}

function resetStickerLibraryCache() {
  _library = null;
}

// A guild sticker can go unavailable when the server loses boost tier; sending
// one then 400s. `available === false` is the only reliable signal.
function isPostableGuildSticker(sticker) {
  return !!sticker?.id && !!sticker?.name && sticker.available !== false;
}

function guildStickerEntry(sticker) {
  const tags = sticker.tags ? String(sticker.tags) : "";
  const meaning = sticker.description || tags || null;
  return {
    kind: "guild",
    name: normalizeStickerName(sticker.name),
    meaning,
    id: sticker.id,
  };
}

// Merge the two sources into the name→entry map the resolver works on.
// Exported separately from buildStickerCatalog so the merge order (guild wins)
// is testable without a Discord client.
function mergeStickerSources(guildStickers, libraryEntries) {
  const catalog = new Map();
  for (const sticker of guildStickers || []) {
    if (!isPostableGuildSticker(sticker)) continue;
    const entry = guildStickerEntry(sticker);
    if (entry.name && !catalog.has(entry.name)) catalog.set(entry.name, entry);
  }
  for (const entry of (libraryEntries || new Map()).values()) {
    if (!catalog.has(entry.name)) catalog.set(entry.name, entry);
  }
  return catalog;
}

// GUILD_CREATE carries the sticker list, so the cache is normally warm; the
// fetch is the cold-start / cache-swept fallback and is itself cached by djs.
async function fetchGuildStickers(guild) {
  if (!guild?.stickers) return [];
  try {
    if (guild.stickers.cache.size > 0) return [...guild.stickers.cache.values()];
    const fetched = await guild.stickers.fetch();
    return [...fetched.values()];
  } catch (err) {
    console.warn(`[sticker] guild sticker fetch failed: ${err.message}`);
    return [];
  }
}

async function buildStickerCatalog(guild) {
  if (!STICKER_REPLY_ENABLED) return new Map();
  const guildStickers = await fetchGuildStickers(guild);
  return mergeStickerSources(guildStickers, loadStickerLibrary());
}

// Turn a resolved catalog entry into the message-options fragment that posts it.
// Returns null when the entry can't be posted, so the caller just sends text.
function buildStickerSendPayload(entry) {
  if (!entry) return null;
  if (entry.kind === "guild") return { stickers: [entry.id] };
  if (entry.kind === "library") {
    return {
      files: [new AttachmentBuilder(entry.file, { name: entry.basename })],
    };
  }
  return null;
}

module.exports = {
  IMAGE_EXTS,
  loadStickerLibrary,
  resetStickerLibraryCache,
  isPostableGuildSticker,
  mergeStickerSources,
  buildStickerCatalog,
  buildStickerSendPayload,
};
