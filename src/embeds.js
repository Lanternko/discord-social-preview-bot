const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

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

function buildThreadsLinkRow(url, label = "前往 Threads 查看完整內容") {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel(label)
      .setStyle(ButtonStyle.Link)
      .setURL(url),
  );
}

function buildThreadsCarouselEmbeds(url, firstMetadata, allImages) {
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
  return [firstEmbed, ...restEmbeds];
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

function buildBilibiliEmbed(url, metadata) {
  const embed = new EmbedBuilder()
    .setColor(0x00a1d6)
    .setURL(url)
    .setTitle(trimDescription(metadata.title, 256))
    .setFooter({ text: "Bilibili" });

  if (metadata.author) embed.setAuthor({ name: metadata.author });
  if (metadata.description)
    embed.setDescription(trimDescription(metadata.description, 512));
  if (metadata.image) embed.setImage(metadata.image);
  return embed;
}

module.exports = {
  buildThreadsCompactEmbed,
  buildThreadsMediaEmbed,
  buildThreadsLinkRow,
  buildThreadsCarouselEmbeds,
  buildBahamutEmbed,
  buildPttEmbed,
  buildBilibiliEmbed,
};
