'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { SCHEMA_VERSION, assertPublicCase } = require('./schemas');
const { hasResidualIdentifier } = require('./sanitize');

const RETENTION_DAYS = 7;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const PUBLIC_ANSWER_KEYS = Object.freeze(['A', 'B', 'caseId']);
const BLIND_METADATA = /\b(?:openai|deepseek|gpt-[a-z0-9_.-]*|deepseek-[a-z0-9_.-]*|model|provider|config(?:id)?|cost|usage|latency)\b/i;
// An answer BODY is the model's own free text, not our metadata. Words like
// "model", "cost" or "usage" are things 西寶 can legitimately say, and screening
// answers against the strict pattern above aborted a fully-paid-for run over
// one such word. Only a literal provider/model name would actually unblind a
// voter, so bodies are screened against that narrower set: the two arms of
// this comparison and nothing else. Naming some THIRD model ("claude",
// "gemini") tells a voter nothing about which side they are reading, so it is
// not a leak — screening for it only invents new false positives. The answer's
// structure (keys, caseId) still goes through BLIND_METADATA.
const PROVIDER_IDENTITY = /\b(?:openai|deepseek|deepseek-[a-z0-9_.-]*|gpt-[a-z0-9_.-]*)\b/i;
const EXTRACTION_FLAGS = new Set(['sanitized', 'residual-scan-passed', 'standalone-preflight-passed']);
const INTEGRITY_LABELS = Object.freeze(['ai-turn-log', 'guild-profiles', 'user-profiles']);

function safeRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(runId)) throw new Error('unsafe run ID');
  return runId;
}

function assertInside(base, target) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('artifact path escapes base');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' });
  fs.chmodSync(filePath, FILE_MODE);
}

