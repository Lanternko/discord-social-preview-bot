'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { SCHEMA_VERSION, assertPublicCase } = require('./schemas');
const { assertPublicAnswer, namesProviderIdentity } = require('./artifacts');
const { hasResidualIdentifier } = require('./sanitize');
const { assertByteIdentical, buildRequest, CONFIGS, hashText, validateRequest } = require('./providers');
const { PRICING, calculateCost } = require('./pricing');
const {
  MAX_ATTEMPTS, MAX_BUDGET_USD, MAX_ESTIMATED_INPUT_TOKENS, TIMEOUT_MS,
  caseOrder, estimateTokens, parseResponse, projectedCost,
} = require('./runner');

function loadCases(runDir) {
  const publicDir = path.join(runDir, 'public');
  const publicStat = fs.lstatSync(publicDir);
  if (publicStat.isSymbolicLink() || !publicStat.isDirectory() || (publicStat.mode & 0o777) !== 0o700) throw new Error('public run directory security mismatch');
  const file = path.join(publicDir, 'cases.json');
  const fileStat = fs.lstatSync(file);
  if (fileStat.isSymbolicLink() || !fileStat.isFile() || (fileStat.mode & 0o777) !== 0o600) throw new Error('cases file security mismatch');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) throw new Error('run must contain 1-20 public cases');
  const seen = new Set();
  return value.map((item) => {
    assertPublicCase(item);
    if (Object.keys(item).sort().join(',') !== 'caseId,question,schemaVersion' || seen.has(item.caseId) || item.question.length > 1000 || hasResidualIdentifier(item.question)) throw new Error('invalid, unsafe, or duplicate run case');
    seen.add(item.caseId);
    return item;
  });
}

function preflight(cases, persona) {
  let maxEstimatedCostUsd = 0;
  let maxEstimatedInputTokens = 0;
  for (let index = 0; index < cases.length; index += 1) {
    const requests = caseOrder(index).map((provider) => validateRequest(buildRequest(provider, persona, cases[index].question)));
    assertByteIdentical(requests[0], requests[1]);
    const tokens = estimateTokens(persona) + estimateTokens(cases[index].question);
    maxEstimatedInputTokens = Math.max(maxEstimatedInputTokens, tokens);
    if (tokens > MAX_ESTIMATED_INPUT_TOKENS) throw new Error('estimated input token limit exceeded');
    for (const request of requests) maxEstimatedCostUsd += projectedCost(request, tokens).totalUsd;
  }
  if (cases.length * 2 > MAX_ATTEMPTS || maxEstimatedCostUsd > MAX_BUDGET_USD) throw new Error('live preflight budget/attempt limit exceeded');
  return {
    caseCount: cases.length,
    caseCap: 20,
    estimatedAttempts: cases.length * 2,
    attemptCap: MAX_ATTEMPTS,
    maxEstimatedInputTokens,
    maxEstimatedInputTokenCap: MAX_ESTIMATED_INPUT_TOKENS,
    configuredOutputTokens: { openai: CONFIGS.openai.maxOutputTokens, deepseek: CONFIGS.deepseek.maxTokens },
    totalConfiguredOutputTokenCeiling: cases.length * (CONFIGS.openai.maxOutputTokens + CONFIGS.deepseek.maxTokens),
    maxEstimatedCostUsd,
    budgetCapUsd: MAX_BUDGET_USD,
    configs: {
      openai: { configId: CONFIGS.openai.configId, method: CONFIGS.openai.method, url: CONFIGS.openai.url, model: CONFIGS.openai.model, redirect: CONFIGS.openai.redirect, store: false, reasoningEffort: 'low', tools: 0, maxOutputTokens: CONFIGS.openai.maxOutputTokens },
      deepseek: { configId: CONFIGS.deepseek.configId, method: CONFIGS.deepseek.method, url: CONFIGS.deepseek.url, model: CONFIGS.deepseek.model, redirect: CONFIGS.deepseek.redirect, temperature: 0.9, topP: 0.95, tools: 0, maxTokens: CONFIGS.deepseek.maxTokens },
    },
  };
}

function safeHeader(headers, name, allowed) {
  const raw = typeof headers?.get === 'function' ? headers.get(name) : null;
  if (typeof raw !== 'string') return null;
  const normalized = raw.trim().toLowerCase().slice(0, 128);
  return allowed.test(normalized) ? normalized : 'unrecognized';
}

