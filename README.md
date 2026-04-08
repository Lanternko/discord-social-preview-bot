# Discord Social Preview Bot

A Discord bot that previews supported social links, focused on Threads.

<img width="620" height="755" alt="image" src="https://github.com/user-attachments/assets/6a096faa-3197-4b2a-90a5-2e081fe41dc0" />


## Supported platforms

- Threads (`threads.com`, `threads.net`)
- X / Twitter
- Instagram
- Reddit
- Pixiv
- Bluesky
- Bilibili

## Current preview behavior

### Threads

- Text-only posts: custom Discord embed
- Single-image posts: custom Discord embed with image
- Video posts: FixEmbed fallback so Discord can keep playable rich preview behavior
- Multi-image posts: custom embed with the first image and a link button

### Other platforms

- X / Twitter: FixEmbed fallback
- Instagram: FixEmbed fallback
- Reddit: FixEmbed fallback
- Pixiv: FixEmbed fallback
- Bluesky: FixEmbed fallback
- Bilibili: custom Discord embed with thumbnail, title, and description

## Features

- Deduplicates repeated previews in the same channel
- Suppresses the original embed if the bot has `Manage Messages`
- Uses Playwright only for Threads metadata extraction
- Normalizes common tracking query parameters before dedupe

## Requirements

- Node.js 20+
- npm
- Internet access
- A Discord bot token

For Threads support, this project also needs Playwright + Chromium.

## Discord bot setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Create an application
3. Add a bot
4. In **Bot**:
   - enable `Message Content Intent`
   - enable `Public Bot` if other people should be able to invite it
5. In **Installation**:
   - enable `Guild Install`
6. Invite the bot with at least these permissions:
   - `View Channels`
   - `Send Messages`
   - `Read Message History`
   - `Embed Links`
   - `Manage Messages` (optional, but recommended)

## Environment variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Fill in:

```env
DISCORD_TOKEN=your_bot_token_here
FIXEMBED_BASE_URL=https://fixembed.app/embed?url=
SUPPRESS_ORIGINAL_EMBEDS=true
REPLY_MODE=reply
THREADS_PROBE_TIMEOUT_MS=10000
THREADS_METADATA_CACHE_TTL_MS=600000
PLAYWRIGHT_GOTO_TIMEOUT_MS=8000
PLAYWRIGHT_META_WAIT_TIMEOUT_MS=1500
```

## Local setup

### macOS

```bash
npm install
npx playwright install chromium
npm start
```

This repo also includes:

- `start-bot.command`
- `stop-bot.command`

You can double-click them on macOS.

### Linux

```bash
npm install
npx playwright install chromium
sudo npx playwright install-deps chromium
npm start
```

### Windows

```powershell
npm install
npx playwright install chromium
npm start
```

## Docker

The deployment files are:

- [Dockerfile](./Dockerfile)
- [.dockerignore](./.dockerignore)

Build:

```bash
docker build -t discord-social-preview-bot .
```

Run:

```bash
docker run --rm \
  --name discord-social-preview-bot \
  --env-file .env \
  discord-social-preview-bot
```

Background mode:

```bash
docker run -d \
  --name discord-social-preview-bot \
  --restart unless-stopped \
  --env-file .env \
  discord-social-preview-bot
```

## Project structure

- [src/index.js](./src/index.js)
- [src/threads-probe.cjs](./src/threads-probe.cjs)
- [.env.example](./.env.example)
- [start-bot.command](./start-bot.command)
- [stop-bot.command](./stop-bot.command)

## Troubleshooting

### Bot replies twice to one message

This usually means one of these conditions:

- two bot instances are running with the same token
- the bot was restarted but an older process was still alive
- the message was processed concurrently before dedupe was recorded

This project includes both recent-reply dedupe and in-flight dedupe, but you should still keep only one process running per token.

### Threads preview is slow

Threads pages sometimes load media metadata late. You can tune:

- `THREADS_PROBE_TIMEOUT_MS`
- `PLAYWRIGHT_GOTO_TIMEOUT_MS`
- `PLAYWRIGHT_META_WAIT_TIMEOUT_MS`

### Video is not rendered as a custom Discord player

This is a Discord limitation. Custom embeds do not provide the same inline video player behavior as external unfurls.

### Multi-image Threads posts only show one image

This is also a Discord embed limitation. A custom embed can only present one main image cleanly.

## Security notes

- Never commit `.env`
- Never share your bot token
- If a token was posted publicly, reset it immediately

## License

No license file is included yet.
