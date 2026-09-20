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

// The card for a sensitive X post: author + avatar, the post text, and no
// link unfurl — the images ride below as spoilered attachments, so nothing
// explicit renders until someone chooses to look. No engagement counts.
function buildTwitterSpoilerEmbed(url, metadata) {
  const embed = new EmbedBuilder()
    .setColor(0x1da1f2)
    .setURL(url)
    .setFooter({ text: "X (Twitter) · 🔞 已打碼" });

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

module.exports = {
  buildTwitterSpoilerEmbed,
  buildThreadsCompactEmbed,
  buildThreadsMediaEmbed,
  buildThreadsCarouselEmbeds,
  buildBahamutEmbed,
  buildPttEmbed,
  buildBilibiliEmbed,
};
