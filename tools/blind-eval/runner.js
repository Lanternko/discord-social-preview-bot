'use strict';

const { SCHEMA_VERSION } = require('./schemas');
const { MAX_CASES } = require('./sanitize');
const { buildRequest, validateRequest, assertByteIdentical } = require('./providers');
const { PRICING, calculateCost, normalizeUsage } = require('./pricing');
const { assertHashesUnchanged, hashFiles } = require('./artifacts');

const MAX_ATTEMPTS = 40;
const MAX_ESTIMATED_INPUT_TOKENS = 6000;
const MAX_BUDGET_USD = 0.25;
const TIMEOUT_MS = 30_000;

function estimateTokens(text) {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
}

function maxTokensFor(request) {
  return request.provider === 'openai' ? request.body.max_output_tokens : request.body.max_tokens;
}

function projectedCost(request, estimatedInputTokens) {
  const maxOutput = maxTokensFor(request);
  return calculateCost(request.provider, {
    uncachedInputTokens: estimatedInputTokens,
    cachedInputTokens: 0,
    cacheWriteTokens: request.provider === 'deepseek' ? estimatedInputTokens : 0,
    outputTokens: maxOutput,
    reasoningTokens: maxOutput,
  });
}

function parseResponse(provider, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid JSON response');
  if (provider === 'openai') {
    const answer = typeof payload.output_text === 'string'
      ? payload.output_text
      : payload.output?.flatMap((item) => item?.content || []).find((item) => item?.type === 'output_text')?.text;
    if (typeof answer !== 'string' || !answer.trim()) throw new Error('missing answer');
    const input = payload.usage?.input_tokens;
    const cached = payload.usage?.input_tokens_details?.cached_tokens ?? 0;
    const output = payload.usage?.output_tokens;
    const reasoning = payload.usage?.output_tokens_details?.reasoning_tokens ?? 0;
    const cacheWrite = payload.usage?.input_tokens_details?.cache_write_tokens ?? payload.usage?.cache_write_tokens ?? 0;
    if (![input, cached, cacheWrite, output, reasoning].every(Number.isInteger) || input < cached) throw new Error('malformed usage');
    return {
      answer: answer.trim(),
      usage: normalizeUsage({
        uncachedInputTokens: input - cached,
        cachedInputTokens: cached,
        cacheWriteTokens: cacheWrite,
        outputTokens: output,
        reasoningTokens: reasoning,
      }),
    };
  }
  const answer = payload.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('missing answer');
  const prompt = payload.usage?.prompt_tokens;
  const cached = payload.usage?.prompt_cache_hit_tokens ?? 0;
  const cacheWrite = payload.usage?.prompt_cache_miss_tokens ?? 0;
  const output = payload.usage?.completion_tokens;
  const reasoning = payload.usage?.completion_tokens_details?.reasoning_tokens ?? payload.usage?.reasoning_tokens ?? 0;
  if (![prompt, cached, cacheWrite, output, reasoning].every(Number.isInteger) || cached + cacheWrite > prompt) {
    throw new Error('malformed usage');
  }
  return {
    answer: answer.trim(),
    usage: normalizeUsage({
      uncachedInputTokens: Math.max(0, prompt - cached),
      cachedInputTokens: cached,
      cacheWriteTokens: cacheWrite,
      outputTokens: output,
      reasoningTokens: reasoning,
    }),
  };
}

function caseOrder(index) {
  return index % 2 === 0 ? ['openai', 'deepseek'] : ['deepseek', 'openai'];
}

async function invokeWithTimeout(invokeFixture, request) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => invokeFixture(request)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function failedAttempt(request, caseId, status, latencyMs, error) {
  return {
    schemaVersion: SCHEMA_VERSION,
    caseId,
    provider: request.provider,
    configId: request.configId,
    personaHash: request.personaHash,
    questionHash: request.questionHash,
    status,
    latencyMs,
    usage: null,
    cost: null,
    error,
  };
}