function describeResponseBody(response, text) {
  const trimmed = text.trimStart();
  const first = trimmed[0] || '';
  let firstNonWhitespaceClass = 'other';
  if (!first) firstNonWhitespaceClass = 'empty';
  else if (first === '{') firstNonWhitespaceClass = 'json-object';
  else if (first === '[') firstNonWhitespaceClass = 'json-array';
  else if (first === '<') firstNonWhitespaceClass = 'markup';
  else if (first === '"') firstNonWhitespaceClass = 'json-string';
  else if (/[-0-9tfn]/.test(first)) firstNonWhitespaceClass = 'json-scalar-or-text';
  else if (first === 'd' || first === 'e' || first === ':') firstNonWhitespaceClass = 'event-stream-or-text';
  return {
    contentType: safeHeader(response.headers, 'content-type', /^[a-z0-9!#$&^_.+*-]+\/[a-z0-9!#$&^_.+*-]+(?:\s*;\s*[a-z0-9!#$&^_.+*-]+=[a-z0-9!#$&^_.+*"' -]+)*$/),
    contentEncoding: safeHeader(response.headers, 'content-encoding', /^(?:identity|gzip|br|deflate)$/),
    byteLength: Buffer.byteLength(text, 'utf8'),
    firstNonWhitespaceClass,
    sseFraming: /(?:^|\n)\s*(?:event|data):/m.test(text),
  };
}

async function invokeProvider(request, key, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    let response;
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        redirect: request.redirect,
        signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(request.body),
      });
    } catch (error) {
      throw new Error(error?.name === 'AbortError' || controller.signal.aborted ? 'timeout' : 'transport');
    }
    const latencyMs = Date.now() - started;
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw Object.assign(new Error('redirect'), { status: response.status, latencyMs });
    if (response.status !== 200) throw Object.assign(new Error('non-200'), { status: response.status, latencyMs });
    let responseText;
    try { responseText = await response.text(); } catch { throw Object.assign(new Error('response body read failure'), { status: 200, latencyMs }); }
    const safeResponse = describeResponseBody(response, responseText);
    let payload;
    try { payload = JSON.parse(responseText); } catch { throw Object.assign(new Error('invalid JSON response'), { status: 200, latencyMs, safeResponse }); }
    try {
      return { parsed: parseResponse(request.provider, payload), latencyMs, status: 200 };
    } catch (error) {
      error.status = 200;
      error.latencyMs = latencyMs;
      throw error;
    }
  } finally {
    clearTimeout(timer);
  }
}

function failedAttempt(request, caseId, error) {
  return {
    schemaVersion: SCHEMA_VERSION, caseId, provider: request.provider, configId: request.configId,
    personaHash: request.personaHash, questionHash: request.questionHash,
    status: error.status ?? null, latencyMs: error.latencyMs ?? 0, usage: null, cost: null, error: error.message,
    ...(error.safeResponse ? { responseMetadata: error.safeResponse } : {}),
  };
}

const DIRECTORY_OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0) | (fs.constants.O_NOFOLLOW || 0);
const FILE_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
const FILE_CREATE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0);

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

function procChild(fd, name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new Error('unsafe directory-fd child name');
  return `/proc/self/fd/${fd}/${name}`;
}

function assertDirectoryStat(stat, label) {
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700) throw new Error(`${label} must be a non-symlink 0700 directory`);
}

function openPinnedDirectory(target, expectedPath, label) {
  const before = fs.lstatSync(expectedPath);
  assertDirectoryStat(before, label);
  if (fs.realpathSync(expectedPath) !== expectedPath) throw new Error(`${label} realpath mismatch`);
  const fd = fs.openSync(target, DIRECTORY_OPEN_FLAGS);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isDirectory() || (opened.mode & 0o777) !== 0o700 || !sameIdentity(before, opened)) throw new Error(`${label} changed while pinning`);
    return { fd, path: expectedPath, identity: opened, label };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function revalidatePinnedDirectory(directory) {
  const current = fs.lstatSync(directory.path);
  assertDirectoryStat(current, directory.label);
  if (!sameIdentity(current, directory.identity) || !sameIdentity(fs.fstatSync(directory.fd), directory.identity) || fs.realpathSync(directory.path) !== directory.path) {
    throw new Error(`${directory.label} changed after pinning`);
  }
}

