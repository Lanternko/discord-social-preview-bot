'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SCHEMA_VERSION } = require('../schemas');
const { assertHashesUnchanged, assertPublicAnswer, createExtractionRun, createRun, hashFiles, purgeExpired, purgeRun, writeIntegrityReceipt } = require('../artifacts');

test('artifacts separate public/private data with 0700/0600 modes and verify production hashes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-eval-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const production = path.join(root, 'production.txt');
  fs.writeFileSync(production, 'unchanged');
  const before = hashFiles([production]);
  const base = path.join(root, 'data', 'evals');
  const run = createRun(base, 'run-001', {
    publicCases: [{ schemaVersion: SCHEMA_VERSION, caseId: 'aaaaaaaaaaaaaaaa', question: '這是一個安全問題嗎？' }],
    publicAnswers: [{ caseId: 'aaaaaaaaaaaaaaaa', A: '回答 A', B: '回答 B' }],
    privateMapping: [{ caseId: 'aaaaaaaaaaaaaaaa', A: 'openai', B: 'deepseek' }],
    privateConfig: { fixture: true }, privateUsage: [],
  });
  assert.equal(fs.statSync(run).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(run, 'public', 'cases.json')).mode & 0o777, 0o600);
  assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'public', 'answers.json')))[0].provider, undefined);
  assertHashesUnchanged(before, hashFiles([production]));
  fs.writeFileSync(production, 'changed');
  assert.throws(() => assertHashesUnchanged(before, hashFiles([production])), /production files changed/);
});

test('artifact writer rejects identifiers/provider leakage and purge stays in base', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-eval-purge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'evals');
  const good = { publicCases: [{ schemaVersion: SCHEMA_VERSION, caseId: 'aaaaaaaaaaaaaaaa', question: '安全的測試問題' }] };
  assert.throws(() => createRun(base, '../escape', good), /unsafe run ID/);
  assert.throws(() => createRun(base, 'leak', { ...good, publicAnswers: [{ provider: 'openai' }] }), /exactly caseId, A, and B/);
  const nestedLeakDir = path.join(base, 'nested-leak');
  assert.throws(() => createRun(base, 'nested-leak', {
    ...good,
    publicAnswers: [{ caseId: 'aaaaaaaaaaaaaaaa', A: '回答 A', B: '回答 B', metadata: { provider: 'openai' } }],
  }), /exactly caseId, A, and B/);
  assert.equal(fs.existsSync(nestedLeakDir), false);
  assert.throws(() => createRun(base, 'typed-leak', {
    ...good,
    publicAnswers: [{ caseId: 'aaaaaaaaaaaaaaaa', A: { text: '回答', metadata: { latency: 12 } }, B: '回答 B' }],
  }), /non-empty strings/);
  assert.throws(() => createRun(base, 'string-leak', {
    ...good,
    publicAnswers: [{ caseId: 'aaaaaaaaaaaaaaaa', A: '由 OpenAI provider 產生', B: '回答 B' }],
  }), /names a provider or model/);
  assert.throws(() => createRun(base, 'pii', { publicCases: [{ schemaVersion: SCHEMA_VERSION, caseId: 'bbbbbbbbbbbbbbbb', question: '寄到 a@example.com 好嗎？' }] }), /residual identifiers/);
  const run = createRun(base, 'old-run', good);
  const old = Date.now() - 8 * 86_400_000;
  fs.utimesSync(run, old / 1000, old / 1000);
  assert.deepEqual(purgeExpired(base), ['old-run']);
  createRun(base, 'manual-run', good);
  assert.equal(purgeRun(base, 'manual-run'), true);
  assert.equal(purgeRun(base, 'manual-run'), false);
});

test('extraction run writes only sanitized public cases and minimal private provenance', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-eval-extraction-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, 'data', 'evals');
  const publicCase = { schemaVersion: SCHEMA_VERSION, caseId: 'aaaaaaaaaaaaaaaa', question: '這是一個完整且安全的獨立問題嗎？' };
  const provenance = {
    schemaVersion: SCHEMA_VERSION,
    targetDisplayLabel: '測試群組',
    cases: [{
      caseId: publicCase.caseId,
      sourceFingerprint: 'b'.repeat(64),
      sanitizationFlags: ['sanitized', 'residual-scan-passed', 'standalone-preflight-passed'],
    }],
  };
  const run = createExtractionRun(base, 'extract-001', { publicCases: [publicCase], provenance });
  assert.deepEqual(fs.readdirSync(path.join(run, 'public')), ['cases.json']);
  assert.deepEqual(fs.readdirSync(path.join(run, 'private')), ['provenance.json']);
  assert.equal(fs.statSync(path.join(run, 'public', 'cases.json')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(run, 'private', 'provenance.json')).mode & 0o777, 0o600);
  assert.throws(() => createExtractionRun(base, 'extract-leak', {
    publicCases: [publicCase],
    provenance: { ...provenance, guildId: '123456789012345678' },
  }), /fields must be exactly/);
  assert.equal(fs.existsSync(path.join(base, 'extract-leak')), false);
  const digest = 'c'.repeat(64);
  const receipt = {
    schemaVersion: SCHEMA_VERSION,
    'ai-turn-log': { beforeSha256: digest, afterSha256: digest, equal: true },
    'user-profiles': { beforeSha256: digest, afterSha256: digest, equal: true },
    'guild-profiles': { beforeSha256: digest, afterSha256: digest, equal: true },
  };
  const receiptPath = writeIntegrityReceipt(run, receipt);
  assert.equal(fs.statSync(receiptPath).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(receiptPath, 'utf8'))).sort(), ['ai-turn-log', 'guild-profiles', 'schemaVersion', 'user-profiles']);
  assert.throws(() => writeIntegrityReceipt(path.join(base, 'extract-leak'), receipt), /ENOENT/);
  const mismatchRun = createExtractionRun(base, 'extract-mismatch', { publicCases: [publicCase], provenance });
  assert.throws(() => writeIntegrityReceipt(mismatchRun, {
    ...receipt,
    'ai-turn-log': { beforeSha256: digest, afterSha256: 'd'.repeat(64), equal: false },
  }), /production integrity mismatch/);
  assert.equal(fs.existsSync(path.join(mismatchRun, 'private', 'integrity.json')), false);
});

test('answer bodies may use ordinary words the strict metadata pattern bans', () => {
  // Regression: a paid-for 20-case run aborted at persist time because one
  // model's reply happened to contain an English word like "cost"/"usage".
  const answer = { caseId: 'a'.repeat(16), A: '這樣的 cost 跟 usage 我覺得還好啦', B: '你這個 model 的講法我不同意' };
  assert.deepEqual(assertPublicAnswer(answer), answer);
});

test('answer bodies still cannot name a provider or model', () => {
  assert.throws(
    () => assertPublicAnswer({ caseId: 'b'.repeat(16), A: '正常回答', B: '我是 DeepSeek 啦' }),
    /names a provider or model/,
  );
  assert.throws(
    () => assertPublicAnswer({ caseId: 'c'.repeat(16), A: '我是 gpt-5.6-luna', B: '正常回答' }),
    /names a provider or model \(gpt-5\.6-luna\)/,
  );
  // A third model's name cannot unblind a two-arm vote, so it is allowed.
  const thirdParty = { caseId: 'd'.repeat(16), A: '那個 Claude 我沒在用', B: '正常回答' };
  assert.deepEqual(assertPublicAnswer(thirdParty), thirdParty);
});
