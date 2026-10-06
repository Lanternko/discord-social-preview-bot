const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { createHash } = require('node:crypto');
const { fetchTweetMeta } = require('./platforms/twitter');
const { fetchThreadsMetadata } = require('./probe');
const { threadsCardText } = require('./platforms/threads');
const { requestTranslationWithRetry, PROMPT_VERSION } = require('./ai/translation');
const { translationAvailable, reserveTranslation } = require('./ai/translation-policy');
const { trimDescription } = require('./utils');

// Both caches live a day: a big server keeps clicking an old post long after
// the first translation, and every repeat within the day should cost nothing.
// Entries are small (≤12k chars of text), so 500 each stays a few MB; a hit
// moves to the back, so the cap evicts the least recently clicked post.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();
const metaCache = new Map();
const cooldowns = new Map();
let active = 0;

// Each platform the button works on. `id` is what rides in the button's
// custom_id (≤100 chars): X needs only the status id; a Threads post needs the
// author too, since the post URL is /@user/post/<code>. `cardMark` is what the
// bot's own card URL must contain, `cardLimit` the description length the card
// was built with, and `fetch` gets the post's full card text back by id.
const SOURCES = {
  x: {
    prefix: 'xtranslate:',
    id: /^\d{5,25}$/,
    footer: 'X (Twitter)',
    cardMark: id => id,
    cardLimit: 1024,
    async fetch(id, deps) {
      const meta = await (deps.fetchTweetMeta || fetchTweetMeta)(`https://x.com/i/status/${id}`);
      return meta?.text ? { text: meta.text } : null;
    },
  },
  threads: {
    prefix: 'ttranslate:',
    id: /^[A-Za-z0-9._]{1,64}\/[A-Za-z0-9_-]{5,40}$/,
    footer: 'Threads',
    cardMark: id => `/post/${id.split('/')[1]}`,
    cardLimit: 4000,
    async fetch(id, deps) {
      const [user, code] = id.split('/');
      const meta = await (deps.fetchThreadsMetadata || fetchThreadsMetadata)(`https://www.threads.com/@${user}/post/${code}`);
      const text = threadsCardText(meta);
      return text ? { text } : null;
    },
  },
};

// Callers hand in either a post ref ({ source, id, text, language }) or, for
// X, the tweet meta itself.
function toPost(meta) {
  if (meta?.source) return meta;
  return { source: 'x', id: meta?.statusId, text: meta?.text, language: meta?.language };
}

