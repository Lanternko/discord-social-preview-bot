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

// The full cover embed, shown only when a video CAN'T attach (fallback). When
// the video uploads, bilibili.js supplies a content info bar instead (clickable
// title + mark, above the player) — see buildBilibiliVideoCaption.
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

const TWITTER_EMBED_COLOR = 0x1da1f2;

// Author (with avatar) + post text, linked to the post. The shared body of
// both bot-built X cards; what rides below it differs — spoilered attachments
// for a sensitive post, a gallery of embeds for a multi-image one.
function buildTwitterPostEmbed(url, metadata, footerText = "X (Twitter)") {
  const embed = new EmbedBuilder()
    .setColor(TWITTER_EMBED_COLOR)
    .setURL(url)
    .setFooter({ text: footerText });

  const handle = metadata.authorHandle ? `@${metadata.authorHandle}` : "";
  const name = [metadata.authorName, handle && `(${handle})`]
    .filter(Boolean)
    .join(" ");
  if (name) {
    embed.setAuthor({
      name: trimDescription(name, 256),
      url,
      ...(metadata.authorAvatar ? { iconURL: metadata.authorAvatar } : {}),
    });
  }
  if (metadata.text) embed.setDescription(trimDescription(metadata.text, 1024));
  return embed;
}

// The card for a sensitive X post: no link unfurl, no engagement counts — the
// images ride below as spoilered attachments, so nothing explicit renders
// until someone chooses to look.
function buildTwitterSpoilerEmbed(url, metadata) {
  return buildTwitterPostEmbed(url, metadata, "X (Twitter) · 🔞 已打碼");
}

// A multi-image X post as the bot's own gallery: one embed per photo, all
// sharing the post URL so Discord groups them into a single album. The images
// stay remote (pbs.twimg.com) — Discord fetches them, the bot uploads nothing.
// A fixer unfurl can only ever show one image: fxtwitter mosaics them into a
// single tile, vxtwitter renders a combined collage, and neither gives the
// full-size originals.
function buildTwitterCarouselEmbeds(url, metadata) {
  const [first, ...rest] = metadata.photos;
  const firstEmbed = buildTwitterPostEmbed(url, metadata).setImage(first);
  const embeds = [
    firstEmbed,
    ...rest.map((image) =>
      new EmbedBuilder()
        .setURL(url)
        .setColor(TWITTER_EMBED_COLOR)
        .setImage(image),
    ),
  ];
  const hidden = metadata.photoCount - metadata.photos.length;
  if (hidden > 0) {
    const last = embeds[embeds.length - 1];
    const existing = last.data?.description;
    const hint = `... 還有 ${hidden} 張`;
    last.setDescription(existing ? `${existing}\n\n${hint}` : hint);
  }
  return embeds;
}

module.exports = {
  buildTwitterSpoilerEmbed,
  buildTwitterCarouselEmbeds,
  buildThreadsCompactEmbed,
  buildThreadsMediaEmbed,
  buildThreadsCarouselEmbeds,
  buildBahamutEmbed,
  buildPttEmbed,
  buildBilibiliEmbed,
};
