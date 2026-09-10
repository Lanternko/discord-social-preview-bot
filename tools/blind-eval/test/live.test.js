'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SCHEMA_VERSION } = require('../schemas');
const { executeCli } = require('../cli');
const { describeResponseBody, persistLiveArtifacts, purgeEmptyPairArtifacts } = require('../live');
const { parseExactEnvLine, readDeepSeekKey, readEphemeralKey } = require('../secrets');

const RAW_QUESTION = 'fixture raw question marker？';
const OPENAI_SECRET = 'sk-fixture-openai-1234567890';
const DEEPSEEK_SECRET = 'ds-fixture-deepseek-1234567890';

function response(status, value, extra = {}) {
  const headers = extra.headers || { get(name) { return name === 'content-type' ? 'application/json; charset=utf-8' : null; } };
  return {
    status, redirected: false, headers,
    async text() { return value instanceof Error ? '<html>fixture challenge</html>' : JSON.stringify(value); },
    ...extra,
    headers,
  };
}

function providerResponse(url, suffix = '') {
  if (url.includes('openai.com')) return response(200, {
    output_text: `甲回答${suffix}`,
    usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20, cache_write_tokens: 3 }, output_tokens: 15, output_tokens_details: { reasoning_tokens: 4 } },
  });
  return response(200, {
    choices: [{ message: { content: `乙回答${suffix}` } }],
    usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80, completion_tokens: 15, completion_tokens_details: { reasoning_tokens: 4 } },
  });
}

function setup(t, caseCount = 2) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blind-live-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runBase = path.join(root, 'data', 'evals');
  const runId = 'run-001';
  const runDir = path.join(runBase, runId);
  fs.mkdirSync(path.join(runDir, 'public'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(runDir, 'private'), { mode: 0o700 });
  for (const dir of [runBase, runDir, path.join(runDir, 'public'), path.join(runDir, 'private')]) fs.chmodSync(dir, 0o700);
  const cases = Array.from({ length: caseCount }, (_, index) => ({ schemaVersion: SCHEMA_VERSION, caseId: `${index + 1}`.repeat(16), question: `${RAW_QUESTION}${index}` }));
  fs.writeFileSync(path.join(runDir, 'public', 'cases.json'), JSON.stringify(cases), { mode: 0o600 });
  const digest = 'd'.repeat(64);
  const provenance = { schemaVersion: SCHEMA_VERSION, targetDisplayLabel: 'fixture target', cases: cases.map((item) => ({ caseId: item.caseId, sourceFingerprint: 'e'.repeat(64), sanitizationFlags: ['sanitized', 'residual-scan-passed', 'standalone-preflight-passed'] })) };
  const integrity = { schemaVersion: SCHEMA_VERSION, 'ai-turn-log': { beforeSha256: digest, afterSha256: digest, equal: true }, 'user-profiles': { beforeSha256: digest, afterSha256: digest, equal: true }, 'guild-profiles': { beforeSha256: digest, afterSha256: digest, equal: true } };
  fs.writeFileSync(path.join(runDir, 'private', 'provenance.json'), JSON.stringify(provenance), { mode: 0o600 });
  fs.writeFileSync(path.join(runDir, 'private', 'integrity.json'), JSON.stringify(integrity), { mode: 0o600 });
  const personaModule = path.join(root, 'persona.js');
  fs.writeFileSync(personaModule, "module.exports = { DEFAULT_AI_PERSONA: 'fixture persona exact' };\n", { mode: 0o600 });
  const deepseekEnv = path.join(root, '.env');
  const envContent = `UNRELATED_SECRET=must-not-log\nDEEPSEEK_API_KEY=${DEEPSEEK_SECRET}\nANOTHER=value\n`;
  fs.writeFileSync(deepseekEnv, envContent, { mode: 0o600 });
  const openaiKeyPath = path.join(root, 'openai-key');
  fs.writeFileSync(openaiKeyPath, `${OPENAI_SECRET}\n`, { mode: 0o600 });
  const deps = { runBase, personaModule, deepseekEnv, openaiKeyPath, openaiExpectedUid: process.getuid() };
  return { root, runDir, openaiKeyPath, deepseekEnv, envContent, deps, cases };
}