function parseCustomId(customId) {
  for (const [source, spec] of Object.entries(SOURCES)) {
    if (!customId?.startsWith(spec.prefix)) continue;
    const match = /^(translate|original):(.+)$/.exec(customId.slice(spec.prefix.length));
    if (!match || !spec.id.test(match[2])) return { known: true };
    return { known: true, action: match[1], post: { source, id: match[2] } };
  }
  return { known: false };
}

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
function buttons(post, action = 'translate') {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`${SOURCES[post.source].prefix}${action}:${post.id}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(LABELS[action])
    .setDisabled(action === 'busy'))];
}

// The native-embed check stays on: when Discord's own card shows up, the bot
// posts no preview (a second copy of the image whenever it can't suppress the
// original), only a button-only stub — see buildTranslationStub. A foreign
// post also carries `selfCard`, the bot's own card — see preferSelfCards.
function addTranslationButton(payload, meta, selfCard = null) {
  const post = toPost(meta);
  if (!enabled() || !post.id || !isForeignPost(post)) return payload;
  const components = buttons(post);
  const deferred = payload.nativeEmbedCheck ? {
    translationStub: { statusId: post.id },
    ...(selfCard ? { selfCard: { ...selfCard, components } } : {}),
  } : {};
  return { ...payload, components, ...deferred };
}

// Whenever the bot posts the preview itself, a foreign post goes out as the
// bot's own card, never the fixer link: Discord owns a fixer unfurl, so the
// translation could only be quoted under the link instead of edited into the
// card. With ManageMessages that happens up front (the native card gets
// suppressed); without it only once the native card failed to show — if it
// does show, the stub carries the button instead.
function preferSelfCards(payloads, swap) {
  if (!swap) return payloads;
  return payloads.map((payload) => payload?.selfCard || payload);
}

// Reply that carries the translate button under Discord's own card. No link
// and no embed, so it can't duplicate the post; the reply reference already
// points at the post and the button says what it does, so the text is only
// the minimum a non-V2 message needs. Clicking quotes the translation into it
// through the same renderInPlace link path.
function buildTranslationStub({ statusId }) {
  return { content: '-# 🌐', components: buttons({ source: 'x', id: statusId }), allowedMentions: { parse: [], repliedUser: false } };
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
// not. A bot-built card (X gallery / spoilered, any Threads card) gets its post
// text swapped; a
// fixer link card can't be rewritten (Discord owns the unfurl), so the
// translation rides below the link as a quote. Both are reversible by the
// 查看原文 button, which restores the post text without another model call.
const LINK_MARK = '\n-# 繁體中文翻譯\n';
const CARD_MARK = ' · 繁體中文翻譯';
const CONTENT_LIMIT = 2000;

function isBotCard(message, post) {
  const spec = SOURCES[post.source];
  const lead = message.embeds?.[0];
  return !/https?:\/\//.test(message.content || '')
    && Boolean(lead?.footer?.text?.startsWith(spec.footer))
    && Boolean(lead.url?.includes(spec.cardMark(post.id)));
}

function quote(text, budget) {
  const quoted = text.trim().split('\n').map(line => `> ${line}`).join('\n');
  if (quoted.length <= budget) return quoted;
  const tail = '\n> …（太長了，完整內容請開原文）';
  return quoted.slice(0, Math.max(0, budget - tail.length)) + tail;
}

function renderInPlace(message, meta, text, translated) {
  const post = toPost(meta);
  const components = buttons(post, translated ? 'original' : 'translate');
  if (isBotCard(message, post)) {
    const [lead, ...rest] = message.embeds;
    const footer = lead.footer.text.split(CARD_MARK)[0];
    const embed = EmbedBuilder.from(lead)
      .setDescription(trimDescription(text, translated ? 4000 : SOURCES[post.source].cardLimit))
      .setFooter({ text: translated ? footer + CARD_MARK : footer, iconURL: lead.footer.iconURL || undefined });
    return { embeds: [embed, ...rest], components, allowedMentions: { parse: [] } };
  }
  const base = (message.content || '').split(LINK_MARK)[0];
  const content = translated ? base + LINK_MARK + quote(text, CONTENT_LIMIT - base.length - LINK_MARK.length) : base;
  return { content, components, allowedMentions: { parse: [] } };
}

function recall(map, key, now) {
  const hit = map.get(key);
  if (!hit) return null;
  map.delete(key);
  if (hit.expires <= now) return null;
  map.set(key, hit);
  return hit;
}

function remember(map, key, entry, now) {
  map.delete(key);
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
  map.set(key, { ...entry, expires: now + CACHE_TTL_MS });
}

// The message alone can't give the original back: a translated card shows the
// translation, an X card's own text is cut at 1024 chars, and a stub has none.
// So the post is fetched by id once and reused for every later toggle.
async function originalPost(post, deps) {
  const key = `${post.source}:${post.id}`;
  const now = Date.now();
  const hit = recall(metaCache, key, now);
  if (hit) return hit.original;
  const original = await SOURCES[post.source].fetch(post.id, deps);
  if (original?.text) remember(metaCache, key, { original }, now);
  return original;
}

async function translateCached(text, deps, userId, guildId) {
  const policy = [process.env.TRANSLATION_PROVIDER || 'auto', process.env.TRANSLATION_MODEL || '', process.env.TRANSLATION_DEEPSEEK_OFFPEAK_ENABLED || 'false'].join('|');
  // Keep caches within a guild: an exhausted guild cannot borrow a premium
  // call from another guild. Reusing its own completed result is free, even if
  // its quota or the peak window changed after the original API call.
  const key = createHash('sha256').update(`${guildId}|${policy}|${PROMPT_VERSION}|${text}`).digest('hex');
  const now = Date.now();
  const hit = recall(cache, key, now);
  if (hit) return hit.promise;
  if (now - (cooldowns.get(userId) || 0) < 5000) throw new Error('Translation cooldown');
  if (active >= 4) throw new Error('Translation busy');
  if (cooldowns.size >= 1000) cooldowns.delete(cooldowns.keys().next().value);
  const route = (deps.reserveTranslation || reserveTranslation)(guildId);
  cooldowns.set(userId, now);
  active++;
  const promise = Promise.resolve().then(() => (deps.requestTranslation || requestTranslationWithRetry)(text, route));
  remember(cache, key, { promise }, now);
  try { return await promise; }
  catch (error) { cache.delete(key); throw error; }
  finally { active--; }
}

async function handleTranslationInteraction(interaction, client, deps = {}) {
  if (!interaction.isButton?.()) return false;
  const { known, action, post } = parseCustomId(interaction.customId);
  if (!known) return false;
  // Ephemeral cards are the retired private-card design; their buttons are dead.
  const privateMessage = Boolean(interaction.message?.flags?.has(MessageFlags.Ephemeral));
  if (!post || !enabled() || interaction.message?.author?.id !== client.user.id || privateMessage) {
    await interaction.reply({ content: '這個翻譯按鈕目前無法使用。', flags: MessageFlags.Ephemeral });
    return true;
  }
  const translated = action === 'translate';
  // A translation takes seconds and deferUpdate shows nothing, so the button
  // itself turns into a locked 翻譯中… right away (also stops double clicks).
  // 查看原文 needs no model call and stays a plain ack.
  if (translated) await interaction.update({ components: buttons(post, 'busy') });
  else await interaction.deferUpdate();
  try {
    const original = await originalPost(post, deps);
    if (!original?.text || original.text.length > 12000) throw new Error('Post unavailable');
    const result = translated ? await translateCached(original.text, deps, interaction.user.id, interaction.guildId) : { text: original.text };
    await interaction.editReply(renderInPlace(interaction.message, post, result.text, translated));
  } catch {
    // Only the failure is private: the public preview goes back to how it was.
    if (translated) await interaction.editReply({ components: buttons(post) }).catch(() => {});
    await interaction.followUp({ content: '目前無法翻譯，請稍後再試或開啟原文。', flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }
  return true;
}

module.exports = { isForeignPost, addTranslationButton, preferSelfCards, buildTranslationStub, sendTranslationStubs, renderInPlace, handleTranslationInteraction };
