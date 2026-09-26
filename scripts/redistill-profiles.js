#!/usr/bin/env node
// One-shot migration: rewrite every existing consolidated user profile into
// the current structured form (fixed fields, short items, each with its own
// provenance) using the current consolidation persona.
//
// Why a standalone script and not a bot feature: the running bot holds the
// profile store in an in-memory cache and rewrites the whole JSON file on
// every save — a second process writing the same file would be silently
// clobbered. So this MUST run while the bot is stopped (deploy window).
// The script refuses to start if a bot process is visible; --force overrides.
//
// Usage:
//   node scripts/redistill-profiles.js --dry-run          # preview only
//   node scripts/redistill-profiles.js                    # rewrite all guilds
//   node scripts/redistill-profiles.js --guild <id>       # one guild
//   node scripts/redistill-profiles.js --all              # include already-migrated
//
// Pending observations are folded into the rewrite and consumed by
// setProfileItems; that is their normal consolidation lifecycle, just
// triggered in bulk. Legacy profile lines become source items with no
// per-item evidence and lastSeenAt = the old profileAt, so migrated
// impressions still age out unless something re-confirms them.
require("dotenv").config();

const { execSync } = require("node:child_process");
const {
  listUserProfiles,
  setProfileItems,
  renderProfileText,
  STORE_PATH,
} = require("../src/user-profile-store");
const { runConsolidation, countItems } = require("../src/ai/observation-extractor");
const { buildRunChainForGuild } = require("../src/ai/profile-sweep");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const INCLUDE_MIGRATED = args.includes("--all");
const guildFlag = args.indexOf("--guild");
const ONLY_GUILD = guildFlag !== -1 ? args[guildFlag + 1] : null;

const CALL_GAP_MS = 1500;
const MIGRATION_NOTE =
  "（系統維護說明：這是一次性的格式遷移。既有條目是舊版的整段摘要，一條裡常塞了好幾件事。" +
  "請把它們拆成短條目（每條只講一件事），from 填原本的 I 編號；刪去沒有行為佐證的評價句、只描述西寶反應的句子。" +
  "就算沒有新觀察，也請輸出完整的檔案，不要回空的 items。）";

function botIsRunning() {
  try {
    // [s]rc bracket trick: the pgrep shell's own cmdline contains the literal
    // "[s]rc/index.js", which the regex does not match — no self-match.
    const out = execSync('pgrep -f "[s]rc/index\\.js" || true', { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function listGuildIds() {
  // The store has no guild enumeration — read the raw file for ids only;
  // all writes still go through the store so sanitization applies.
  const fs = require("node:fs");
  try {
    return Object.keys(JSON.parse(fs.readFileSync(STORE_PATH, "utf8")));
  } catch {
    return [];
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (botIsRunning() && !FORCE) {
    console.error(
      "[redistill] a bot process (src/index.js) appears to be running — its in-memory store cache would clobber this migration. Stop the bot first (and mind the watchdog cron), or pass --force if this is a false match.",
    );
    process.exit(1);
  }

  const guildIds = ONLY_GUILD ? [ONLY_GUILD] : listGuildIds();
  let rewritten = 0;
  let skipped = 0;
  let failed = 0;

  for (const guildId of guildIds) {
    const profiles = listUserProfiles(guildId).filter((p) => p.profile || p.items);
    if (profiles.length === 0) continue;

    const runChain = buildRunChainForGuild(guildId);
    if (!runChain) {
      console.warn(`[redistill] guild=${guildId} has no AI providers, skipping ${profiles.length} profile(s)`);
      skipped += profiles.length;
      continue;
    }

    for (const entry of profiles) {
      const label = `guild=${guildId} user=${entry.userId} name=${entry.name}`;
      if (!INCLUDE_MIGRATED && entry.items) {
        console.log(`[redistill] SKIP (already structured) ${label}`);
        skipped++;
        continue;
      }

      try {
        const { result, items } = await runConsolidation(entry, runChain, [
          { role: "user", content: MIGRATION_NOTE },
        ]);
        const oldText = entry.profile || "";
        if (!items) {
          console.warn(`[redistill] FAIL (no usable output) ${label}`);
          failed++;
        } else if (DRY_RUN) {
          console.log(`[redistill] DRY ${label}\n  舊: ${oldText.replace(/\n/g, " / ")}\n  新(${countItems(items)}條): ${renderProfileText(items, 0).replace(/\n/g, " / ")}`);
          rewritten++;
        } else {
          setProfileItems(guildId, entry.userId, items);
          console.log(`[redistill] OK ${label} items=${countItems(items)} provider=${result.provider.label}`);
          rewritten++;
        }
      } catch (err) {
        console.warn(`[redistill] FAIL ${label}: ${err.message}`);
        failed++;
      }
      await sleep(CALL_GAP_MS);
    }
  }

  console.log(
    `[redistill] done${DRY_RUN ? " (dry-run)" : ""}: rewritten=${rewritten} skipped=${skipped} failed=${failed}`,
  );
}

main().catch((err) => {
  console.error(`[redistill] fatal: ${err.stack || err}`);
  process.exit(1);
});
