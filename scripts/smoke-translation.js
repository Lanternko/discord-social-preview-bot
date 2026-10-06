const assert = require('node:assert/strict');
const { MessageFlags } = require('discord.js');
const { requestTranslation, requestTranslationWithRetry, protectTokens, normalizeTranslationOutput } = require('../src/ai/translation');
const { selectTranslationRoute, reserveTranslation, translationUsageKey } = require('../src/ai/translation-policy');
const { isForeignPost, addTranslationButton, preferSelfCards, buildTranslationStub, sendTranslationStubs, renderInPlace, handleTranslationInteraction } = require('../src/translation-preview');

async function main() {
  assert.equal(isForeignPost({ text: '今天活動開始，記得登入領取獎勵！ #BlueArchive https://example.com' }), false);
  assert.equal(isForeignPost({ text: 'Release' }), false);
  assert.equal(isForeignPost({ text: 'https://example.com #ブルアカ @BlueArchive' }), false);
  assert.equal(isForeignPost({ text: '受付期間：2026/10/3（土）20:00〜10/12（月・祝）23:59', language: 'ja' }), true);
  assert.equal(isForeignPost({ text: 'The update does not reset your progress.' }), true);
  assert.equal(isForeignPost({ text: '이벤트 보상은 내일까지 수령할 수 있습니다.' }), true);
  assert.equal(isForeignPost({ text: '今天有更新，Please log in to claim your rewards!' }), true);
  assert.equal(isForeignPost({ text: 'お渡しするよー！' }), true);
  assert.equal(isForeignPost({ text: 'アロナ #ブルアカ' }), false);
  assert.equal(isForeignPost({ text: '不要漏看公告，以下是需要留意的退款條件：Tickets are not refundable after purchase.', language: 'zh' }), true);
  assert.equal(isForeignPost({ text: '今天研究 AI agents 和 System prompt，有趣。', language: 'zh' }), false);
  const tokens = protectTokens('Hello @BlueArchive #ブルアカ https://example.com');
  assert.equal(tokens.restore(tokens.masked), 'Hello @BlueArchive #ブルアカ https://example.com');
  assert.throws(() => tokens.restore('no tokens'), /protected token/);
  const adjacent = protectTokens('@Blue_ArchiveJPをフォロー #ブルアカ');
  assert.ok(adjacent.masked.includes('をフォロー'));
  assert.equal(adjacent.restore(adjacent.masked.replace('をフォロー', '追蹤')), '@Blue_ArchiveJP追蹤 #ブルアカ');
  assert.equal(isForeignPost({ text: '@Blue_ArchiveJPをフォロー', language: 'ja' }), true);
  const names = protectTokens('カズサ / Kazusa / 카즈사 と アズサ #ブルアカ');
  assert.equal(names.restore(names.masked), '千紗 / 千紗 / 千紗 と 梓 #ブルアカ');
  const namesOutsideGame = protectTokens('Mine and Ui are names in this unrelated novel.');
  assert.equal(namesOutsideGame.restore(namesOutsideGame.masked), 'Mine and Ui are names in this unrelated novel.');
  const noSubstring = protectTokens('Unique Buildings mine #BlueArchive');
  assert.equal(noSubstring.restore(noSubstring.masked), 'Unique Buildings mine #BlueArchive');
  const unknownName = protectTokens('MyGO!!!!! 要 楽奈 #バンドリ');
  assert.equal(unknownName.restore(unknownName.masked), 'MyGO!!!!! 要 楽奈 #バンドリ');
  const unknownStudent = protectTokens('케이 / ヒカリ #블루아카이브');
  assert.equal(unknownStudent.restore(unknownStudent.masked), '케이 / ヒカリ #블루아카이브');
  assert.equal(normalizeTranslationOutput('早安\\n再見', 'Hello\nBye'), '早安\n再見');
  assert.equal(normalizeTranslationOutput('程式中的\\n', 'Code uses \\n literally'), '程式中的\\n');
  const env = { TRANSLATION_PROVIDER: 'auto', OPENAI_API_KEY: 'test', DEEPSEEK_API_KEY: 'test', AI_GATEWAY_API_KEY: 'test' };
  const peak = new Date('2026-10-08T01:00:00Z');
  assert.equal(selectTranslationRoute({ env, now: peak }).provider, 'openai');
  assert.equal(selectTranslationRoute({ env, now: new Date('2026-10-10T02:00:00Z') }).provider, 'openai');
  const timed = { ...env, TRANSLATION_DEEPSEEK_OFFPEAK_ENABLED: 'true' };
  for (const [time, provider] of [['2026-10-08T00:59:59Z', 'deepseek'], ['2026-10-08T01:00:00Z', 'openai'], ['2026-10-08T03:59:59Z', 'openai'], ['2026-10-08T04:00:00Z', 'deepseek'], ['2026-10-08T06:00:00Z', 'openai'], ['2026-10-08T10:00:00Z', 'deepseek'], ['2026-10-10T02:00:00Z', 'deepseek']]) assert.equal(selectTranslationRoute({ env: timed, now: new Date(time) }).provider, provider);
  assert.equal(selectTranslationRoute({ env: { ...timed, TRANSLATION_DEEPSEEK_OFFPEAK_DATES: '2026-10-05' }, now: new Date('2026-10-05T02:00:00Z') }).provider, 'deepseek');
  assert.equal(selectTranslationRoute({ env: timed, now: peak, exhausted: true }).provider, 'gateway');
  assert.equal(selectTranslationRoute({ env: { ...env, TRANSLATION_PROVIDER: 'deepseek' }, exhausted: true }).provider, 'gateway');
  const { OWNER_TOTAL_KEY, todayString } = require('../src/ai/rate-limiter');
  const usage = new Map();
  const fakeMeter = {
    getUsage(id, now) { const entry = usage.get(id); return { count: entry?.date === todayString(now) ? entry.count : 0 }; },
    checkAndIncrement(id, limit, now) { const count = this.getUsage(id, now).count; if (limit > 0 && count >= limit) return { allowed: false }; usage.set(id, { count: count + 1, date: todayString(now) }); return { allowed: true }; },
    checkAndIncrementOwnerTotal(limit, now) { return this.checkAndIncrement(OWNER_TOTAL_KEY, limit, now); },
  };
  const policyDeps = { env, meter: fakeMeter, ownerLimit: 100, now: Date.parse('2026-10-08T15:59:59Z') };
  // Exhausted chat does not consume the independent five translation slots.
  fakeMeter.checkAndIncrement('guild-a', 1, policyDeps.now);
  for (let i = 0; i < 5; i++) assert.equal(reserveTranslation('guild-a', policyDeps).model, 'gpt-6-luna');
  assert.equal(reserveTranslation('guild-a', policyDeps).model, 'alibaba/qwen3.7-flash');
  assert.equal(reserveTranslation('guild-a', { ...policyDeps, whitelist: ['guild-a'] }).provider, 'gateway');
  assert.equal(fakeMeter.getUsage(translationUsageKey('guild-a'), policyDeps.now).count, 5);
  assert.equal(fakeMeter.getUsage('guild-a', policyDeps.now).count, 1);
  assert.equal(reserveTranslation('guild-b', policyDeps).provider, 'openai');
  assert.equal(fakeMeter.getUsage('guild-b', policyDeps.now).count, 0);
  assert.equal(reserveTranslation('guild-a', { ...policyDeps, now: Date.parse('2026-10-08T16:00:00Z') }).provider, 'openai');
  assert.equal(fakeMeter.getUsage(translationUsageKey('guild-a'), Date.parse('2026-10-08T16:00:00Z')).count, 1);
  assert.throws(() => reserveTranslation('guild-c', { ...policyDeps, now: Date.parse('2026-10-08T16:00:00Z'), ownerLimit: 1 }), /owner limit/);
  let retryCalls = 0;
  await requestTranslationWithRetry('text', { provider: 'gateway', model: 'alibaba/qwen3.7-flash', request: async (_, options) => {
    assert.equal(options.provider, 'gateway'); assert.equal(options.model, 'alibaba/qwen3.7-flash');
    retryCalls++;
    if (retryCalls === 1) throw new Error('Translation lost a protected token');
    return { text: '譯文' };
  } });
  assert.equal(retryCalls, 2);
  retryCalls = 0;
  await assert.rejects(requestTranslationWithRetry('text', { request: async () => { retryCalls++; throw new Error('Untranslated post'); } }), /Untranslated/);
  assert.equal(retryCalls, 2);
  retryCalls = 0;
  await assert.rejects(requestTranslationWithRetry('text', { request: async () => { retryCalls++; throw new Error('Translation HTTP 429'); } }), /429/);
  assert.equal(retryCalls, 1);
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
  await assert.rejects(requestTranslation('先生！カズサさんの新しい衣装について、明日のイベントで詳しくお知らせします。 #ブルアカ', { ...opts, fetch: async (_, init) => {
    const source = JSON.parse(JSON.parse(init.body).messages[1].content).post;
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: source } }] }) };
  } }), /Untranslated/);
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
  // Native check survives: if Discord's own card shows, only a stub is sent.
  assert.deepEqual(outgoing.nativeEmbedCheck, { statusId: '123456789' });
  assert.deepEqual(outgoing.translationStub, { statusId: '123456789' });
  assert.equal(outgoing.components[0].toJSON().components[0].custom_id, 'xtranslate:translate:123456789');
  assert.equal(addTranslationButton({ embeds: [] }, meta).translationStub, undefined); // bot-built cards never defer
  // With ManageMessages the bot's own card replaces the native one, button on
  // the card itself; without it the fixer payload goes on unchanged.
  const { buildTwitterCardEmbed } = require('../src/embeds');
  const cardUrl = 'https://x.com/a/status/123456789';
  const withCard = addTranslationButton(payload, meta, { embeds: [buildTwitterCardEmbed(cardUrl, meta)], sourceUrl: cardUrl });
  assert.equal(addTranslationButton(payload, { ...meta, text: '今天天氣很好喔大家' }, { embeds: [] }).selfCard, undefined);
  const [own] = preferSelfCards([withCard], true);
  assert.equal(own.content, undefined);
  assert.equal(own.nativeEmbedCheck, undefined);
  assert.equal(own.components[0].toJSON().components[0].custom_id, 'xtranslate:translate:123456789');
  const ownEmbed = own.embeds[0].toJSON();
  assert.equal(ownEmbed.image.url, meta.photos[0]);
  const ownTranslated = renderInPlace({ content: '', embeds: [ownEmbed] }, meta, '更新不會重置你的進度。', true);
  assert.equal(ownTranslated.content, undefined);
  assert.equal(ownTranslated.embeds[0].toJSON().description, '更新不會重置你的進度。');
  // No permission: the native-card wait still runs on the fixer payload, but
  // the self card is kept for when the native card doesn't show.
  const [kept] = preferSelfCards([withCard], false);
  assert.equal(kept, withCard);
  assert.equal(kept.content, payload.content);
  assert.deepEqual(kept.translationStub, { statusId: '123456789' });
  assert.equal(preferSelfCards([kept], true)[0], withCard.selfCard);
  assert.equal(preferSelfCards([payload], true)[0], payload);
  const stub = buildTranslationStub({ statusId: '123456789' });
  assert.equal(stub.content, '-# 🌐');
  assert.equal(stub.embeds, undefined);
  assert.equal(stub.components[0].toJSON().components[0].custom_id, 'xtranslate:translate:123456789');
  const replies = [];
  await sendTranslationStubs({ reply: async data => replies.push(data) }, [outgoing, payload, null]);
  assert.equal(replies.length, 1);
  const stubLink = renderInPlace({ content: stub.content, embeds: [] }, meta, '更新不會重置你的進度。', true);
  assert.equal(stubLink.content, stub.content + '\n-# 繁體中文翻譯\n> 更新不會重置你的進度。');
  assert.equal(renderInPlace({ content: stubLink.content, embeds: [] }, meta, meta.text, false).content, stub.content);
  const sourceBefore = JSON.stringify(payload);
  let calls = 0;
  let reservations = 0;
  let fetches = 0;
  const deps = { fetchTweetMeta: async () => { fetches++; return meta; }, reserveTranslation: () => { reservations++; return { provider: 'openai', model: 'gpt-6-luna' }; }, requestTranslation: async (_, route) => { assert.equal(route.model, 'gpt-6-luna'); calls++; return { text: '更新不會重置你的進度。' }; } };
  const client = { user: { id: 'bot' } };
  const { EmbedBuilder } = require('discord.js');
  const linkMessage = { content: 'https://fxtwitter.com/i/status/123456789', embeds: [] };
  const cardMessage = { content: '', embeds: [
    new EmbedBuilder().setURL('https://x.com/a/status/123456789').setDescription(meta.text).setFooter({ text: 'X (Twitter)' }).toJSON(),
    new EmbedBuilder().setURL('https://x.com/a/status/123456789').setImage('https://pbs.twimg.com/media/2.jpg').toJSON(),
  ] };
  function interaction(user, action = 'translate', { privateMessage = false, message = linkMessage, statusId = '123456789' } = {}) {
    const events = [];
    return { events, guildId: 'guild-a', user: { id: user }, isButton: () => true, customId: `xtranslate:${action}:${statusId}`,
      message: { ...message, author: { id: 'bot' }, flags: { has: flag => flag === MessageFlags.Ephemeral && privateMessage },
        edit: () => { throw new Error('Edit goes through the interaction'); }, delete: () => { throw new Error('Public message deleted!'); } },
      deferReply: async data => events.push(['deferReply', data]), deferUpdate: async () => events.push(['deferUpdate']), update: async data => events.push(['update', data]),
      editReply: async data => events.push(['editReply', data]), reply: async data => events.push(['reply', data]),
      followUp: async data => events.push(['followUp', data]),
    };
  }
  // Link card: translation is quoted under the link, in the same public message.
  for (const user of ['alice', 'bob']) {
    const i = interaction(user);
    assert.equal(await handleTranslationInteraction(i, client, deps), true);
    assert.deepEqual(i.events.map(e => e[0]), ['update', 'editReply']);
    const busy = i.events[0][1].components[0].toJSON().components[0];
    assert.equal(busy.label, '⏳ 翻譯中…');
    assert.equal(busy.disabled, true);
    assert.equal(i.events[1][1].content, 'https://fxtwitter.com/i/status/123456789\n-# 繁體中文翻譯\n> 更新不會重置你的進度。');
    assert.equal(i.events[1][1].components[0].toJSON().components[0].label, '查看原文');
    assert.equal(i.events[1][1].embeds, undefined); // the unfurl is left alone
  }
  assert.equal(calls, 1); // Shared result cache.
  assert.equal(reservations, 1); // Cached clicks do not spend quota.
  assert.equal(JSON.stringify(payload), sourceBefore);
  const translatedLink = { content: 'https://fxtwitter.com/i/status/123456789\n-# 繁體中文翻譯\n> 更新不會重置你的進度。', embeds: [] };
  const original = interaction('alice', 'original', { message: translatedLink });
  await handleTranslationInteraction(original, client, deps);
  assert.equal(original.events[0][0], 'deferUpdate'); // no model call, no busy state
  assert.equal(original.events[1][1].content, 'https://fxtwitter.com/i/status/123456789');
  assert.equal(original.events[1][1].components[0].toJSON().components[0].label, '翻譯成繁體中文');
  assert.equal(calls, 1);
  // Bot-built card: the post text is swapped, gallery embeds stay, and it toggles back.
  const card = interaction('carol', 'translate', { message: cardMessage });
  await handleTranslationInteraction(card, client, deps);
  const [lead, gallery] = card.events[1][1].embeds.map(e => e.toJSON ? e.toJSON() : e);
  assert.equal(lead.description, '更新不會重置你的進度。');
  assert.equal(lead.footer.text, 'X (Twitter) · 繁體中文翻譯');
  assert.equal(gallery.image.url, 'https://pbs.twimg.com/media/2.jpg');
  assert.equal(card.events[1][1].content, undefined);
  const back = interaction('carol', 'original', { message: { content: '', embeds: [lead, gallery] } });
  await handleTranslationInteraction(back, client, deps);
  assert.equal(back.events[1][1].embeds[0].toJSON().description, meta.text);
  assert.equal(back.events[1][1].embeds[0].toJSON().footer.text, 'X (Twitter)');
  // Long translations are cut to fit Discord's 2000-char message limit.
  const long = renderInPlace(linkMessage, meta, '長'.repeat(3000), true);
  assert.ok(long.content.length <= 2000 && long.content.endsWith('完整內容請開原文）'));
  // Retired ephemeral cards and forged buttons get a private notice only.
  const stale = interaction('charlie', 'original', { privateMessage: true });
  await handleTranslationInteraction(stale, client, deps);
  assert.equal(stale.events[0][0], 'reply');
  assert.equal(stale.events[0][1].flags, MessageFlags.Ephemeral);
  // Failure: public preview untouched, error goes to the clicker privately.
  // Every toggle above reused one fetch of the post (translate, original, card, back).
  assert.equal(fetches, 1);
  const failed = interaction('david', 'translate', { statusId: '987654321' });
  await handleTranslationInteraction(failed, client, { fetchTweetMeta: async () => null });
  assert.deepEqual(failed.events.map(e => e[0]), ['update', 'editReply', 'followUp']);
  assert.equal(failed.events[1][1].components[0].toJSON().components[0].label, '翻譯成繁體中文');
  assert.equal(failed.events[1][1].components[0].toJSON().components[0].disabled, false);
  assert.equal(failed.events[2][1].flags, MessageFlags.Ephemeral);
  const otherGuild = interaction('erin');
  otherGuild.guildId = 'guild-b';
  await handleTranslationInteraction(otherGuild, client, deps);
  assert.equal(calls, 2); // Separate guild cache, no premium quota borrowing.
  assert.equal(reservations, 2);
  console.log('Translation smoke passed: language gating, token preservation, errors, in-place edits (link + card), cache, original toggle, length cap, private failures.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
