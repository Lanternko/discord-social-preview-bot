'use strict';

const { createHash } = require('node:crypto');

const CONFIGS = Object.freeze({
  openai: Object.freeze({
    configId: 'openai-responses-gpt-5.6-luna-v1',
    method: 'POST',
    url: 'https://api.openai.com/v1/responses',
    redirect: 'error',
    model: 'gpt-5.6-luna',
    maxOutputTokens: 500,
  }),
  // 2026-09-10: the compared arm is V4.1 Flash (served under the `deepseek-flash`
  // id), not V4 Pro. From 2026-09-14 DeepSeek routes `deepseek-v4-pro` to this
  // same model anyway, so pinning the pro id would have measured a name, not a
  // model. Approved for this run alongside the pricing bump below.
  deepseek: Object.freeze({
    configId: 'deepseek-chat-deepseek-flash-v1',
    method: 'POST',
    url: 'https://api.deepseek.com/chat/completions',
    redirect: 'error',
    model: 'deepseek-flash',
    maxTokens: 2548,
  }),
});

function hashText(value) {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

function assertInputs(persona, question) {
  if (typeof persona !== 'string' || !persona) throw new Error('persona must be non-empty UTF-8 text');
  if (typeof question !== 'string' || !question) throw new Error('question must be non-empty UTF-8 text');
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value || {}).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} fields mismatch`);
  }
}

function assertMessages(messages, personaBytes, questionBytes) {
  if (!Array.isArray(messages) || messages.length !== 2) throw new Error('provider messages mismatch');
  if (messages[0]?.role !== 'system' || messages[1]?.role !== 'user' ||
      typeof messages[0]?.content !== 'string' || typeof messages[1]?.content !== 'string') {
    throw new Error('provider messages mismatch');
  }
  if (!Buffer.from(messages[0].content, 'utf8').equals(Buffer.from(personaBytes)) ||
      !Buffer.from(messages[1].content, 'utf8').equals(Buffer.from(questionBytes))) {
    throw new Error('provider body/input bytes mismatch');
  }
}

function buildRequest(provider, persona, question) {
  assertInputs(persona, question);
  if (provider === 'openai') {
    const config = CONFIGS.openai;
    return Object.freeze({
      provider,
      configId: config.configId,
      method: config.method,
      url: config.url,
      redirect: config.redirect,
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: Object.freeze({
        model: config.model,
        store: false,
        reasoning: Object.freeze({ effort: 'low' }),
        tools: Object.freeze([]),
        max_output_tokens: config.maxOutputTokens,
        input: Object.freeze([
          Object.freeze({ role: 'system', content: persona }),
          Object.freeze({ role: 'user', content: question }),
        ]),
      }),
      personaBytes: Buffer.from(persona, 'utf8'),
      questionBytes: Buffer.from(question, 'utf8'),
      personaHash: hashText(persona),
      questionHash: hashText(question),
    });
  }
  if (provider === 'deepseek') {
    const config = CONFIGS.deepseek;
    return Object.freeze({
      provider,
      configId: config.configId,
      method: config.method,
      url: config.url,
      redirect: config.redirect,
      headers: Object.freeze({ 'content-type': 'application/json' }),
      body: Object.freeze({
        model: config.model,
        temperature: 0.9,
        top_p: 0.95,
        max_tokens: config.maxTokens,
        tools: Object.freeze([]),
        messages: Object.freeze([
          Object.freeze({ role: 'system', content: persona }),
          Object.freeze({ role: 'user', content: question }),
        ]),
      }),
      personaBytes: Buffer.from(persona, 'utf8'),
      questionBytes: Buffer.from(question, 'utf8'),
      personaHash: hashText(persona),
      questionHash: hashText(question),
    });
  }
  throw new Error(`provider is not allowlisted: ${provider}`);
}

function validateRequest(request) {
  const expected = CONFIGS[request && request.provider];
  if (!expected) throw new Error('provider is not allowlisted');
  assertExactKeys(request, ['provider', 'configId', 'method', 'url', 'redirect', 'headers', 'body', 'personaBytes', 'questionBytes', 'personaHash', 'questionHash'], 'request');
  if (request.method !== 'POST' || request.url !== expected.url || request.redirect !== 'error') {
    throw new Error('request tuple mismatch; aliases, redirects, and fallbacks are forbidden');
  }
  if (request.configId !== expected.configId || request.body.model !== expected.model) throw new Error('provider config mismatch');
  assertExactKeys(request.headers, ['content-type'], 'request headers');
  if (request.headers['content-type'] !== 'application/json') throw new Error('content type mismatch');
  if (!Array.isArray(request.body.tools) || request.body.tools.length !== 0) throw new Error('tools must remain disabled');
  if (request.provider === 'openai') {
    assertExactKeys(request.body, ['model', 'store', 'reasoning', 'tools', 'max_output_tokens', 'input'], 'OpenAI body');
    if (request.body.store !== false || request.body.reasoning?.effort !== 'low') throw new Error('OpenAI privacy/reasoning config mismatch');
    assertExactKeys(request.body.reasoning, ['effort'], 'OpenAI reasoning');
    if (!Number.isInteger(request.body.max_output_tokens) || request.body.max_output_tokens > 500) throw new Error('OpenAI output limit mismatch');
    assertMessages(request.body.input, request.personaBytes, request.questionBytes);
  } else {
    assertExactKeys(request.body, ['model', 'temperature', 'top_p', 'max_tokens', 'tools', 'messages'], 'DeepSeek body');
    if (request.body.temperature !== 0.9 || request.body.top_p !== 0.95) throw new Error('DeepSeek sampling config mismatch');
    if (!Number.isInteger(request.body.max_tokens) || request.body.max_tokens > 2548) throw new Error('DeepSeek output limit mismatch');
    assertMessages(request.body.messages, request.personaBytes, request.questionBytes);
  }
  if (request.personaHash !== hashText(Buffer.from(request.personaBytes).toString('utf8')) ||
      request.questionHash !== hashText(Buffer.from(request.questionBytes).toString('utf8'))) throw new Error('input hash mismatch');
  return request;
}

function assertByteIdentical(a, b) {
  if (!Buffer.from(a.personaBytes).equals(Buffer.from(b.personaBytes)) ||
      !Buffer.from(a.questionBytes).equals(Buffer.from(b.questionBytes))) {
    throw new Error('provider inputs are not byte-identical');
  }
}

module.exports = { CONFIGS, assertByteIdentical, buildRequest, hashText, validateRequest };
