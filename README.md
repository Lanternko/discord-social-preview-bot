# Discord Social Preview Bot

A Discord bot that automatically previews social media posts when someone shares a link.

Supported platforms:

- Meta Threads (`threads.net`, `threads.com`)
- X / Twitter
- Instagram
- Reddit
- Pixiv
- Bluesky
- Bilibili

## How it works

When a user posts a supported link, the bot replies with a preview:

| Post type | Preview method |
|---|---|
| Threads — text only | Custom Discord embed |
| Threads — single image | Custom Discord embed with image |
| Threads — video or multiple images | FixEmbed link (Discord unfurls it) |
| All other platforms | FixEmbed link (Discord unfurls it) |

To ignore a link, include `nopreview` anywhere in your message.

---

## Prerequisites

- **Node.js 20 or later**
- **Playwright Chromium** (used to fetch Threads metadata)

---

## 1. Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name
3. Go to **Bot** → enable **Message Content Intent**
4. Copy the bot token — you will need it in step 4

### Invite the bot to your server

Go to **OAuth2 → URL Generator**, select:

- Scopes: `bot`
- Bot permissions:
  - `View Channels`
  - `Send Messages`
  - `Read Message History`
  - `Embed Links`
  - `Manage Messages` *(optional — lets the bot hide the original link preview)*

Open the generated URL and invite the bot.

---

## 2. Clone and install

```bash
git clone https://github.com/Lanternko/discord-social-preview-bot.git
cd discord-social-preview-bot
npm install
```

---

## 3. Install Playwright browser

The bot uses Playwright to fetch Threads post metadata. You need to install the Chromium browser once:

```bash
npx playwright install chromium
npx playwright install-deps chromium
```

> `install-deps` installs system libraries required by Chromium. On some Linux servers you may need `sudo`.

---

## 4. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in your bot token:

```env
DISCORD_TOKEN=your_bot_token_here
```

---

## 5. Start the bot

```bash
npm start
```

You should see `Logged in as YourBot#1234` in the terminal.

---

## Keep the bot running (optional)

If you want the bot to stay online after closing the terminal, use **pm2**:

```bash
npm install -g pm2
pm2 start src/index.js --name discord-bot
pm2 save
pm2 startup   # follow the printed instructions to auto-start on reboot
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `DISCORD_TOKEN` | *(required)* | Your Discord bot token |
| `FIXEMBED_BASE_URL` | `https://fixembed.app/embed?url=` | Base URL for FixEmbed fallback |
| `SUPPRESS_ORIGINAL_EMBEDS` | `true` | Hide the original link preview (requires Manage Messages) |
| `REPLY_MODE` | `reply` | `reply` to thread-reply, `send` to send a new message |

---

## Troubleshooting

**Bot replies twice to every message**
You have two bot instances running with the same token. Check all your terminals and servers, and make sure only one instance is active.

**Threads links cause an error or no response**
Playwright or Chromium is not installed. Run:
```bash
npx playwright install chromium
npx playwright install-deps chromium
```

**Bot is online but not responding**
Make sure **Message Content Intent** is enabled in the Discord Developer Portal under your bot's settings.

---

## Just want previews without hosting anything?

[FixEmbed](https://fixembed.app/) offers a hosted bot that covers the same platforms. Invite it directly from their site if you do not need your own bot identity.