function withPinnedRunDirectories(evaluationRoot, runDir, callback) {
  const resolvedRoot = path.resolve(evaluationRoot);
  const resolvedRun = path.resolve(runDir);
  if (path.dirname(resolvedRun) !== resolvedRoot || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(path.basename(resolvedRun))) {
    throw new Error('run path is not an exact evaluation-root child');
  }
  const opened = [];
  let context;
  try {
    const root = openPinnedDirectory(resolvedRoot, resolvedRoot, 'evaluation root');
    opened.push(root);
    const run = openPinnedDirectory(procChild(root.fd, path.basename(resolvedRun)), resolvedRun, 'run directory');
    opened.push(run);
    const publicDir = openPinnedDirectory(procChild(run.fd, 'public'), path.join(resolvedRun, 'public'), 'public directory');
    opened.push(publicDir);
    const privateDir = openPinnedDirectory(procChild(run.fd, 'private'), path.join(resolvedRun, 'private'), 'private directory');
    opened.push(privateDir);
    context = { root, run, publicDir, privateDir, createdFiles: [] };
    for (const directory of opened) revalidatePinnedDirectory(directory);
    const value = callback(context);
    for (const directory of opened) revalidatePinnedDirectory(directory);
    return value;
  } catch (error) {
    if (context?.createdFiles.length) {
      try {
        for (const created of context.createdFiles.slice().reverse()) rollbackPinnedFile(created);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'artifact transaction rejected and rollback incomplete');
      }
    }
    throw error;
  } finally {
    for (const directory of opened.reverse()) fs.closeSync(directory.fd);
  }
}

function purgeEmptyPairArtifactsPinned(context) {
  const targets = [[context.publicDir, 'answers.json'], [context.privateDir, 'mapping.json']];
  for (const [directory, name] of targets) {
    const target = procChild(directory.fd, name);
    if (!fs.existsSync(target)) continue;
    const before = fs.lstatSync(target);
    if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o777) !== 0o600) throw new Error('empty pair artifact must be a 0600 regular file');
    const fd = fs.openSync(target, FILE_READ_FLAGS);
    let raw;
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || !sameIdentity(opened, before) || opened.size > 32) throw new Error('empty pair artifact changed during validation');
      raw = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    let value;
    try { value = JSON.parse(raw); } catch { throw new Error('empty pair artifact contains invalid JSON'); }
    if (!Array.isArray(value) || value.length !== 0) throw new Error('refusing to purge non-empty pair artifact');
    for (const pinned of [context.root, context.run, context.publicDir, context.privateDir]) revalidatePinnedDirectory(pinned);
    const current = fs.lstatSync(target);
    if (current.isSymbolicLink() || !sameIdentity(current, before)) throw new Error('empty pair artifact changed before unlink');
    fs.unlinkSync(target);
    if (fs.existsSync(target)) throw new Error('empty pair artifact unlink failed');
  }
}

function purgeEmptyPairArtifacts(evaluationRoot, runDir) {
  return withPinnedRunDirectories(evaluationRoot, runDir, purgeEmptyPairArtifactsPinned);
}

function writePinnedJson(context, directory, name, value) {
  const target = procChild(directory.fd, name);
  const fd = fs.openSync(target, FILE_CREATE_FLAGS, 0o600);
  try {
    const identity = fs.fstatSync(fd);
    if (!identity.isFile()) throw new Error('live artifact is not a regular file');
    context.createdFiles.push({ directory, name, identity });
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fchmodSync(fd, 0o600);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('live artifact file security mismatch');
  } finally {
    fs.closeSync(fd);
  }
}

function rollbackPinnedFile(created) {
  const target = procChild(created.directory.fd, created.name);
  if (!fs.existsSync(target)) return;
  const current = fs.lstatSync(target);
  if (current.isSymbolicLink() || !current.isFile() || !sameIdentity(current, created.identity)) throw new Error('created artifact changed before rollback');
  fs.unlinkSync(target);
  if (fs.existsSync(target)) throw new Error('created artifact rollback failed');
}