async function runFixtureEvaluation(options) {
  const cases = options?.cases;
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > MAX_CASES) throw new Error(`cases must contain 1-${MAX_CASES} items`);
  if (options.mode !== 'fixture' || typeof options.invokeFixture !== 'function') {
    throw new Error('Slice A supports fixture mode only; network execution is disabled');
  }
  if (typeof options.persona !== 'string' || !options.persona) throw new Error('persona is required');
  const productionPaths = options.productionPaths || [];
  if (!Array.isArray(productionPaths)) throw new Error('productionPaths must be an array');
  const productionBefore = hashFiles(productionPaths);

  const attempts = [];
  const pairs = [];
  let reservedUsd = 0;
  let aborted = null;

  outer: for (let index = 0; index < cases.length; index += 1) {
    const item = cases[index];
    const providers = caseOrder(index);
    const requests = providers.map((provider) => validateRequest(buildRequest(provider, options.persona, item.question)));
    assertByteIdentical(requests[0], requests[1]);
    const estimatedInputTokens = estimateTokens(options.persona) + estimateTokens(item.question);
    if (estimatedInputTokens > MAX_ESTIMATED_INPUT_TOKENS) {
      aborted = { caseId: item.caseId, reason: 'estimated-input-limit', beforeCall: true };
      break;
    }
    const pairAttempts = [];
    for (const request of requests) {
      if (attempts.length >= MAX_ATTEMPTS) {
        aborted = { caseId: item.caseId, reason: 'attempt-limit', beforeCall: true };
        break outer;
      }
      const reservation = projectedCost(request, estimatedInputTokens).totalUsd;
      if (reservedUsd + reservation > MAX_BUDGET_USD) {
        aborted = { caseId: item.caseId, reason: 'budget-limit', beforeCall: true };
        break outer;
      }
      reservedUsd += reservation;
      const started = Date.now();
      let response;
      try {
        response = await invokeWithTimeout(options.invokeFixture, request);
      } catch (error) {
        const reason = error.message === 'timeout' ? 'timeout' : 'transport';
        attempts.push(failedAttempt(request, item.caseId, null, Date.now() - started, reason));
        aborted = { caseId: item.caseId, provider: request.provider, reason };
        break outer;
      }
      const latencyMs = Number.isFinite(response?.latencyMs) ? response.latencyMs : Date.now() - started;
      if (response?.redirected || (Number.isInteger(response?.status) && response.status >= 300 && response.status < 400)) {
        attempts.push(failedAttempt(request, item.caseId, response?.status ?? null, latencyMs, 'redirect'));
        aborted = { caseId: item.caseId, provider: request.provider, reason: 'redirect' };
        break outer;
      }
      if (response?.status !== 200) {
        attempts.push(failedAttempt(request, item.caseId, response?.status ?? null, latencyMs, 'non-200'));
        aborted = { caseId: item.caseId, provider: request.provider, reason: 'non-200' };
        break outer;
      }
      let parsed;
      try {
        parsed = parseResponse(request.provider, response.json);
      } catch (error) {
        attempts.push(failedAttempt(request, item.caseId, 200, latencyMs, error.message));
        aborted = { caseId: item.caseId, provider: request.provider, reason: error.message };
        break outer;
      }
      const attempt = {
        schemaVersion: SCHEMA_VERSION,
        caseId: item.caseId,
        provider: request.provider,
        configId: request.configId,
        personaHash: request.personaHash,
        questionHash: request.questionHash,
        status: 200,
        latencyMs,
        usage: parsed.usage,
        cost: calculateCost(request.provider, parsed.usage),
        answer: parsed.answer,
      };
      attempts.push(attempt);
      pairAttempts.push(attempt);
    }
    if (pairAttempts.length === 2) {
      const mapping = index % 2 === 0 ? { A: providers[0], B: providers[1] } : { A: providers[0], B: providers[1] };
      pairs.push({ caseId: item.caseId, completed: true, mapping, attempts: pairAttempts });
    }
  }
  assertHashesUnchanged(productionBefore, hashFiles(productionPaths));
  return { schemaVersion: SCHEMA_VERSION, pricing: PRICING, attempts, completedPairs: pairs, aborted };
}

module.exports = {
  MAX_ATTEMPTS, MAX_BUDGET_USD, MAX_ESTIMATED_INPUT_TOKENS, TIMEOUT_MS,
  caseOrder, estimateTokens, parseResponse, projectedCost, runFixtureEvaluation,
};
