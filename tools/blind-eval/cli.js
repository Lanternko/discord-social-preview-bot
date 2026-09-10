#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { loadCases, persistLiveArtifacts, preflight, runLiveEvaluation } = require('./live');
const { readDeepSeekKey, readEphemeralKey, unlinkEphemeralKey } = require('./secrets');

const WORKTREE = '/home/kojiek/side_projects/apps/dspb-blind-eval';
const RUN_BASE = path.join(WORKTREE, 'data', 'evals');
const PERSONA_MODULE = '/home/kojiek/side_projects/apps/discord-social-preview-bot/src/config.js';
const DEEPSEEK_ENV = '/home/kojiek/side_projects/apps/discord-social-preview-bot/.env';
const OPENAI_KEY = '/run/user/1005/xibao-openai-key';

function parseArgs(argv) {
  const args = { execute: false, preflight: false, ack: false, runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--execute') args.execute = true;
    else if (value === '--preflight') args.preflight = true;
    else if (value === '--ack-provider-retention-unknown') args.ack = true;
    else if (value === '--run') args.runId = argv[++index] || null;
    else throw new Error('unknown CLI argument');
  }
  if (args.execute === args.preflight) throw new Error('choose exactly one of --execute or --preflight');
  if (!args.runId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(args.runId)) throw new Error('a safe --run ID is required');
  if (args.execute && !args.ack) throw new Error('--execute requires --ack-provider-retention-unknown');
  return args;
}

function resolveRun(base, runId) {
  const baseReal = fs.realpathSync(base);
  const candidate = path.join(baseReal, runId);
  const real = fs.realpathSync(candidate);
  if (real !== candidate || !real.startsWith(`${baseReal}${path.sep}`) || fs.lstatSync(real).isSymbolicLink()) throw new Error('run path boundary mismatch');
  return real;
}

function loadDefaultPersona(modulePath = PERSONA_MODULE) {
  const real = fs.realpathSync(modulePath);
  if (real !== modulePath || fs.lstatSync(real).isSymbolicLink()) throw new Error('persona module path mismatch');
  const originalWarn = console.warn;
  let exported;
  try {
    console.warn = () => {};
    delete require.cache[require.resolve(real)];
    exported = require(real);
  } finally {
    console.warn = originalWarn;
  }
  if (typeof exported.DEFAULT_AI_PERSONA !== 'string' || !exported.DEFAULT_AI_PERSONA) throw new Error('DEFAULT_AI_PERSONA is missing');
  return exported.DEFAULT_AI_PERSONA;
}

function inspectArtifactReadiness(runDir, cases) {
  const privateDir = path.join(runDir, 'private');
  const privateStat = fs.lstatSync(privateDir);
  if (privateStat.isSymbolicLink() || !privateStat.isDirectory() || (privateStat.mode & 0o777) !== 0o700) throw new Error('private run directory security mismatch');
  const readSecureJson = (name) => {
    const file = path.join(privateDir, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error(`${name} security mismatch`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const provenance = readSecureJson('provenance.json');
  const integrity = readSecureJson('integrity.json');
  if (Object.keys(provenance).sort().join(',') !== 'cases,schemaVersion,targetDisplayLabel' || !Array.isArray(provenance.cases) || provenance.cases.length !== cases.length) throw new Error('provenance readiness mismatch');
  const caseIds = new Set(cases.map((item) => item.caseId));
  if (provenance.cases.some((item) => !caseIds.has(item?.caseId))) throw new Error('provenance case mismatch');
  if (Object.keys(integrity).sort().join(',') !== 'ai-turn-log,guild-profiles,schemaVersion,user-profiles') throw new Error('integrity readiness mismatch');
  for (const label of ['ai-turn-log', 'user-profiles', 'guild-profiles']) {
    const item = integrity[label];
    if (!item || Object.keys(item).sort().join(',') !== 'afterSha256,beforeSha256,equal' || item.equal !== true ||
        !/^[a-f0-9]{64}$/.test(item.beforeSha256) || item.beforeSha256 !== item.afterSha256) throw new Error('integrity source mismatch');
  }
  const outputFiles = ['answers.json', '../private/mapping.json', '../private/config.json', '../private/usage.json'];
  if (outputFiles.some((name) => fs.existsSync(path.resolve(path.join(runDir, 'public', name))))) throw new Error('run already contains live outputs');
  return { casesReady: true, provenanceReady: true, integrityReady: true, liveOutputsAbsent: true };
}

async function executeCli(argv, dependencies = {}) {
  const openaiKeyPath = dependencies.openaiKeyPath || OPENAI_KEY;
  const executeIntent = argv.includes('--execute');
  let openaiKey;
  let deepseekKey;
  try {
    const args = parseArgs(argv);
    const runDir = resolveRun(dependencies.runBase || RUN_BASE, args.runId);
    const persona = loadDefaultPersona(dependencies.personaModule || PERSONA_MODULE);
    const cases = loadCases(runDir);
    const dry = preflight(cases, persona);
    if (args.preflight) {
      const summary = { mode: 'preflight', ...dry, artifactReadiness: inspectArtifactReadiness(runDir, cases) };
      dependencies.writeOutput?.(JSON.stringify(summary));
      return summary;
    }
    openaiKey = readEphemeralKey(openaiKeyPath, dependencies.openaiExpectedUid ?? 1005);
    deepseekKey = await readDeepSeekKey(dependencies.deepseekEnv || DEEPSEEK_ENV);
    const result = await runLiveEvaluation({
      cases, persona, keys: { openai: openaiKey, deepseek: deepseekKey },
      fetchImpl: dependencies.fetchImpl || globalThis.fetch,
      randomBit: dependencies.randomBit,
    });
    persistLiveArtifacts(runDir, result, { evaluationRoot: dependencies.runBase || RUN_BASE });
    const totalCostUsd = result.attempts.reduce((sum, attempt) => sum + Number(attempt.cost?.totalUsd || 0), 0);
    const summary = {
      mode: 'execute', completedPairs: result.completedPairs.length,
      attemptCount: result.attempts.length, totalCostUsd,
      status: result.aborted ? 'aborted' : 'complete',
      ...(result.aborted ? { abortReason: result.aborted.reason } : {}),
    };
    dependencies.writeOutput?.(JSON.stringify(summary));
    if (result.aborted) throw new Error(`live evaluation aborted: ${result.aborted.reason}`);
    return summary;
  } finally {
    openaiKey = null;
    deepseekKey = null;
    if (executeIntent) unlinkEphemeralKey(openaiKeyPath);
  }
}

if (require.main === module) {
  executeCli(process.argv.slice(2), { writeOutput: (line) => process.stdout.write(`${line}\n`) })
    .catch(() => { process.stderr.write('blind evaluation failed safely\n'); process.exitCode = 1; });
}

module.exports = {
  DEEPSEEK_ENV, OPENAI_KEY, PERSONA_MODULE, RUN_BASE, WORKTREE,
  executeCli, inspectArtifactReadiness, loadDefaultPersona, parseArgs, resolveRun,
};