async function runLiveEvaluation(options) {
  if (typeof options.fetchImpl !== 'function') throw new Error('fetch implementation is required');
  for (const provider of ['openai', 'deepseek']) {
    if (typeof options.keys?.[provider] !== 'string' || options.keys[provider].length < 12) throw new Error(`validated ${provider} key is required`);
  }
  const summary = preflight(options.cases, options.persona);
  const attempts = [];
  const completedPairs = [];
  let aborted = null;
  outer: for (let index = 0; index < options.cases.length; index += 1) {
    const item = options.cases[index];
    const requests = caseOrder(index).map((provider) => validateRequest(buildRequest(provider, options.persona, item.question)));
    const byProvider = {};
    for (const request of requests) {
      try {
        const result = await invokeProvider(request, options.keys[request.provider], options.fetchImpl);
        const attempt = {
          schemaVersion: SCHEMA_VERSION, caseId: item.caseId, provider: request.provider,
          configId: request.configId, personaHash: request.personaHash, questionHash: request.questionHash,
          status: result.status, latencyMs: result.latencyMs, usage: result.parsed.usage,
          cost: calculateCost(request.provider, result.parsed.usage), answer: result.parsed.answer,
        };
        attempts.push(attempt);
        byProvider[request.provider] = attempt;
      } catch (error) {
        attempts.push(failedAttempt(request, item.caseId, error));
        aborted = { caseId: item.caseId, provider: request.provider, reason: error.message };
        break outer;
      }
    }
    const bit = (options.randomBit || (() => randomInt(2)))();
    if (bit !== 0 && bit !== 1) throw new Error('randomBit must return 0 or 1');
    const mapping = bit === 0 ? { A: 'openai', B: 'deepseek' } : { A: 'deepseek', B: 'openai' };
    completedPairs.push({
      caseId: item.caseId, completed: true, mapping,
      answers: { A: byProvider[mapping.A].answer, B: byProvider[mapping.B].answer },
    });
  }
  return { schemaVersion: SCHEMA_VERSION, personaHash: hashText(options.persona), pricing: PRICING, preflight: summary, attempts, completedPairs, aborted };
}

function persistLiveArtifacts(runDir, result, options = {}) {
  if (typeof options.evaluationRoot !== 'string') throw new Error('validated evaluation root is required');
  // A model that names its own vendor mid-answer would unblind the voter, but
  // the other 19 pairs are still valid evidence AND already paid for — drop the
  // contaminated pair and report the count instead of discarding the run. The
  // exclusions land in the private config so the human reading the result knows
  // the sample was trimmed and why.
  const excluded = [];
  const usablePairs = result.completedPairs.filter((pair) => {
    const hit = namesProviderIdentity(pair.answers.A) || namesProviderIdentity(pair.answers.B);
    if (hit) excluded.push({ caseId: pair.caseId, reason: 'self-identified-provider' });
    return !hit;
  });
  // Zero completed pairs means the run aborted upstream, not that everything
  // was contaminated — let the abort path own that error.
  if (result.completedPairs.length > 0 && usablePairs.length === 0) {
    throw new Error('every completed pair named a provider — nothing blindable to vote on');
  }
  const answers = usablePairs.map((pair) => assertPublicAnswer({ caseId: pair.caseId, A: pair.answers.A, B: pair.answers.B }));
  const mapping = usablePairs.map((pair) => ({ caseId: pair.caseId, A: pair.mapping.A, B: pair.mapping.B }));
  const config = {
    schemaVersion: SCHEMA_VERSION,
    personaHash: result.personaHash,
    excludedPairs: excluded,
    pricing: PRICING,
    providers: {
      openai: {
        configId: CONFIGS.openai.configId, method: CONFIGS.openai.method, url: CONFIGS.openai.url,
        redirect: CONFIGS.openai.redirect, model: CONFIGS.openai.model,
        store: false, reasoningEffort: 'low', tools: false, maxOutputTokens: CONFIGS.openai.maxOutputTokens,
      },
      deepseek: {
        configId: CONFIGS.deepseek.configId, method: CONFIGS.deepseek.method, url: CONFIGS.deepseek.url,
        redirect: CONFIGS.deepseek.redirect, model: CONFIGS.deepseek.model,
        temperature: 0.9, topP: 0.95, tools: false, maxTokens: CONFIGS.deepseek.maxTokens,
      },
    },
  };
  const usage = result.attempts.map(({ answer, ...attempt }) => attempt);
  return withPinnedRunDirectories(options.evaluationRoot, runDir, (context) => {
    if (answers.length === 0) purgeEmptyPairArtifactsPinned(context);
    const outputs = answers.length === 0
      ? [[context.privateDir, 'config.json', config], [context.privateDir, 'usage.json', usage]]
      : [
        [context.publicDir, 'answers.json', answers], [context.privateDir, 'mapping.json', mapping],
        [context.privateDir, 'config.json', config], [context.privateDir, 'usage.json', usage],
      ];
    for (const [directory, name, value] of outputs) {
      for (const pinned of [context.root, context.run, context.publicDir, context.privateDir]) revalidatePinnedDirectory(pinned);
      writePinnedJson(context, directory, name, value);
    }
  });
}

module.exports = {
  describeResponseBody, invokeProvider, loadCases, persistLiveArtifacts,
  preflight, purgeEmptyPairArtifacts, runLiveEvaluation, withPinnedRunDirectories,
};
