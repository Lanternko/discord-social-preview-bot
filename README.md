# Discord Social Preview Bot

可以在 Discord 預覽社群貼文的機器人！

<img width="620" height="755" alt="image" src="https://github.com/user-attachments/assets/6a096faa-3197-4b2a-90a5-2e081fe41dc0" />

4.12 更新：Bilibili 影片嵌入、Threads 多圖顯示、修復資安漏洞

## Supported platforms

- Threads (`threads.com`, `threads.net`)
- X / Twitter
- Instagram
- Reddit
- Pixiv
- Bluesky
- Bilibili
- Facebook (`facebook.com`, `m.facebook.com`, `fb.watch`)
- 巴哈姆特 (`forum.gamer.com.tw`, `m.gamer.com.tw`)
- PTT (`ptt.cc`, `www.ptt.cc`)

## Current preview behavior

### Threads

- Text-only posts: custom Discord embed
- Single-image posts: custom Discord embed with image
- Video posts: FixEmbed fallback so Discord can keep playable rich preview behavior
- Multi-image posts: custom embed with the first image and a link button

### Other platforms

- X / Twitter: dedicated fixer fallback
- Instagram: generic FixEmbed fallback
- Reddit: dedicated fixer fallback
- Pixiv: dedicated fixer fallback
- Bluesky: dedicated fixer fallback
- Bilibili: dedicated fixer fallback
- Facebook: dedicated fixer fallback
- 巴哈姆特: custom Discord embed with title, summary, and image when the page is publicly accessible
- PTT: custom Discord embed with title, trimmed article text, and first linked image if one exists

## Features

- Deduplicates repeated previews in the same channel
- Suppresses the original embed if the bot has `Manage Messages`
- Uses Playwright only for Threads metadata extraction
- Normalizes common tracking query parameters before dedupe
- Bilibili short links (`b23.tv`) are expanded before fixer routing
- Registers a `/servers` slash command so you can check how many guilds the bot is in from Discord
- Registers a `/debug-perms` slash command so you can check the bot's channel permissions from Discord

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

For local macOS use, you can keep your own `start-bot.command` and `stop-bot.command` outside Git.

Public startup scripts in this repo:

- `scripts/start.sh`
- `scripts/stop.sh`

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
- `start-bot.command` / `stop-bot.command`: local-only macOS shortcuts, intentionally gitignored
- [scripts/start.sh](./scripts/start.sh)
- [scripts/stop.sh](./scripts/stop.sh)

## Troubleshooting

### `/servers` command does not appear yet

Global application commands such as `/servers` and `/debug-perms` can take a little while to propagate in Discord after the bot starts or restarts. If needed, restart the bot and wait a few minutes.

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

### Bahamut restricted boards may not show full content

Some 巴哈姆特 boards are behind login or content-warning gates. In those cases, the bot can only show what the page exposes without logging in.

### PTT adult boards require the over18 cookie

The bot already sets the `over18=1` cookie in Playwright for PTT. If a page still blocks preview, the article may be unavailable or removed.

## Security notes

- Never commit `.env`
- Never share your bot token
- If a token was posted publicly, reset it immediately

## License

No license file is included yet.
