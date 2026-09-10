'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runFixtureEvaluation } = require('../runner');

function responseFor(provider, answer = 'fixture answer') {
  if (provider === 'openai') {
    return { status: 200, latencyMs: 12, json: { output_text: answer, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 20 }, output_tokens: 15, output_tokens_details: { reasoning_tokens: 4 } } } };
  }
  return { status: 200, latencyMs: 15, json: { choices: [{ message: { content: answer } }], usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80, completion_tokens: 15, completion_tokens_details: { reasoning_tokens: 4 } } } };
}

test('runner alternates AB/BA, records hashes/config/usage/latency/status, and has no network mode', async () => {
  const called = [];
  const result = await runFixtureEvaluation({
    mode: 'fixture', persona: '喜寶 persona',
    cases: [{ caseId: 'aaaaaaaaaaaaaaaa', question: '第一題？' }, { caseId: 'bbbbbbbbbbbbbbbb', question: '第二題？' }],
    invokeFixture: async (request) => { called.push(request.provider); return responseFor(request.provider); },
  });
  assert.deepEqual(called, ['openai', 'deepseek', 'deepseek', 'openai']);
  assert.deepEqual(result.completedPairs.map((pair) => pair.mapping), [
    { A: 'openai', B: 'deepseek' }, { A: 'deepseek', B: 'openai' },
  ]);
  assert.equal(result.attempts.length, 4);
  assert.ok(result.attempts.every((attempt) => attempt.status === 200 && attempt.configId && attempt.personaHash && attempt.questionHash));
  assert.deepEqual(result.attempts[0].usage, { uncachedInputTokens: 80, cachedInputTokens: 20, cacheWriteTokens: 0, outputTokens: 15, reasoningTokens: 4 });
  await assert.rejects(() => runFixtureEvaluation({ mode: 'network', persona: 'p', cases: [{ caseId: 'a', question: 'q' }] }), /fixture mode only/);
});

for (const [name, badResponse, expected] of [
  ['non-200', { status: 429, json: {} }, 'non-200'],
  ['redirect', { status: 302, redirected: true, json: {} }, 'redirect'],
  ['invalid JSON', { status: 200, json: null }, 'invalid JSON response'],
  ['missing answer', { status: 200, json: { usage: {} } }, 'missing answer'],
  ['malformed usage', { status: 200, json: { output_text: 'a', usage: { input_tokens: 'x', output_tokens: 1 } } }, 'malformed usage'],
]) {
  test(`runner aborts remaining attempts on ${name} without retry or fallback`, async () => {
    let calls = 0;
    const result = await runFixtureEvaluation({
      mode: 'fixture', persona: 'p',
      cases: [{ caseId: 'aaaaaaaaaaaaaaaa', question: '問題一' }, { caseId: 'bbbbbbbbbbbbbbbb', question: '問題二' }],
      invokeFixture: async () => { calls += 1; return badResponse; },
    });
    assert.equal(calls, 1);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.attempts[0].error, expected);
    assert.equal(result.attempts[0].cost, null);
    assert.equal(result.completedPairs.length, 0);
    assert.equal(result.aborted.reason, expected);
  });
}

test('runner keeps partial successful costs but excludes incomplete pair quality', async () => {
  let calls = 0;
  const result = await runFixtureEvaluation({
    mode: 'fixture', persona: 'p', cases: [{ caseId: 'aaaaaaaaaaaaaaaa', question: '問題一' }],
    invokeFixture: async (request) => { calls += 1; return calls === 1 ? responseFor(request.provider) : { status: 500, json: {} }; },
  });
  assert.equal(result.attempts.length, 2);
  assert.ok(result.attempts[0].cost.totalUsd > 0);
  assert.equal(result.attempts[1].cost, null);
  assert.equal(result.completedPairs.length, 0);
  assert.equal(result.aborted.reason, 'non-200');
});

test('runner enforces case count and stops before invocation for input limit', async () => {
  await assert.rejects(() => runFixtureEvaluation({ mode: 'fixture', persona: 'p', cases: Array.from({ length: 21 }), invokeFixture: async () => ({}) }), /1-20/);
  let called = false;
  const result = await runFixtureEvaluation({
    mode: 'fixture', persona: 'x'.repeat(18_100), cases: [{ caseId: 'aaaaaaaaaaaaaaaa', question: '問題' }],
    invokeFixture: async () => { called = true; return responseFor('openai'); },
  });
  assert.equal(called, false);
  assert.equal(result.aborted.reason, 'estimated-input-limit');
  assert.equal(result.aborted.beforeCall, true);
});
