const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { createHash } = require('node:crypto');
const { fetchTweetMeta } = require('./platforms/twitter');
const { requestTranslationWithRetry, PROMPT_VERSION } = require('./ai/translation');
const { translationAvailable, reserveTranslation } = require('./ai/translation-policy');
const { trimDescription } = require('./utils');

const cache = new Map();
const cooldowns = new Map();
let active = 0;
const PREFIX = 'xtranslate:';

function isForeignPost(meta) {
  const text = (meta?.text || '').replace(/https?:\/\/\S+|@[A-Za-z0-9_]+|#[\p{L}\p{N}_]+/gu, '');
  const letters = text.match(/\p{L}/gu) || [];
  // Short Japanese/Korean sentences still carry meaning without API language
  // metadata. Keep one-name captions (e.g. アロナ) below the four-letter floor.
  if (letters.length >= 4 && /[\u3040-\u30ff\uac00-\ud7af]/u.test(text)) return true;
  if (/^(ja|ko)\b/i.test(meta?.language || '') && letters.length >= 4) return true;
  // A meaningful English clause can need translation even when Chinese prose
  // dominates or X labels the whole mixed post zh. Short borrowed terms do not.
  const clauses = text.match(/[A-Za-z]+(?:[’'-][A-Za-z]+)*(?:[ \t]+[A-Za-z]+(?:[’'-][A-Za-z]+)*){3,}/g) || [];
  if (clauses.some(clause => (clause.match(/[A-Za-z]/g) || []).length >= 20)) return true;
  if (letters.length < 8) return false;
  if (/[\u3040-\u30ff\uac00-\ud7af]/u.test(text)) return true;
  if (/^zh\b/i.test(meta?.language || '')) return false;
  const foreign = letters.filter(c => !/\p{Script=Han}/u.test(c)).length;
  return foreign / letters.length >= .6;
}

function enabled() {
  return translationAvailable();
}

const LABELS = { translate: '翻譯成繁體中文', original: '查看原文', busy: '⏳ 翻譯中…' };