function assertNoBlindMetadata(value, location = 'public answer') {
  if (typeof value === 'string') {
    if (BLIND_METADATA.test(value)) throw new Error(`${location} contains model/provider/config/cost/usage/latency metadata`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoBlindMetadata(item, `${location}[${index}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertNoBlindMetadata(key, `${location} key`);
      assertNoBlindMetadata(item, `${location}.${key}`);
    }
  }
}

// Non-throwing form, so a caller can DROP a self-identifying pair instead of
// losing an entire paid-for run to it.
function namesProviderIdentity(text) {
  return typeof text === 'string' ? (text.match(PROVIDER_IDENTITY)?.[0] ?? null) : null;
}

function assertPublicAnswer(answer) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || Object.getPrototypeOf(answer) !== Object.prototype) {
    throw new Error('public answer must be a plain object');
  }
  const keys = Object.keys(answer).sort();
  if (keys.length !== PUBLIC_ANSWER_KEYS.length || keys.some((key, index) => key !== PUBLIC_ANSWER_KEYS[index])) {
    throw new Error('public answer fields must be exactly caseId, A, and B');
  }
  if (!/^[a-f0-9]{16}$/.test(answer.caseId)) throw new Error('public answer has invalid caseId');
  if (typeof answer.A !== 'string' || !answer.A.trim() || typeof answer.B !== 'string' || !answer.B.trim()) {
    throw new Error('public answer A and B must be non-empty strings');
  }
  assertNoBlindMetadata({ caseId: answer.caseId });
  for (const side of ['A', 'B']) {
    // Name the matched token: a run that aborts here has already been paid
    // for, and "something matched" is not enough to fix it without spending
    // the whole run again.
    const match = answer[side].match(PROVIDER_IDENTITY);
    if (match) throw new Error(`public answer.${side} names a provider or model (${match[0]})`);
  }
  return answer;
}

function validateExtractionProvenance(provenance, cases) {
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance) || Object.getPrototypeOf(provenance) !== Object.prototype) {
    throw new Error('extraction provenance must be a plain object');
  }
  const keys = Object.keys(provenance).sort();
  if (keys.length !== 3 || keys[0] !== 'cases' || keys[1] !== 'schemaVersion' || keys[2] !== 'targetDisplayLabel') {
    throw new Error('extraction provenance fields must be exactly schemaVersion, targetDisplayLabel, and cases');
  }
  if (typeof provenance.schemaVersion !== 'string' || !provenance.schemaVersion) throw new Error('invalid provenance schema version');
  if (typeof provenance.targetDisplayLabel !== 'string' || !provenance.targetDisplayLabel.trim() || provenance.targetDisplayLabel.length > 100 || hasResidualIdentifier(provenance.targetDisplayLabel)) {
    throw new Error('unsafe target display label');
  }
  if (!Array.isArray(provenance.cases) || provenance.cases.length !== cases.length) throw new Error('provenance case count mismatch');
  const publicIds = new Set(cases.map((item) => item.caseId));
  const seen = new Set();
  for (const item of provenance.cases) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) throw new Error('provenance case must be a plain object');
    const itemKeys = Object.keys(item).sort();
    if (itemKeys.length !== 3 || itemKeys[0] !== 'caseId' || itemKeys[1] !== 'sanitizationFlags' || itemKeys[2] !== 'sourceFingerprint') {
      throw new Error('provenance case fields must be exactly caseId, sourceFingerprint, and sanitizationFlags');
    }
    if (!publicIds.has(item.caseId) || seen.has(item.caseId)) throw new Error('invalid or duplicate provenance caseId');
    seen.add(item.caseId);
    if (!/^[a-f0-9]{64}$/.test(item.sourceFingerprint)) throw new Error('invalid salted source fingerprint');
    if (!Array.isArray(item.sanitizationFlags) || item.sanitizationFlags.length !== EXTRACTION_FLAGS.size ||
        new Set(item.sanitizationFlags).size !== item.sanitizationFlags.length ||
        item.sanitizationFlags.some((flag) => !EXTRACTION_FLAGS.has(flag))) throw new Error('invalid sanitization flags');
  }
  return provenance;
}

function createExtractionRun(baseDir, runId, payload, options = {}) {
  if (!payload || !Array.isArray(payload.publicCases)) throw new Error('publicCases must be an array');
  const cases = payload.publicCases.map((item) => {
    assertPublicCase(item);
    if (item.question.length > 1000 || hasResidualIdentifier(item.question, options.displayNames)) {
      throw new Error('refusing extraction case with residual identifiers');
    }
    return item;
  });
  const provenance = validateExtractionProvenance(payload.provenance, cases);
  const resolvedBase = path.resolve(baseDir);
  const runDir = path.join(resolvedBase, safeRunId(runId));
  assertInside(resolvedBase, runDir);
  let created = false;
  try {
    fs.mkdirSync(resolvedBase, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(resolvedBase, DIR_MODE);
    fs.mkdirSync(runDir, { mode: DIR_MODE });
    created = true;
    fs.chmodSync(runDir, DIR_MODE);
    fs.mkdirSync(path.join(runDir, 'public'), { mode: DIR_MODE });
    fs.mkdirSync(path.join(runDir, 'private'), { mode: DIR_MODE });
    writeJson(path.join(runDir, 'public', 'cases.json'), cases);
    writeJson(path.join(runDir, 'private', 'provenance.json'), provenance);
    return runDir;
  } catch (error) {
    if (created && fs.existsSync(runDir)) fs.rmSync(runDir, { recursive: true });
    throw error;
  }
}

function writeIntegrityReceipt(runDir, receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || Object.getPrototypeOf(receipt) !== Object.prototype) throw new Error('integrity receipt must be a plain object');
  const expectedKeys = [...INTEGRITY_LABELS, 'schemaVersion'].sort();
  const keys = Object.keys(receipt).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error('integrity receipt fields mismatch');
  if (receipt.schemaVersion !== SCHEMA_VERSION) throw new Error('integrity receipt schema version mismatch');
  for (const label of INTEGRITY_LABELS) {
    const item = receipt[label];
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) throw new Error('integrity source must be a plain object');
    const itemKeys = Object.keys(item).sort();
    if (itemKeys.length !== 3 || itemKeys[0] !== 'afterSha256' || itemKeys[1] !== 'beforeSha256' || itemKeys[2] !== 'equal') throw new Error('integrity source fields mismatch');
    if (!/^[a-f0-9]{64}$/.test(item.beforeSha256) || !/^[a-f0-9]{64}$/.test(item.afterSha256)) throw new Error('invalid integrity SHA-256');
    if (item.equal !== true || item.beforeSha256 !== item.afterSha256) throw new Error('production integrity mismatch');
  }
  const privateDir = path.join(path.resolve(runDir), 'private');
  const runStat = fs.lstatSync(path.resolve(runDir));
  const privateStat = fs.lstatSync(privateDir);
  if (runStat.isSymbolicLink() || privateStat.isSymbolicLink() || !runStat.isDirectory() || !privateStat.isDirectory() ||
      (runStat.mode & 0o777) !== DIR_MODE || (privateStat.mode & 0o777) !== DIR_MODE) throw new Error('integrity receipt directory security mismatch');
  const file = path.join(privateDir, 'integrity.json');
  writeJson(file, receipt);
  return file;
}

function createRun(baseDir, runId, payload) {
  if (!payload || !Array.isArray(payload.publicCases)) throw new Error('publicCases must be an array');
  const cases = payload.publicCases.map((item) => {
    assertPublicCase(item);
    if (hasResidualIdentifier(item.question)) throw new Error('refusing to persist a case with residual identifiers');
    return item;
  });
  const answers = (payload.publicAnswers || []).map(assertPublicAnswer);

  const resolvedBase = path.resolve(baseDir);
  const runDir = path.join(resolvedBase, safeRunId(runId));
  assertInside(resolvedBase, runDir);
  fs.mkdirSync(resolvedBase, { recursive: true, mode: DIR_MODE });
  fs.chmodSync(resolvedBase, DIR_MODE);
  fs.mkdirSync(runDir, { mode: DIR_MODE });
  fs.chmodSync(runDir, DIR_MODE);
  fs.mkdirSync(path.join(runDir, 'public'), { mode: DIR_MODE });
  fs.mkdirSync(path.join(runDir, 'private'), { mode: DIR_MODE });

  writeJson(path.join(runDir, 'public', 'cases.json'), cases);
  writeJson(path.join(runDir, 'public', 'answers.json'), answers);
  writeJson(path.join(runDir, 'private', 'mapping.json'), payload.privateMapping || []);
  writeJson(path.join(runDir, 'private', 'config.json'), payload.privateConfig || {});
  writeJson(path.join(runDir, 'private', 'usage.json'), payload.privateUsage || []);
  return runDir;
}

function hashFiles(filePaths) {
  return Object.fromEntries(filePaths.map((filePath) => {
    const absolute = path.resolve(filePath);
    return [absolute, createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')];
  }));
}

function assertHashesUnchanged(before, after) {
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('production files changed during evaluation');
}

function purgeExpired(baseDir, nowMs = Date.now(), retentionDays = RETENTION_DAYS) {
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > RETENTION_DAYS) throw new Error('retention must be 1-7 days');
  const resolvedBase = path.resolve(baseDir);
  if (!fs.existsSync(resolvedBase)) return [];
  const cutoff = nowMs - retentionDays * 86_400_000;
  const purged = [];
  for (const entry of fs.readdirSync(resolvedBase, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name)) continue;
    const runDir = path.join(resolvedBase, entry.name);
    assertInside(resolvedBase, runDir);
    if (fs.statSync(runDir).mtimeMs < cutoff) {
      fs.rmSync(runDir, { recursive: true });
      purged.push(entry.name);
    }
  }
  return purged;
}

function purgeRun(baseDir, runId) {
  const resolvedBase = path.resolve(baseDir);
  const runDir = path.join(resolvedBase, safeRunId(runId));
  assertInside(resolvedBase, runDir);
  if (!fs.existsSync(runDir)) return false;
  fs.rmSync(runDir, { recursive: true });
  return true;
}

module.exports = {
  DIR_MODE, FILE_MODE, RETENTION_DAYS, assertHashesUnchanged, assertNoBlindMetadata,
  assertPublicAnswer, createExtractionRun, createRun, hashFiles, namesProviderIdentity,
  purgeExpired, purgeRun, writeIntegrityReceipt,
};
