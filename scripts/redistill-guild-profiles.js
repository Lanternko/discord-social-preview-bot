#!/usr/bin/env node
// One-shot migration: rewrite every prose guild summary into structured items
// (話題／互動風格／群內梗, each citing its source). Every migrated item is
// tentative and ages out after 60 days unless new observations re-confirm it.
//
// Same constraint as redistill-profiles.js: the running bot caches the guild
// store in memory and rewrites the whole file on every save, so a real run
// MUST happen while the bot is stopped. --dry-run only reads and may run
// alongside the bot.
//
// Usage:
//   node scripts/redistill-guild-profiles.js --dry-run    # preview old vs new
//   node scripts/redistill-guild-profiles.js              # rewrite all guilds
//   node scripts/redistill-guild-profiles.js --guild <id> # one guild
//   node scripts/redistill-guild-profiles.js --all        # include already-migrated
require("dotenv").config();

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const {
  getGuildProfile,
  setGuildProfileItems,
  renderGuildProfileText,
  STORE_PATH,
} = require("../src/guild-profile-store");
const { runGuildConsolidation, countGuildItems } = require("../src/ai/observation-extractor");
const { buildRunChainForGuild } = require("../src/ai/profile-sweep");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const INCLUDE_MIGRATED = args.includes("--all");
const guildFlag = args.indexOf("--guild");
const ONLY_GUILD = guildFlag !== -1 ? args[guildFlag + 1] : null;

const CALL_GAP_MS = 1500;
const MIGRATION_NOTE =
  "（系統維護說明：這是一次性的格式遷移。既有條目是舊版的整段摘要句子，一句裡常塞了一串話題。" +
  "請拆成短條目放進正確欄位（一條只講一件事），from 填原本的 I 編號；" +
  "刪掉講群友怎麼用西寶／機器人的句子、提到特定人暱稱的句子。欄位裝不下就留最有代表性的。" +
  "就算沒有新觀察，也請輸出完整的檔案，不要回空的 items。）";

function botIsRunning() {
  try {
    // [s]rc bracket trick: the pgrep shell's own cmdline doesn't match.
    const out = execSync('pgrep -f "[s]rc/index\\.js" || true', { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function listGuildIds() {
  try {
    return Object.keys(JSON.parse(fs.readFileSync(STORE_PATH, "utf8")));
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!DRY_RUN && botIsRunning() && !FORCE) {
    console.error(
      "[redistill-guild] a bot process (src/index.js) appears to be running — its in-memory store cache would clobber this migration. Stop the bot first (and mind the watchdog cron), or pass --force if this is a false match.",
    );
    process.exit(1);
  }

  const guildIds = ONLY_GUILD ? [ONLY_GUILD] : listGuildIds();
  let rewritten = 0;
  let skipped = 0;
  let failed = 0;

  for (const guildId of guildIds) {
    const entry = getGuildProfile(guildId);
    if (!entry?.profile && !entry?.items) continue;
    const label = `guild=${guildId} name=${entry.name}`;
    if (!INCLUDE_MIGRATED && entry.items) {
      console.log(`[redistill-guild] SKIP (already structured) ${label}`);
      skipped++;
      continue;
    }
    const runChain = buildRunChainForGuild(guildId);
    if (!runChain) {
      console.warn(`[redistill-guild] ${label} has no AI providers, skipping`);
      skipped++;
      continue;
    }

    try {
      const { result, items } = await runGuildConsolidation(entry, runChain, [
        { role: "user", content: MIGRATION_NOTE },
      ], guildId);
      if (!items) {
        console.warn(`[redistill-guild] FAIL (no usable output) ${label}`);
        failed++;
      } else if (DRY_RUN) {
        console.log(
          `[redistill-guild] DRY ${label}\n  舊: ${entry.profile}\n  新(${countGuildItems(items)}條):\n    ${renderGuildProfileText(items, 0).replace(/\n/g, "\n    ")}`,
        );
        rewritten++;
      } else {
        setGuildProfileItems(guildId, items);
        console.log(`[redistill-guild] OK ${label} items=${countGuildItems(items)} provider=${result.provider.label}`);
        rewritten++;
      }
    } catch (err) {
      console.warn(`[redistill-guild] FAIL ${label}: ${err.message}`);
      failed++;
    }
    await sleep(CALL_GAP_MS);
  }

  console.log(
    `[redistill-guild] done${DRY_RUN ? " (dry-run)" : ""}: rewritten=${rewritten} skipped=${skipped} failed=${failed}`,
  );
}

main().catch((err) => {
  console.error(`[redistill-guild] fatal: ${err.stack || err}`);
  process.exit(1);
});
