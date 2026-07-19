#!/usr/bin/env node
// One-shot migration: rewrite every existing consolidated user profile with
// the current (neutral, field-per-line) consolidation persona.
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
// Old observations (no evidence — pre-#56) are folded into the rewrite as
// 證據不足 hints and then cleared by setConsolidatedProfile; that is their
// normal consolidation lifecycle, just triggered in bulk.
require("dotenv").config();

const { execSync } = require("node:child_process");
const {
  listUserProfiles,
  setConsolidatedProfile,
  STORE_PATH,
} = require("../src/user-profile-store");
const {
  CONSOLIDATION_PERSONA,
  CONSOLIDATE_MAX_TOKENS,
  buildConsolidationTurns,
  parseConsolidationResult,
} = require("../src/ai/observation-extractor");
const { buildRunChainForGuild } = require("../src/ai/profile-sweep");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const INCLUDE_MIGRATED = args.includes("--all");
const guildFlag = args.indexOf("--guild");
const ONLY_GUILD = guildFlag !== -1 ? args[guildFlag + 1] : null;

const CALL_GAP_MS = 1500;
// A field-per-line profile always contains this label; its presence means the
// entry was already written (or migrated) by the new persona.
const NEW_FORMAT_MARKER = "說話風格：";

const MIGRATION_NOTE =
  "（系統維護說明：上面的既有摘要是舊版系統寫的，可能含吹捧、貶低性判詞、或把暱稱裝飾字當「自稱」的過度解讀。" +
  "請把它改寫成新的欄位格式（說話風格／常聊話題／互動偏好／注意），刪去沒有行為佐證的評價句、保留具體行為描述。" +
  "這是一次性的格式遷移：就算沒有新觀察，也請輸出改寫後的 profile，不要回空字串。）";

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
    const profiles = listUserProfiles(guildId).filter((p) => p.profile);
    if (profiles.length === 0) continue;

    const runChain = buildRunChainForGuild(guildId);
    if (!runChain) {
      console.warn(`[redistill] guild=${guildId} has no AI providers, skipping ${profiles.length} profile(s)`);
      skipped += profiles.length;
      continue;
    }

    for (const entry of profiles) {
      const label = `guild=${guildId} user=${entry.userId} name=${entry.name}`;
      if (!INCLUDE_MIGRATED && entry.profile.includes(NEW_FORMAT_MARKER)) {
        console.log(`[redistill] SKIP (already new format) ${label}`);
        skipped++;
        continue;
      }

      const turns = buildConsolidationTurns(entry);
      turns.push({ role: "user", content: MIGRATION_NOTE });

      try {
        const result = await runChain(turns, CONSOLIDATION_PERSONA, CONSOLIDATE_MAX_TOKENS);
        const profile = parseConsolidationResult(result?.text);
        if (!profile) {
          console.warn(`[redistill] FAIL (no usable output) ${label}`);
          failed++;
        } else if (DRY_RUN) {
          console.log(`[redistill] DRY ${label}\n  舊(${entry.profile.length}字): ${entry.profile.slice(0, 80)}…\n  新(${profile.length}字): ${profile.replace(/\n/g, " / ")}`);
          rewritten++;
        } else {
          setConsolidatedProfile(guildId, entry.userId, profile);
          console.log(`[redistill] OK ${label} ${entry.profile.length}→${profile.length}字 provider=${result.provider.label}`);
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
