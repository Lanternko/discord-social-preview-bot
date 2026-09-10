#!/usr/bin/env node
'use strict';

// Builds a run directory the live CLI can consume: sanitized public cases plus
// the private provenance and integrity receipts. This is the only step that
// reads production data, and it reads it READ-ONLY — the integrity receipt
// hashes every source file before and after and refuses to write the run if a
// single byte moved.
//
// Usage:
//   node tools/blind-eval/extract.js --run <id> --guild <snowflake> \
//     --label "<display label>" [--data-dir <path>] [--limit <n>]

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');

const { extractCases, sha256 } = require('./sanitize');
const { createExtractionRun, writeIntegrityReceipt } = require('./artifacts');
const { SCHEMA_VERSION } = require('./schemas');

// Share the live CLI's run root verbatim — a second copy of this path is how a
// run ends up somewhere the CLI cannot find it.
const { RUN_BASE } = require('./cli');
const DEFAULT_DATA_DIR = '/home/kojiek/side_projects/apps/discord-social-preview-bot/data';
const INTEGRITY_FILES = Object.freeze({
  'ai-turn-log': 'ai-turn-log.json',
  'user-profiles': 'user-profiles.json',
  'guild-profiles': 'guild-profiles.json',
});

function parseArgs(argv) {
  const args = { runId: null, guildId: null, label: null, dataDir: DEFAULT_DATA_DIR, limit: 20 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--run') args.runId = argv[++index] || null;
    else if (argv[index] === '--guild') args.guildId = argv[++index] || null;
    else if (argv[index] === '--label') args.label = argv[++index] || null;
    else if (argv[index] === '--data-dir') args.dataDir = argv[++index] || null;
    else if (argv[index] === '--limit') args.limit = Number.parseInt(argv[++index], 10);
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  if (!args.runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args.runId)) throw new Error('a safe --run ID is required');
  if (!args.guildId || !/^\d{17,20}$/.test(args.guildId)) throw new Error('an exact --guild snowflake is required');
  if (!args.label || !args.label.trim() || args.label.length > 100) throw new Error('a --label of 1-100 chars is required');
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20) throw new Error('--limit must be 1-20');
  return args;
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// The turn log is keyed by channel; flatten it into the message shape the
// sanitizer expects. Turns carry no message id, so the salted fingerprint is
// derived from channel + position + timestamp — stable for a given log,
// useless outside it.
function readGuildMessages(dataDir, guildId) {
  const log = JSON.parse(fs.readFileSync(path.join(dataDir, 'ai-turn-log.json'), 'utf8'));
  const messages = [];
  const displayNames = new Set();
  for (const [channelId, channel] of Object.entries(log.channels || {})) {
    if (String(channel?.guildId) !== guildId) continue;
    (channel.turns || []).forEach((turn, index) => {
      if (turn?.displayName) displayNames.add(turn.displayName);
      if (turn?.role !== 'user' || typeof turn.content !== 'string') return;
      messages.push({
        guildId,
        role: 'user',
        content: turn.content,
        id: `${channelId}:${index}:${turn.at ?? 0}`,
        createdAt: new Date(Number(turn.at) || 0).toISOString(),
      });
    });
  }
  return { messages, displayNames: [...displayNames] };
}

function main(argv) {
  const args = parseArgs(argv);
  const dataDir = fs.realpathSync(args.dataDir);

  const before = {};
  for (const [label, name] of Object.entries(INTEGRITY_FILES)) before[label] = hashFile(path.join(dataDir, name));

  const { messages, displayNames } = readGuildMessages(dataDir, args.guildId);
  const caseSalt = randomBytes(32).toString('hex');
  const extraction = extractCases(messages, { guildId: args.guildId, caseSalt, displayNames });
  const publicCases = extraction.publicCases.slice(0, args.limit);
  if (publicCases.length === 0) throw new Error('no case survived sanitization for that guild');

  const after = {};
  for (const [label, name] of Object.entries(INTEGRITY_FILES)) after[label] = hashFile(path.join(dataDir, name));

  const keptIds = new Set(publicCases.map((item) => item.caseId));
  const provenance = {
    schemaVersion: SCHEMA_VERSION,
    targetDisplayLabel: args.label,
    cases: extraction.privateMapping
      .filter((item) => keptIds.has(item.caseId))
      .map((item) => ({
        caseId: item.caseId,
        sourceFingerprint: item.sourceHash,
        sanitizationFlags: ['sanitized', 'residual-scan-passed', 'standalone-preflight-passed'],
      })),
  };

  const runDir = createExtractionRun(RUN_BASE, args.runId, { publicCases, provenance }, { displayNames });
  writeIntegrityReceipt(runDir, {
    schemaVersion: SCHEMA_VERSION,
    'ai-turn-log': { beforeSha256: before['ai-turn-log'], afterSha256: after['ai-turn-log'], equal: before['ai-turn-log'] === after['ai-turn-log'] },
    'user-profiles': { beforeSha256: before['user-profiles'], afterSha256: after['user-profiles'], equal: before['user-profiles'] === after['user-profiles'] },
    'guild-profiles': { beforeSha256: before['guild-profiles'], afterSha256: after['guild-profiles'], equal: before['guild-profiles'] === after['guild-profiles'] },
  });

  // stdout carries counts only — never a question, a salt, or a fingerprint.
  return {
    mode: 'extract',
    runId: args.runId,
    cases: publicCases.length,
    candidates: messages.length,
    rejected: extraction.rejected.length,
    saltRetained: false,
    caseSaltHash: sha256(caseSalt).slice(0, 16),
  };
}

if (require.main === module) {
  try {
    process.stdout.write(`${JSON.stringify(main(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs, readGuildMessages };