function emptyArtifactResult() {
  return { completedPairs: [], attempts: [], personaHash: 'a'.repeat(64), aborted: { reason: 'fixture' } };
}

test('secure secret readers enforce exact key parsing, mode, owner and plausible values', async (t) => {
  const fixture = setup(t, 1);
  assert.equal(parseExactEnvLine('OTHER_DEEPSEEK_API_KEY=nope'), null);
  assert.equal(parseExactEnvLine(`DEEPSEEK_API_KEY='${DEEPSEEK_SECRET}'`), DEEPSEEK_SECRET);
  assert.equal(await readDeepSeekKey(fixture.deepseekEnv), DEEPSEEK_SECRET);
  assert.equal(readEphemeralKey(fixture.openaiKeyPath, process.getuid()), OPENAI_SECRET);
  fs.chmodSync(fixture.deepseekEnv, 0o644);
  await assert.rejects(() => readDeepSeekKey(fixture.deepseekEnv), /mode must be 0600/);
});

test('preflight makes zero calls and performs no secret read or unlink', async (t) => {
  const fixture = setup(t, 2);
  let calls = 0;
  const logs = [];
  const summary = await executeCli(['--preflight', '--run', 'run-001'], {
    ...fixture.deps,
    openaiKeyPath: path.join(fixture.root, 'missing-openai-key'),
    deepseekEnv: path.join(fixture.root, 'missing-env'),
    fetchImpl: async () => { calls += 1; }, writeOutput: (line) => logs.push(line),
  });
  assert.equal(calls, 0);
  assert.equal(summary.caseCount, 2);
  assert.equal(summary.estimatedAttempts, 4);
  assert.ok(summary.maxEstimatedCostUsd > 0 && summary.maxEstimatedCostUsd <= 0.25);
  assert.equal(fs.existsSync(fixture.openaiKeyPath), true);
  assert.equal(summary.caseCap, 20);
  assert.equal(summary.attemptCap, 40);
  assert.deepEqual(summary.artifactReadiness, { casesReady: true, provenanceReady: true, integrityReady: true, liveOutputsAbsent: true });
  const logged = logs.join(' ');
  for (const secret of [OPENAI_SECRET, DEEPSEEK_SECRET, RAW_QUESTION, 'fixture persona exact', 'UNRELATED_SECRET']) assert.doesNotMatch(logged, new RegExp(secret));
  assert.equal(fs.readFileSync(fixture.deepseekEnv, 'utf8'), fixture.envContent);
});

test('successful live execution is sequential AB/BA while mapping randomization is independent', async (t) => {
  const fixture = setup(t, 2);
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    assert.ok(options.signal instanceof AbortSignal);
    const expected = url.includes('openai.com') ? OPENAI_SECRET : DEEPSEEK_SECRET;
    assert.equal(options.headers.authorization, `Bearer ${expected}`);
    return providerResponse(url, String(calls.length));
  };
  const summary = await executeCli(['--execute', '--run', 'run-001', '--ack-provider-retention-unknown'], {
    ...fixture.deps, fetchImpl, randomBit: () => 0, writeOutput: (line) => logs.push(line),
  });
  assert.equal(summary.status, 'complete');
  assert.equal(summary.completedPairs, 2);
  assert.equal(summary.attemptCount, 4);
  assert.deepEqual(calls.map((call) => call.url.includes('openai.com') ? 'openai' : 'deepseek'), ['openai', 'deepseek', 'deepseek', 'openai']);
  assert.equal(fs.existsSync(fixture.openaiKeyPath), false);
  assert.equal(fs.readFileSync(fixture.deepseekEnv, 'utf8'), fixture.envContent);

  const answers = JSON.parse(fs.readFileSync(path.join(fixture.runDir, 'public', 'answers.json')));
  const mapping = JSON.parse(fs.readFileSync(path.join(fixture.runDir, 'private', 'mapping.json')));
  assert.deepEqual(mapping.map((item) => ({ A: item.A, B: item.B })), [{ A: 'openai', B: 'deepseek' }, { A: 'openai', B: 'deepseek' }]);
  assert.deepEqual(Object.keys(answers[0]).sort(), ['A', 'B', 'caseId']);
  assert.equal(JSON.stringify(answers).includes('openai'), false);
  const usage = JSON.parse(fs.readFileSync(path.join(fixture.runDir, 'private', 'usage.json')));
  assert.equal(usage.length, 4);
  assert.equal(usage.some((item) => 'answer' in item), false);
  assert.equal(usage[0].usage.cacheWriteTokens, 3);
  const privateConfig = fs.readFileSync(path.join(fixture.runDir, 'private', 'config.json'), 'utf8');
  for (const secret of [OPENAI_SECRET, DEEPSEEK_SECRET, RAW_QUESTION, 'fixture persona exact', '甲回答', '乙回答']) assert.doesNotMatch(privateConfig, new RegExp(secret));
  for (const file of ['public/answers.json', 'private/mapping.json', 'private/config.json', 'private/usage.json']) assert.equal(fs.statSync(path.join(fixture.runDir, file)).mode & 0o777, 0o600);
  const logged = logs.join(' ');
  for (const secret of [OPENAI_SECRET, DEEPSEEK_SECRET, RAW_QUESTION, '甲回答', '乙回答']) assert.doesNotMatch(logged, new RegExp(secret));
});

