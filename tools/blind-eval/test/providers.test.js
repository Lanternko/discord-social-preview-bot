'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CONFIGS, assertByteIdentical, buildRequest, validateRequest } = require('../providers');

test('provider tuples are exact, allowlisted, tool-free, and byte-identical', () => {
  const persona = '你是喜寶。';
  const question = '今天適合吃什麼？';
  const openai = validateRequest(buildRequest('openai', persona, question));
  const deepseek = validateRequest(buildRequest('deepseek', persona, question));
  assert.equal(openai.url, 'https://api.openai.com/v1/responses');
  assert.deepEqual(openai.body, { model: 'gpt-5.6-luna', store: false, reasoning: { effort: 'low' }, tools: [], max_output_tokens: 500, input: [{ role: 'system', content: persona }, { role: 'user', content: question }] });
  assert.equal(deepseek.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(deepseek.body.model, 'deepseek-flash');
  assert.equal(deepseek.body.max_tokens, 2548);
  assertByteIdentical(openai, deepseek);
  assert.deepEqual(CONFIGS.openai, CONFIGS.openai);
});

test('aliases, tuple changes, redirects, fallback providers and input drift are rejected', () => {
  assert.throws(() => buildRequest('gpt', 'p', 'q'), /not allowlisted/);
  const altered = { ...buildRequest('openai', 'p', 'q'), url: 'https://example.test', body: { ...buildRequest('openai', 'p', 'q').body } };
  assert.throws(() => validateRequest(altered), /tuple mismatch/);
  altered.url = CONFIGS.openai.url;
  altered.redirect = 'follow';
  assert.throws(() => validateRequest(altered), /tuple mismatch/);
  assert.throws(() => assertByteIdentical(buildRequest('openai', 'p', 'q'), buildRequest('deepseek', 'p', 'different')), /not byte-identical/);
});
