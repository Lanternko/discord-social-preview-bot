const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } = require('discord.js');
const { createHash } = require('node:crypto');
const { fetchTweetMeta } = require('./platforms/twitter');
const { requestTranslation } = require('./ai/translation');

const cache = new Map();
const cooldowns = new Map();
let active = 0;
const PREFIX = 'xtranslate:';

function isForeignPost(meta) {
  const text = (meta?.text || '').replace(/https?:\/\/\S+|[@#][\p{L}\p{N}_]+/gu, '');
  const letters = text.match(/\p{L}/gu) || [];
  if (/^(ja|ko)\b/i.test(meta?.language || '') && letters.length >= 4) return true;
  if (letters.length < 8) return false;
  if (/[\u3040-\u30ff\uac00-\ud7af]/u.test(text)) return true;
  if (/^zh\b/i.test(meta?.language || '')) return false;
  const foreign = letters.filter(c => !/\p{Script=Han}/u.test(c)).length;
  return foreign / letters.length >= .6;
}

function enabled() {
  const provider = process.env.TRANSLATION_PROVIDER || 'deepseek';
  const key = { deepseek: 'DEEPSEEK_API_KEY', gemini: 'GEMINI_API_KEY', openai: 'OPENAI_API_KEY', gateway: 'AI_GATEWAY_API_KEY' }[provider];
  return process.env.X_TRANSLATION_ENABLED === 'true' && Boolean(key && process.env[key]);
}

function buttons(id, action = 'translate') {
  return [new ActionRowBuilder().addComponents(new ButtonBuilder()
    .setCustomId(`${PREFIX}${action}:${id}`)
    .setStyle(ButtonStyle.Secondary)
    .setLabel(action === 'original' ? '查看原文' : '翻譯成繁體中文'))];
}

function addTranslationButton(payload, meta) {
  if (!enabled() || !isForeignPost(meta)) return payload;
  return { ...payload, components: buttons(meta.statusId), nativeEmbedCheck: null };
}

function renderPrivateCard(meta, text, translated) {
  const url = `https://x.com/i/status/${meta.statusId}`;
  const embed = new EmbedBuilder().setColor(0x1da1f2).setURL(url)
    .setTitle(translated ? 'X 貼文 · 繁體中文翻譯' : 'X 貼文 · 原文')
    .setDescription(text.length > 3900 ? `${text.slice(0, 3850)}\n\n（內容較長，請開啟原文查看完整貼文）` : text)
    .setFooter({ text: '只有你看得到' });
  const author = [meta.authorName, meta.authorHandle && `@${meta.authorHandle}`].filter(Boolean).join(' ');
  if (author) embed.setAuthor({ name: author.slice(0, 256), url });
  // Sensitive media stays hidden. Videos are opened through the original URL.
  if (!meta.sensitive && meta.photos?.[0]) embed.setImage(meta.photos[0]);
  return { content: '', embeds: [embed], components: buttons(meta.statusId, translated ? 'original' : 'translate'), allowedMentions: { parse: [] } };
}

async function translateCached(text, deps, userId) {
  const key = createHash('sha256').update(`${process.env.TRANSLATION_PROVIDER}|${process.env.TRANSLATION_MODEL}|${text}`).digest('hex');
  const now = Date.now();
  for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
  if (cache.has(key)) return cache.get(key).promise;
  if (now - (cooldowns.get(userId) || 0) < 5000) throw new Error('Translation cooldown');
  if (active >= 4) throw new Error('Translation busy');
  if (cooldowns.size >= 1000) cooldowns.delete(cooldowns.keys().next().value);
  cooldowns.set(userId, now);
  if (cache.size >= 200) cache.delete(cache.keys().next().value);
  active++;
  const promise = (deps.requestTranslation || requestTranslation)(text);
  cache.set(key, { promise, expires: now + 10 * 60 * 1000 });
  try { return await promise; }
  catch (error) { cache.delete(key); throw error; }
  finally { active--; }
}

async function handleTranslationInteraction(interaction, client, deps = {}) {
  if (!interaction.isButton?.() || !interaction.customId?.startsWith(PREFIX)) return false;
  const match = /^xtranslate:(translate|original):(\d{5,25})$/.exec(interaction.customId);
  const privateMessage = Boolean(interaction.message?.flags?.has(MessageFlags.Ephemeral));
  if (!match || !enabled() || interaction.message?.author?.id !== client.user.id || (match[1] === 'original' && !privateMessage)) {
    await interaction.reply({ content: '這個翻譯按鈕目前無法使用。', flags: MessageFlags.Ephemeral });
    return true;
  }
  // deferReply creates a separate ephemeral card. deferUpdate is ONLY allowed
  // on that private card; never update/edit/delete the public preview.
  if (privateMessage) await interaction.deferUpdate();
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const meta = await (deps.fetchTweetMeta || fetchTweetMeta)(`https://x.com/i/status/${match[2]}`);
    if (!meta?.text || meta.text.length > 12000) throw new Error('Post unavailable');
    const translated = match[1] === 'translate';
    const result = translated ? await translateCached(meta.text, deps, interaction.user.id) : { text: meta.text };
    await interaction.editReply(renderPrivateCard(meta, result.text, translated));
  } catch {
    await interaction.editReply({ content: '目前無法翻譯，請稍後再試或開啟原文。', embeds: [], components: [], allowedMentions: { parse: [] } });
  }
  return true;
}

module.exports = { isForeignPost, addTranslationButton, renderPrivateCard, handleTranslationInteraction };