const failures = [
  ['non-200', async () => response(429, {})],
  ['redirect', async () => response(200, {}, { redirected: true })],
  ['invalid-json', async () => response(200, new Error('bad json'))],
  ['missing-answer', async (url) => url.includes('openai.com') ? response(200, { usage: { input_tokens: 1, output_tokens: 1 } }) : providerResponse(url)],
  ['malformed-usage', async () => response(200, { output_text: 'answer', usage: { input_tokens: 'bad', output_tokens: 1 } })],
  ['transport', async () => { throw new Error('socket detail must not escape'); }],
  ['timeout', async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error; }],
];

for (const [name, failingFetch] of failures) {
  test(`failure ${name} aborts with no next call, persists no public pair, and cleans key`, async (t) => {
    const fixture = setup(t, 2);
    const answersPath = path.join(fixture.runDir, 'public', 'answers.json');
    const mappingPath = path.join(fixture.runDir, 'private', 'mapping.json');
    fs.writeFileSync(answersPath, '[]\n', { mode: 0o600 });
    fs.writeFileSync(mappingPath, '[]\n', { mode: 0o600 });
    let calls = 0;
    await assert.rejects(() => executeCli(['--execute', '--run', 'run-001', '--ack-provider-retention-unknown'], {
      ...fixture.deps,
      fetchImpl: async (...args) => { calls += 1; return failingFetch(...args); },
      randomBit: () => 0,
    }), /live evaluation aborted/);
    assert.equal(calls, 1);
    assert.equal(fs.existsSync(fixture.openaiKeyPath), false);
    assert.equal(fs.existsSync(answersPath), false);
    assert.equal(fs.existsSync(mappingPath), false);
    const configPath = path.join(fixture.runDir, 'private', 'config.json');
    const usagePath = path.join(fixture.runDir, 'private', 'usage.json');
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(usagePath).mode & 0o777, 0o600);
    const usage = JSON.parse(fs.readFileSync(usagePath));
    assert.equal(usage.length, 1);
    assert.equal(usage[0].cost, null);
    if (name === 'invalid-json') {
      assert.deepEqual(usage[0].responseMetadata, {
        contentType: 'application/json; charset=utf-8',
        contentEncoding: null,
        byteLength: 30,
        firstNonWhitespaceClass: 'markup',
        sseFraming: false,
      });
      assert.doesNotMatch(JSON.stringify(usage[0]), /fixture challenge/);
    }
  });
}

test('empty pair artifact purge rejects symlinks and preserves their targets', (t) => {
  const fixture = setup(t, 1);
  const external = path.join(fixture.root, 'external-empty.json');
  fs.writeFileSync(external, '[]\n', { mode: 0o600 });
  const answersPath = path.join(fixture.runDir, 'public', 'answers.json');
  fs.symlinkSync(external, answersPath);
  assert.throws(() => purgeEmptyPairArtifacts(fixture.deps.runBase, fixture.runDir), /0600 regular file/);
  assert.equal(fs.readFileSync(external, 'utf8'), '[]\n');
  assert.equal(fs.lstatSync(answersPath).isSymbolicLink(), true);
});

