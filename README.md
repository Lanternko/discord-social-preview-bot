# Discord Social Preview Bot

This bot previews social posts in Discord by replying with either:

- a compact custom Discord embed for Threads text-only posts
- a [FixEmbed](https://fixembed.app/) URL for media-rich posts and other supported sites

Right now this project is configured for:

- Meta Threads (`threads.net`)
- X / Twitter
- Instagram
- Reddit
- Pixiv
- Bluesky
- Bilibili

## Existing bot you can use right now

If you do not need your own bot, you can use the hosted FixEmbed bot directly.

Sources:

- [FixEmbed home](https://fixembed.app/)
- [FixEmbed docs](https://fixembed.app/docs)

FixEmbed advertises multi-platform Discord previews including:

- Threads
- X / Twitter
- Instagram
- Reddit
- Pixiv
- Bluesky
- Bilibili

So if your goal is simply "make Threads posts preview in Discord," the fastest option is to invite FixEmbed instead of hosting anything yourself.

## What this wrapper bot does

This project is for when you want your own bot identity but still want to use an existing preview service:

1. A user posts a supported link.
2. The bot detects it.
3. For Threads text-only posts, the bot builds a compact custom embed from page metadata.
4. For media-rich posts and other supported sites, the bot replies with a `fixembed.app/embed?url=...` link.
5. If the bot has `Manage Messages`, it can try to suppress the original embed.

## Setup

1. Create a Discord bot in the Discord Developer Portal.
2. Enable the `Message Content Intent`.
3. Invite it with these permissions:
   - `View Channels`
   - `Send Messages`
   - `Read Message History`
   - `Embed Links`
   - `Manage Messages` (optional)
4. Copy `.env.example` to `.env`
5. Fill in `DISCORD_TOKEN`
6. Install dependencies:

```bash
npm install
```

7. Start the bot:

```bash
npm start
```

This project is pinned to Homebrew `node@22` because Playwright was unstable on the newer Node version installed on this machine.

## Environment variables

```env
DISCORD_TOKEN=your_bot_token_here
FIXEMBED_BASE_URL=https://fixembed.app/embed?url=
SUPPRESS_ORIGINAL_EMBEDS=true
REPLY_MODE=reply
```

## Example

If someone posts:

```text
https://www.threads.net/@username/post/ABC123
```

The bot replies with:

```text
https://fixembed.app/embed?url=https%3A%2F%2Fwww.threads.net%2F%40username%2Fpost%2FABC123
```

Discord should then render the preview.

## Notes

- This project does not scrape Meta Threads or X directly.
- Threads compact embeds are built from public page metadata.
- Media-rich previews still depend on FixEmbed.
- If you want slash commands, per-channel config, or support for more sites, that can be added next.