// `busy` is the locked placeholder shown while the model runs; disabled, so
// its id never reaches the handler.
function buttons(id, action = 'translate') {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`${PREFIX}${action}:${id}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(LABELS[action])
    .setDisabled(action === 'busy'))];
}

// The native-embed check stays on: when Discord's own card shows up, the bot
// posts no preview (a second copy of the image whenever it can't suppress the
// original), only a button-only stub — see buildTranslationStub. A foreign
// post also carries `selfCard`, the bot's own card, which preferSelfCards
// swaps in when the bot CAN suppress the native card.
function addTranslationButton(payload, meta, selfCard = null) {
  if (!enabled() || !isForeignPost(meta)) return payload;
  const components = buttons(meta.statusId);
  const deferred = payload.nativeEmbedCheck ? {
    translationStub: { statusId: meta.statusId },
    ...(selfCard ? { selfCard: { ...selfCard, components } } : {}),
  } : {};
  return { ...payload, components, ...deferred };
}

// With ManageMessages the native card can be suppressed, so a foreign post
// goes out as the bot's own card: one message, translated in place. Without
// it the native card stays and the stub carries the button.
function preferSelfCards(payloads, canSuppress) {
  return payloads.map((payload) => {
    if (!payload?.selfCard) return payload;
    const { selfCard, ...rest } = payload;
    return canSuppress ? selfCard : rest;
  });
}

// Reply that carries the translate button under Discord's own card. No link
// and no embed, so it can't duplicate the post; the reply reference already
// points at the post and the button says what it does, so the text is only
// the minimum a non-V2 message needs. Clicking quotes the translation into it
// through the same renderInPlace link path.
function buildTranslationStub({ statusId }) {
  return { content: '-# 🌐', components: buttons(statusId), allowedMentions: { parse: [], repliedUser: false } };
}

async function sendTranslationStubs(message, payloads) {
  for (const payload of payloads) {
    if (!payload?.translationStub) continue;
    try {
      await message.reply(buildTranslationStub(payload.translationStub));
      console.log(`[translate] native card kept, stub sent status=${payload.translationStub.statusId}`);
    } catch (error) {
      console.warn(`[translate] stub send failed status=${payload.translationStub.statusId}: ${error.message}`);
    }
  }
}

// The translation goes INTO the public preview — no extra message, private or
// not. A bot-built X card (gallery / spoilered) gets its post text swapped; a
// fixer link card can't be rewritten (Discord owns the unfurl), so the
// translation rides below the link as a quote. Both are reversible by the
// 查看原文 button, which restores the post text without another model call.
const LINK_MARK = '\n-# 繁體中文翻譯\n';
const CARD_MARK = ' · 繁體中文翻譯';
const CONTENT_LIMIT = 2000;

function isBotCard(message, statusId) {
  const lead = message.embeds?.[0];
  return !/https?:\/\//.test(message.content || '')
    && Boolean(lead?.footer?.text?.startsWith('X (Twitter)'))
    && Boolean(lead.url?.includes(statusId));
}

function quote(text, budget) {
  const quoted = text.trim().split('\n').map(line => `> ${line}`).join('\n');
  if (quoted.length <= budget) return quoted;
  const tail = '\n> …（太長了，完整內容請開原文）';
  return quoted.slice(0, Math.max(0, budget - tail.length)) + tail;
}

function renderInPlace(message, meta, text, translated) {
  const components = buttons(meta.statusId, translated ? 'original' : 'translate');
  if (isBotCard(message, meta.statusId)) {
    const [lead, ...rest] = message.embeds;
    const footer = lead.footer.text.split(CARD_MARK)[0];
    const embed = EmbedBuilder.from(lead)
      .setDescription(trimDescription(text, translated ? 4000 : 1024))
      .setFooter({ text: translated ? footer + CARD_MARK : footer, iconURL: lead.footer.iconURL || undefined });
    return { embeds: [embed, ...rest], components, allowedMentions: { parse: [] } };
  }
  const base = (message.content || '').split(LINK_MARK)[0];
  const content = translated ? base + LINK_MARK + quote(text, CONTENT_LIMIT - base.length - LINK_MARK.length) : base;
  return { content, components, allowedMentions: { parse: [] } };
}

async function translateCached(text, deps, userId, guildId) {
  const policy = [process.env.TRANSLATION_PROVIDER || 'auto', process.env.TRANSLATION_MODEL || '', process.env.TRANSLATION_DEEPSEEK_OFFPEAK_ENABLED || 'false'].join('|');
  // Keep caches within a guild: an exhausted guild cannot borrow a premium
  // call from another guild. Reusing its own completed result is free, even if
  // its quota or the peak window changed after the original API call.
  const key = createHash('sha256').update(`${guildId}|${policy}|${PROMPT_VERSION}|${text}`).digest('hex');
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  if (cache.has(key)) return cache.get(key).promise;
  if (now - (cooldowns.get(userId) || 0) < 5000) throw new Error('Translation cooldown');
  if (active >= 4) throw new Error('Translation busy');
  if (cooldowns.size >= 1000) cooldowns.delete(cooldowns.keys().next().value);
  const route = (deps.reserveTranslation || reserveTranslation)(guildId);
  cooldowns.set(userId, now);
  if (cache.size >= 200) cache.delete(cache.keys().next().value);
  active++;
  const promise = Promise.resolve().then(() => (deps.requestTranslation || requestTranslationWithRetry)(text, route));
  cache.set(key, { promise, expires: now + 10 * 60 * 1000 });
  try { return await promise; }
  catch (error) { cache.delete(key); throw error; }
  finally { active--; }
}

async function handleTranslationInteraction(interaction, client, deps = {}) {
  if (!interaction.isButton?.() || !interaction.customId?.startsWith(PREFIX)) return false;
  const match = /^xtranslate:(translate|original):(\d{5,25})$/.exec(interaction.customId);
  // Ephemeral cards are the retired private-card design; their buttons are dead.
  const privateMessage = Boolean(interaction.message?.flags?.has(MessageFlags.Ephemeral));
  if (!match || !enabled() || interaction.message?.author?.id !== client.user.id || privateMessage) {
    await interaction.reply({ content: '這個翻譯按鈕目前無法使用。', flags: MessageFlags.Ephemeral });
    return true;
  }
  const translated = match[1] === 'translate';
  // A translation takes seconds and deferUpdate shows nothing, so the button
  // itself turns into a locked 翻譯中… right away (also stops double clicks).
  // 查看原文 needs no model call and stays a plain ack.
  if (translated) await interaction.update({ components: buttons(match[2], 'busy') });
  else await interaction.deferUpdate();
  try {
    const meta = await (deps.fetchTweetMeta || fetchTweetMeta)(`https://x.com/i/status/${match[2]}`);
    if (!meta?.text || meta.text.length > 12000) throw new Error('Post unavailable');
    const result = translated ? await translateCached(meta.text, deps, interaction.user.id, interaction.guildId) : { text: meta.text };
    await interaction.editReply(renderInPlace(interaction.message, meta, result.text, translated));
  } catch {
    // Only the failure is private: the public preview goes back to how it was.
    if (translated) await interaction.editReply({ components: buttons(match[2]) }).catch(() => {});
    await interaction.followUp({ content: '目前無法翻譯，請稍後再試或開啟原文。', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  return true;
}

module.exports = { isForeignPost, addTranslationButton, preferSelfCards, buildTranslationStub, sendTranslationStubs, renderInPlace, handleTranslationInteraction };