test('artifact persistence rejects a symlinked run directory without touching external targets', (t) => {
  const fixture = setup(t, 1);
  const parked = path.join(fixture.deps.runBase, 'parked-run');
  const external = path.join(fixture.root, 'external-run');
  fs.mkdirSync(path.join(external, 'public'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(external, 'private'), { mode: 0o700 });
  for (const dir of [external, path.join(external, 'public'), path.join(external, 'private')]) fs.chmodSync(dir, 0o700);
  const sentinel = path.join(external, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external-unchanged', { mode: 0o600 });
  fs.renameSync(fixture.runDir, parked);
  fs.symlinkSync(external, fixture.runDir);
  assert.throws(() => persistLiveArtifacts(fixture.runDir, emptyArtifactResult(), { evaluationRoot: fixture.deps.runBase }));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external-unchanged');
  assert.equal(fs.existsSync(path.join(external, 'private', 'config.json')), false);
  assert.equal(fs.existsSync(path.join(external, 'private', 'usage.json')), false);
  assert.equal(fs.existsSync(path.join(parked, 'private', 'config.json')), false);
});

test('artifact persistence detects a TOCTOU run swap after pinning and writes nowhere external', (t) => {
  const fixture = setup(t, 1);
  const parked = path.join(fixture.deps.runBase, 'parked-race-run');
  const external = path.join(fixture.root, 'external-race-run');
  fs.mkdirSync(path.join(external, 'public'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(external, 'private'), { mode: 0o700 });
  for (const dir of [external, path.join(external, 'public'), path.join(external, 'private')]) fs.chmodSync(dir, 0o700);
  const sentinel = path.join(external, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external-race-unchanged', { mode: 0o600 });
  const originalLstat = fs.lstatSync;
  let runChecks = 0;
  let swapped = false;
  fs.lstatSync = function instrumentedLstat(candidate, ...args) {
    if (path.resolve(String(candidate)) === fixture.runDir) {
      runChecks += 1;
      if (runChecks === 2) {
        fs.renameSync(fixture.runDir, parked);
        fs.symlinkSync(external, fixture.runDir);
        swapped = true;
      }
    }
    return originalLstat.call(fs, candidate, ...args);
  };
  try {
    assert.throws(() => persistLiveArtifacts(fixture.runDir, emptyArtifactResult(), { evaluationRoot: fixture.deps.runBase }), /run directory/);
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external-race-unchanged');
  for (const base of [external, parked]) {
    assert.equal(fs.existsSync(path.join(base, 'public', 'answers.json')), false);
    assert.equal(fs.existsSync(path.join(base, 'private', 'mapping.json')), false);
    assert.equal(fs.existsSync(path.join(base, 'private', 'config.json')), false);
    assert.equal(fs.existsSync(path.join(base, 'private', 'usage.json')), false);
  }
});

test('post-callback run swap rolls back every newly created artifact from parked directory', (t) => {
  const fixture = setup(t, 1);
  const parked = path.join(fixture.deps.runBase, 'parked-post-callback-run');
  const external = path.join(fixture.root, 'external-post-callback-run');
  fs.mkdirSync(path.join(external, 'public'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(external, 'private'), { mode: 0o700 });
  for (const dir of [external, path.join(external, 'public'), path.join(external, 'private')]) fs.chmodSync(dir, 0o700);
  const sentinel = path.join(external, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'external-post-callback-unchanged', { mode: 0o600 });
  const originalLstat = fs.lstatSync;
  let runChecks = 0;
  let swapped = false;
  fs.lstatSync = function instrumentedPostCallbackLstat(candidate, ...args) {
    if (path.resolve(String(candidate)) === fixture.runDir) {
      runChecks += 1;
      if (runChecks === 5) {
        fs.renameSync(fixture.runDir, parked);
        fs.symlinkSync(external, fixture.runDir);
        swapped = true;
      }
    }
    return originalLstat.call(fs, candidate, ...args);
  };
  try {
    assert.throws(() => persistLiveArtifacts(fixture.runDir, emptyArtifactResult(), { evaluationRoot: fixture.deps.runBase }), /run directory/);
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external-post-callback-unchanged');
  for (const base of [external, parked]) {
    assert.equal(fs.existsSync(path.join(base, 'public', 'answers.json')), false);
    assert.equal(fs.existsSync(path.join(base, 'private', 'mapping.json')), false);
    assert.equal(fs.existsSync(path.join(base, 'private', 'config.json')), false);
    assert.equal(fs.existsSync(path.join(base, 'private', 'usage.json')), false);
  }
  assert.equal(fs.existsSync(path.join(parked, 'private', 'provenance.json')), true);
  assert.equal(fs.existsSync(path.join(parked, 'private', 'integrity.json')), true);
});

test('rollback never deletes a preexisting retained receipt', (t) => {
  const fixture = setup(t, 1);
  const retained = path.join(fixture.runDir, 'private', 'config.json');
  fs.writeFileSync(retained, '{"retained":true}\n', { mode: 0o600 });
  assert.throws(() => persistLiveArtifacts(fixture.runDir, emptyArtifactResult(), { evaluationRoot: fixture.deps.runBase }), /EEXIST/);
  assert.equal(fs.readFileSync(retained, 'utf8'), '{"retained":true}\n');
  assert.equal(fs.existsSync(path.join(fixture.runDir, 'private', 'usage.json')), false);
});

test('safe response diagnostics classify HTML, SSE, empty, and truncated JSON without excerpts', () => {
  const headers = { get(name) { return name === 'content-type' ? 'text/event-stream' : name === 'content-encoding' ? 'gzip' : null; } };
  const sse = describeResponseBody({ headers }, 'data: {"x":1}\n\n');
  assert.deepEqual(sse, { contentType: 'text/event-stream', contentEncoding: 'gzip', byteLength: 15, firstNonWhitespaceClass: 'event-stream-or-text', sseFraming: true });
  assert.equal(describeResponseBody({ headers }, '   ').firstNonWhitespaceClass, 'empty');
  assert.equal(describeResponseBody({ headers }, '<html>').firstNonWhitespaceClass, 'markup');
  const truncated = describeResponseBody({ headers }, '{"incomplete":');
  assert.equal(truncated.firstNonWhitespaceClass, 'json-object');
  assert.equal('bodyExcerpt' in truncated, false);
  assert.equal('requestId' in truncated, false);
});

test('execute gate rejection still unlinks ephemeral key and makes no call', async (t) => {
  const fixture = setup(t, 1);
  let calls = 0;
  await assert.rejects(() => executeCli(['--execute', '--run', 'run-001'], { ...fixture.deps, fetchImpl: async () => { calls += 1; } }), /requires --ack/);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(fixture.openaiKeyPath), false);
});

test('live trust boundary rejects unsafe or weakly-permissioned cases before calls', async (t) => {
  const fixture = setup(t, 1);
  const casesPath = path.join(fixture.runDir, 'public', 'cases.json');
  const unsafe = [{ schemaVersion: SCHEMA_VERSION, caseId: 'a'.repeat(16), question: '請聯絡 unsafe@example.com' }];
  fs.writeFileSync(casesPath, JSON.stringify(unsafe), { mode: 0o600 });
  let calls = 0;
  await assert.rejects(() => executeCli(['--preflight', '--run', 'run-001'], { ...fixture.deps, fetchImpl: async () => { calls += 1; } }), /invalid, unsafe/);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(fixture.openaiKeyPath), true);

  fs.writeFileSync(fixture.openaiKeyPath, `${OPENAI_SECRET}\n`, { mode: 0o600 });
  fs.writeFileSync(casesPath, JSON.stringify(fixture.cases));
  fs.chmodSync(casesPath, 0o644);
  await assert.rejects(() => executeCli(['--preflight', '--run', 'run-001'], { ...fixture.deps, fetchImpl: async () => { calls += 1; } }), /cases file security mismatch/);
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(fixture.openaiKeyPath), true);
});
