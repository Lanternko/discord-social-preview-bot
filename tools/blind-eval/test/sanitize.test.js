'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCases, hasResidualIdentifier, sanitizeQuestion } = require('../sanitize');

test('extractor selects recent unique user messages only for exact guild and never copies raw source', () => {
  const guildId = '123456789012345678';
  const rawSecret = 'alice@example.com';
  const result = extractCases([
    { id: '100000000000000001', guildId, role: 'user', content: `小明可以寄信到 ${rawSecret}，再問 <@111111111111111111> 明天要做什麼嗎？`, displayNames: ['小明'], createdAt: '2026-08-13T10:00:00Z' },
    { id: '100000000000000002', guildId, role: 'assistant', content: '不該選我', createdAt: '2026-08-13T11:00:00Z' },
    { id: '100000000000000003', guildId: '123456789012345679', role: 'user', content: '其他 guild 不該出現', createdAt: '2026-08-13T12:00:00Z' },
    { id: '100000000000000004', guildId, role: 'user', content: '這是一個可以獨立回答的新問題嗎？', createdAt: '2026-08-13T13:00:00Z' },
    { id: '100000000000000005', guildId, role: 'user', content: '這是一個可以獨立回答的新問題嗎？', createdAt: '2026-08-13T14:00:00Z' },
  ], { guildId, caseSalt: 'fixture-only-salt' });
  assert.equal(result.publicCases.length, 2);
  assert.equal(result.publicCases[0].question, '這是一個可以獨立回答的新問題嗎？');
  assert.match(result.publicCases[1].question, /電子郵件已移除/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(rawSecret));
  assert.doesNotMatch(JSON.stringify(result.privateMapping), /10000000000000000/);
  assert.equal(hasResidualIdentifier(result.publicCases[1].question, ['小明']), false);
});

test('sanitizer rejects commands, URL-dominant, long, sensitive, secret and non-substantive content', () => {
  assert.equal(sanitizeQuestion('/ban user').reason, 'command');
  assert.equal(sanitizeQuestion('https://example.com/' + 'x'.repeat(80)).reason, 'url-dominant');
  assert.equal(sanitizeQuestion('a'.repeat(1001)).reason, 'too-long');
  assert.equal(sanitizeQuestion('我的信用卡資料該放哪裡？').reason, 'sensitive-content');
  assert.equal(sanitizeQuestion('api_key=supersecretvalue').reason, 'sensitive-secret');
  assert.equal(sanitizeQuestion('<@123456789012345678>').reason, 'not-substantive');
});

test('seeded PII is removed before an accepted case can reach outbound-facing code', () => {
  const result = sanitizeQuestion('請聯絡 +886 912-345-678 或 bob@example.org，網址 https://example.org/a，謝謝');
  assert.equal(result.accepted, true);
  assert.doesNotMatch(result.question, /912|bob|example\.org/);
  assert.match(result.question, /電話已移除|電子郵件已移除|網址已移除/);
});

test('AWS access-key-shaped credentials produce zero public or outbound cases', () => {
  const guildId = '123456789012345678';
  for (const credential of ['AKIAIOSFODNN7EXAMPLE', 'ASIAIOSFODNN7EXAMPLE', 'A3TABCDEFGHIJKLMN123']) {
    const result = extractCases([{
      id: '100000000000000001', guildId, role: 'user',
      content: `請幫我檢查這組 credential 是否可用：${credential}`,
      createdAt: '2026-08-13T10:00:00Z',
    }], { guildId, caseSalt: 'aws-regression-salt' });
    assert.deepEqual(result.publicCases, []);
    assert.deepEqual(result.privateMapping, []);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reason, 'sensitive-secret');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(credential));
  }
});

test('common assigned tokens and private keys are rejected without matching ordinary password prose', () => {
  assert.equal(sanitizeQuestion('"password": "correct-horse-battery"').reason, 'sensitive-secret');
  assert.equal(sanitizeQuestion('access_token=abcdefghijklmnop123456').reason, 'sensitive-secret');
  assert.equal(sanitizeQuestion('-----BEGIN PRIVATE KEY-----\nfixture').reason, 'sensitive-secret');
  assert.equal(sanitizeQuestion('password: should be at least eight characters，這個規則合理嗎？').accepted, true);
  assert.equal(sanitizeQuestion('密碼應該至少八個字元，請問怎麼設定？').accepted, true);
});
