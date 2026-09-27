#!/usr/bin/env node
// Manage 西寶's OWN emoji library — the application-owned emoji Discord gives
// every app (up to 2000), separate from any server's 50-100 slots.
//
// Why this exists: a guild's emoji budget is tiny and shared with the humans,
// but an application emoji costs the server nothing, works in EVERY guild the
// bot can speak in, and only this bot can use it. That's how 西寶 gets a
// vocabulary bigger than any one server's.
//
// Usage (needs DISCORD_TOKEN in .env — the same bot token the gateway uses):
//   node scripts/app-emoji.js list
//   node scripts/app-emoji.js upload assets/emoji/            # a whole folder
//   node scripts/app-emoji.js upload a.png b.gif --dry-run
//   node scripts/app-emoji.js delete Pepe_Cry Waku_bocchi
//
// The bot does NOT need a restart after an upload for the emoji to exist, but
// its in-memory cache is fetched once at clientReady — restart 西寶 to make her
// see newly uploaded emoji.

require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { REST, Routes } = require("discord.js");

const { emotionForName } = require("../src/ai/emoji-resolver");

// Discord's limits for application emoji (identical to guild emoji).
const MAX_EMOJIS = 2000;
const MAX_BYTES = 256 * 1024;
const NAME_RE = /^[A-Za-z0-9_]{2,32}$/;
const EXT_MIME = new Map([
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// Discord rejects anything outside [A-Za-z0-9_], and a name is the ONLY thing
// the model sees — so a filename like "pepe cry (1).png" becomes "pepe_cry_1".
function emojiNameFromFile(file) {
  const stem = path.basename(file, path.extname(file));
  const cleaned = stem.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 32);
}

function collectFiles(targets) {
  const files = [];
  for (const target of targets) {
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      console.warn(`skip (not found): ${target}`);
      continue;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(target).sort()) {
        const full = path.join(target, entry);
        if (EXT_MIME.has(path.extname(entry).toLowerCase()) && fs.statSync(full).isFile()) {
          files.push(full);
        }
      }
    } else if (EXT_MIME.has(path.extname(target).toLowerCase())) {
      files.push(target);
    } else {
      console.warn(`skip (unsupported type): ${target}`);
    }
  }
  return files;
}

async function getApplicationId(rest) {
  const app = await rest.get(Routes.currentApplication());
  return app.id;
}

// GET /applications/{id}/emojis answers { items: [...] }, not a bare array.
async function listEmojis(rest, appId) {
  const body = await rest.get(Routes.applicationEmojis(appId));
  return Array.isArray(body) ? body : (body?.items ?? []);
}

async function cmdList(rest, appId) {
  const emojis = await listEmojis(rest, appId);
  console.log(`機器人自己的 emoji 庫：${emojis.length} / ${MAX_EMOJIS}`);
  let hidden = 0;
  for (const emoji of emojis.sort((a, b) => a.name.localeCompare(b.name))) {
    const hint = emotionForName(emoji.name);
    if (!hint) hidden += 1;
    console.log(
      `  :${emoji.name}:${emoji.animated ? " (animated)" : ""} ${emoji.id}  ${hint || "⚠ 無法推導用途"}`,
    );
  }
  if (hidden > 0) {
    console.log(
      `\n⚠ ${hidden} 個名稱推導不出用途。這些只有在「30 天內新增」期間會出現在西寶的 emoji 表，` +
        `之後她就看不到了 —— 改名成 Xxx_cry / Good_xxx 這類慣例，或在 src/ai/emoji-resolver.js 的 EXACT_HINTS 補一行。`,
    );
  }
}

async function cmdUpload(rest, appId, targets, dryRun) {
  const files = collectFiles(targets);
  if (files.length === 0) die("沒有可上傳的圖檔。");

  const existing = await listEmojis(rest, appId);
  const taken = new Set(existing.map((e) => e.name.toLowerCase()));
  let budget = MAX_EMOJIS - existing.length;

  let uploaded = 0;
  let skipped = 0;
  for (const file of files) {
    const name = emojiNameFromFile(file);
    if (!NAME_RE.test(name)) {
      console.warn(`skip ${file}: 檔名轉不出合法 emoji 名稱（得到 "${name}"）`);
      skipped += 1;
      continue;
    }
    if (taken.has(name.toLowerCase())) {
      console.log(`skip ${name}: already exists`);
      skipped += 1;
      continue;
    }
    const buf = fs.readFileSync(file);
    if (buf.length > MAX_BYTES) {
      console.warn(`skip ${name}: ${buf.length} bytes > 256KB 上限`);
      skipped += 1;
      continue;
    }
    if (budget <= 0) {
      console.warn(`stop: 已達 ${MAX_EMOJIS} 個上限`);
      break;
    }

    const hint = emotionForName(name);
    if (dryRun) {
      console.log(`[dry-run] ${name} (${buf.length}B) ${hint || "⚠ 無法推導用途"}`);
      taken.add(name.toLowerCase());
      budget -= 1;
      uploaded += 1;
      continue;
    }

    const mime = EXT_MIME.get(path.extname(file).toLowerCase());
    const image = `data:${mime};base64,${buf.toString("base64")}`;
    try {
      const created = await rest.post(Routes.applicationEmojis(appId), {
        body: { name, image },
      });
      console.log(`+ :${name}: ${created.id} ${hint || "⚠ 無法推導用途"}`);
      taken.add(name.toLowerCase());
      budget -= 1;
      uploaded += 1;
    } catch (err) {
      console.error(`x ${name}: ${err.message}`);
      skipped += 1;
    }
  }

  console.log(
    `\n${dryRun ? "[dry-run] " : ""}上傳 ${uploaded}，略過 ${skipped}，剩餘額度 ${budget}。` +
      (dryRun ? "" : " 重啟西寶後她才會看到新 emoji。"),
  );
}

async function cmdDelete(rest, appId, names) {
  if (names.length === 0) die("用法: node scripts/app-emoji.js delete <name...>");
  const emojis = await listEmojis(rest, appId);
  const byName = new Map(emojis.map((e) => [e.name.toLowerCase(), e]));
  for (const name of names) {
    const found = byName.get(name.toLowerCase());
    if (!found) {
      console.warn(`skip ${name}: 不在庫裡`);
      continue;
    }
    await rest.delete(Routes.applicationEmoji(appId, found.id));
    console.log(`- :${found.name}: ${found.id}`);
  }
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) die("Missing DISCORD_TOKEN（.env 或環境變數）。");

  const argv = process.argv.slice(2);
  const dryRun = argv.includes("--dry-run");
  const args = argv.filter((a) => a !== "--dry-run");
  const command = args[0];

  const rest = new REST({ version: "10" }).setToken(token);
  const appId = await getApplicationId(rest);

  switch (command) {
    case "list":
      return cmdList(rest, appId);
    case "upload":
      return cmdUpload(rest, appId, args.slice(1), dryRun);
    case "delete":
      return cmdDelete(rest, appId, args.slice(1));
    default:
      die(
        "用法:\n" +
          "  node scripts/app-emoji.js list\n" +
          "  node scripts/app-emoji.js upload <檔案或資料夾...> [--dry-run]\n" +
          "  node scripts/app-emoji.js delete <name...>",
      );
  }
}

main().catch((err) => die(err?.stack || String(err)));
