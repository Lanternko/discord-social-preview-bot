const { EmbedBuilder } = require("discord.js");

const { THREADS_EMBED_COLOR } = require("./config");
const { trimDescription } = require("./utils");

function buildThreadsCompactEmbed(url, metadata) {
  const embed = new EmbedBuilder()
    .setColor(THREADS_EMBED_COLOR)
    .setURL(url)
    .setFooter({ text: "Threads" });

  if (metadata.title) {
    embed.setTitle(trimDescription(metadata.title, 256));
  }
  if (metadata.description) {
    embed.setDescription(trimDescription(metadata.description, 4000));
  }
  return embed;
}

function buildThreadsMediaEmbed(url, metadata) {
  const embed = buildThreadsCompactEmbed(url, metadata);
  if (metadata.image) {
    embed.setImage(metadata.image);
  }
  return embed;
}

function buildThreadsCarouselEmbeds(url, firstMetadata, allImages, tailHint) {
  const firstEmbed = buildThreadsMediaEmbed(url, {
    ...firstMetadata,
    image: allImages[0],
  });
  const restEmbeds = allImages
    .slice(1)
    .map((imgUrl) =>
      new EmbedBuilder()
        .setURL(url)
        .setImage(imgUrl)
        .setColor(THREADS_EMBED_COLOR),
    );
  const embeds = [firstEmbed, ...restEmbeds];
  if (tailHint) {
    const last = embeds[embeds.length - 1];
    const existing = last.data?.description;
    last.setDescription(existing ? `${existing}\n\n${tailHint}` : tailHint);
  }
  return embeds;
}

function buildBahamutEmbed(url, metadata) {
  const embed = new EmbedBuilder()
    .setColor(0xf08c2e)
    .setURL(url)
    .setFooter({ text: "巴哈姆特" });

  if (metadata.title) embed.setTitle(trimDescription(metadata.title, 256));
  if (metadata.author)
    embed.setAuthor({ name: trimDescription(metadata.author, 256) });
  if (metadata.description)
    embed.setDescription(trimDescription(metadata.description, 1024));
  if (metadata.image) embed.setImage(metadata.image);
  return embed;
}

function buildPttEmbed(url, metadata) {
  const embed = new EmbedBuilder()
    .setColor(0x3b82f6)
    .setURL(url)
    .setFooter({ text: "PTT" });

  if (metadata.title) embed.setTitle(trimDescription(metadata.title, 256));
  if (metadata.author)
    embed.setAuthor({ name: trimDescription(metadata.author, 256) });
  if (metadata.description)
    embed.setDescription(trimDescription(metadata.description, 1024));
  if (metadata.image) embed.setImage(metadata.image);
  return embed;
}

// `compact: true` is the slim variant shown above an uploaded video: it drops
// the cover (a duplicate still frame of the video), drops the Bilibili footer
// (the player already carries the watermark), and trims the description —
// leaving just the coloured border, clickable title, author, and a short
// caption. The full variant (no video) keeps the cover + footer as its visual.
function buildBilibiliEmbed(url, metadata, { compact = false } = {}) {
  const embed = new EmbedBuilder()
    .setColor(0x00a1d6)
    .setURL(url)
    .setTitle(trimDescription(metadata.title, 256));

  if (metadata.author) embed.setAuthor({ name: metadata.author });
  if (metadata.description)
    embed.setDescription(trimDescription(metadata.description, compact ? 240 : 512));
  if (!compact) {
    if (metadata.image) embed.setImage(metadata.image);
    embed.setFooter({ text: "Bilibili" });
  }
  return embed;
}

module.exports = {
  buildThreadsCompactEmbed,
  buildThreadsMediaEmbed,
  buildThreadsCarouselEmbeds,
  buildBahamutEmbed,
  buildPttEmbed,
  buildBilibiliEmbed,
};
