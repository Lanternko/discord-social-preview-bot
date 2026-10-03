const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { requestTranslation, protectTokens } = require('../src/ai/translation');
const { isForeignPost, addTranslationButton, renderPrivateCard, handleTranslationInteraction } = require('../src/translation-preview');

async function main() {
  assert.equal(isForeignPost({ text: '今天活動開始，記得登入領取獎勵！ #BlueArchive https://example.com' }), false);
  assert.equal(isForeignPost({ text: 'Release' }), false);
  assert.equal(isForeignPost({ text: 'https://example.com #ブルアカ @BlueArchive' }), false);
  assert.equal(isForeignPost({ text: '受付期間：2026/10/3（土）20:00〜10/12（月・祝）23:59', language: 'ja' }), true);
  assert.equal(isForeignPost({ text: 'The update does not reset your progress.' }), true);
  assert.equal(isForeignPost({ text: '이벤트 보상은 내일까지 수령할 수 있습니다.' }), true);
  assert.equal(isForeignPost({ text: '今天有更新，Please log in to claim your rewards!' }), true);
  const tokens = protectTokens('Hello @BlueArchive #ブルアカ https://example.com');
  assert.equal(tokens.restore(tokens.masked), 'Hello @BlueArchive #ブルアカ https://example.com');
  assert.throws(() => tokens.restore('no tokens'), /protected token/);
  const opts = { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'test-key' };
  let body;
  const result = await requestTranslation('Hello #BlueArchive', { ...opts, fetch: async (_, init) => {
    body = JSON.parse(init.body);
    const post = JSON.parse(body.messages[1].content).post;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: post.replace('Hello', '你好') } }] }) };
  } });
  assert.equal(result.text, '你好 #BlueArchive');
  assert.equal(body.thinking.type, 'disabled');
  assert.equal(body.messages.length, 2); // No persona, conversation or tools.
  await requestTranslation('Hello', { provider: 'openai', model: 'gpt-6-luna', apiKey: 'test-key', fetch: async (_, init) => {
    const lunaBody = JSON.parse(init.body);
    assert.equal(lunaBody.reasoning_effort, 'none');
    assert.equal(lunaBody.temperature, undefined);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '你好' } }] }) };
  } });
  await assert.rejects(requestTranslation('Hello', { ...opts, fetch: async () => ({ ok: false, status: 429 }) }), /HTTP 429/);
  process.env.AI_GATEWAY_API_KEY = 'gateway-test-key';
  process.env.OPENAI_API_KEY = 'openai-test-key';
  for (const model of ['alibaba/qwen3.7-flash', 'tencent/hy-mt2-lite']) {
    await requestTranslation('Hello', { provider: 'gateway', model, fetch: async (url, init) => {
      assert.equal(url, 'https://ai-gateway.vercel.sh/v1/chat/completions');
      assert.equal(init.headers.Authorization, 'Bearer gateway-test-key');
      const gatewayBody = JSON.parse(init.body);
      assert.equal(gatewayBody.max_tokens, 4096);
      assert.equal(gatewayBody.max_completion_tokens, undefined);
      assert.equal(gatewayBody.reasoning_effort, model.startsWith('alibaba/') ? 'none' : undefined);
      return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '你好' } }] }) };
    } });
  }
  await assert.rejects(requestTranslation('Hello', { ...opts, fetch: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'length', message: { content: 'half' } }] }) }) }), /Incomplete/);

  process.env.X_TRANSLATION_ENABLED = 'false';
  const payload = { content: 'https://fxtwitter.com/i/status/123456789', nativeEmbedCheck: { statusId: '123456789' } };
  const meta = { statusId: '123456789', text: 'The update does not reset your progress.', photos: ['https://pbs.twimg.com/media/example.jpg'], sensitive: false };
  assert.equal(addTranslationButton(payload, meta), payload);
  process.env.X_TRANSLATION_ENABLED = 'true';
  process.env.TRANSLATION_PROVIDER = 'deepseek';
  process.env.DEEPSEEK_API_KEY = 'test-key';
  const outgoing = addTranslationButton(payload, meta);
  assert.equal(outgoing.nativeEmbedCheck, null);
  assert.equal(outgoing.components[0].toJSON().components[0].custom_id, 'xtranslate:translate:123456789');
  const sourceBefore = JSON.stringify(payload);
  let calls = 0;
  const deps = { fetchTweetMeta: async () => meta, requestTranslation: async () => { calls++; return { text: '更新不會重置你的進度。' }; } };
  const client = { user: { id: 'bot' } };
  function interaction(user, action = 'translate', privateMessage = false) {
    const events = [];
    return { events, user: { id: user }, isButton: () => true, customId: `xtranslate:${action}:123456789`,
      message: { author: { id: 'bot' }, flags: { has: flag => flag === MessageFlags.Ephemeral && privateMessage },
        edit: () => { throw new Error('Public message edited!'); }, delete: () => { throw new Error('Public message deleted!'); } },
      deferReply: async data => events.push(['deferReply', data]), deferUpdate: async () => events.push(['deferUpdate']),
      editReply: async data => events.push(['editReply', data]), reply: async data => events.push(['reply', data]),
    };
  }
  for (const user of ['alice', 'bob']) {
    const i = interaction(user);
    assert.equal(await handleTranslationInteraction(i, client, deps), true);
    assert.equal(i.events[0][0], 'deferReply');
    assert.equal(i.events[0][1].flags, MessageFlags.Ephemeral);
    assert.equal(i.events[1][1].embeds[0].toJSON().description, '更新不會重置你的進度。');
    assert.equal(i.events[1][1].components[0].toJSON().components[0].label, '查看原文');
  }
  assert.equal(calls, 1); // Shared result cache; display stays private per user.
  assert.equal(JSON.stringify(payload), sourceBefore);
  const original = interaction('alice', 'original', true);
  await handleTranslationInteraction(original, client, deps);
  assert.equal(original.events[0][0], 'deferUpdate');
  assert.equal(original.events[1][1].embeds[0].toJSON().description, meta.text);
  assert.equal(calls, 1);
  const translatedAgain = interaction('alice', 'translate', true);
  await handleTranslationInteraction(translatedAgain, client, deps);
  assert.equal(translatedAgain.events[1][1].embeds[0].toJSON().description, '更新不會重置你的進度。');
  assert.equal(calls, 1);
  const forged = interaction('charlie', 'original');
  await handleTranslationInteraction(forged, client, deps);
  assert.equal(forged.events[0][0], 'reply');
  assert.equal(forged.events[0][1].flags, MessageFlags.Ephemeral);
  const failed = interaction('david');
  await handleTranslationInteraction(failed, client, { fetchTweetMeta: async () => null });
  assert.equal(failed.events[1][1].components.length, 0);
  assert.equal(renderPrivateCard({ ...meta, sensitive: true }, '敏感內容', true).embeds[0].toJSON().image, undefined);
  console.log('Translation smoke passed: language gating, token preservation, errors, private replies, two-user isolation, cache, original toggle, sensitive media.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
