# Discord Social Preview Bot

### 可以在 Discord 預覽社群貼文的機器人！#支援 Threads

4.12 更新：Bilibili 影片嵌入、Threads 多圖顯示、修復資安漏洞

4.13 更新：FB 可以正確顯示（繞過登入要求）

4.15 更新：預覽失敗時會道歉 orz

4.16 更新：Threads 影片三段 fallback、Instagram 多段 fallback（fxstagram）、Threads 多圖全圖集顯示、運勢抽籤

4.17 更新：@西寶 接上 Gemini 2.0 Flash，閒聊回應變得個人化（需自備 GEMINI_API_KEY，免費）

<img width="609" height="484" alt="image" src="https://github.com/user-attachments/assets/51f4fd21-25cc-4a7d-befb-3c58bd5c9ae8" />
<img width="514" height="83" alt="image" src="https://github.com/user-attachments/assets/74e30b1e-e0a0-4016-8e4c-5cfc3c838b71" />
<img width="300" height="88" alt="image" src="https://github.com/user-attachments/assets/963324f8-ed11-4af3-b587-45d617573766" />



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

| 貼文類型 | 預覽行為 |
|---|---|
| 純文字 | 自訂 embed（標題＋內文） |
| 單張圖片 | 自訂 embed（標題＋內文＋圖片） |
| 多張圖片 | 全圖集 embed（每張圖各一個 embed，Discord 渲染成 gallery） |
| 影片 | 依序嘗試 fixthreads → threadsez → 資訊卡 fallback（見下方） |

### Instagram

| 貼文類型 | 預覽行為 |
|---|---|
| 限時動態 | 無法預覽，直接回報作者名稱 |
| 貼文 / Reels | 依序嘗試 ddinstagram → fxstagram → FixEmbed |

### Other platforms

| 平台 | 預覽行為 |
|---|---|
| X / Twitter | fxtwitter fixer |
| Reddit | rxddit fixer |
| Pixiv | phixiv fixer |
| Bluesky | bskx fixer |
| Bilibili | vxbilibili fixer |
| Facebook | facebed fixer |
| 巴哈姆特 | 自訂 embed（標題＋摘要＋圖片，需公開可存取） |
| PTT | 自訂 embed（標題＋文章內文＋第一張圖片） |

## Known limitations & fallback behavior

以下情形無法顯示完整影片或圖片，但 bot 會盡力提供替代資訊：

| 情形 | Bot 的反應 |
|---|---|
| Threads 影片（所有 fixer 失敗） | 資訊卡：作者名稱＋貼文文案＋「影片無法載入，請點連結觀看」 |
| Instagram 限時動態 | 文字訊息：「這是 **@xxx** 的限動！」（無任何第三方服務支援） |
| Instagram Reels（所有 fixer 失敗） | FixEmbed 連結（最後防線，Discord 自行嘗試 unfurl） |
| 巴哈姆特限制板 / 登入牆 | 顯示公開部分，內文可能為空 |
| 已刪除 / 私人 / 被限流的貼文 | 道歉訊息：「對不起對不起…預覽載入失敗了…」 |

## Features

- Deduplicates repeated previews in the same channel
- Suppresses the original embed if the bot has `Manage Messages`
- Uses Playwright only for Threads metadata extraction
- Strips common tracking parameters (`fbclid`, `gclid`, `mibextid`, `utm_*`, `igsh`, etc.) from URLs before replying — protects the poster from leaking share-tracking info, and improves dedupe
- Bilibili short links (`b23.tv`) are expanded before fixer routing
- `@西寶` 有人格化 AI 回覆（支援 Groq / Gemini，可選）
- Registers a `/servers` slash command so you can check how many guilds the bot is in from Discord
- Registers a `/debug-perms` slash command so you can check the bot's channel permissions from Discord

## @西寶 mention responses

當訊息中 @ 到機器人時：

| 輸入 | 回應 |
|---|---|
| `抽籤` | 抽今日運勢（寫死，不走 AI） |
| `道歉` | 固定台詞（寫死，不走 AI） |
| 其他任何文字（含空白）| **有 AI key** → LLM 依西寶人格即時產生不重複的回覆<br>**沒有 key** → 隨機 4 句招呼 / `你…你在叫我嗎？` |

### 啟用 AI 回覆（可選，免費）

目前支援兩個 provider：**Groq**（推薦）和 **Gemini**。優先順序：`AI_PROVIDER` → 有 Groq 用 Groq → 有 Gemini 用 Gemini → 關閉。

**推薦：Groq**（免費額度大、無 billing 地雷）

1. 到 [https://console.groq.com/keys](https://console.groq.com/keys)（Google 登入，按 Create，不用綁卡）
2. 免費額度：Llama 3.3 70B 每分鐘 30 req / 每日 14,400 req
3. 填入 `.env`：

   ```env
   GROQ_API_KEY=your_key_here
   GROQ_MODEL=llama-3.3-70b-versatile
   ```

**備用：Gemini**

⚠️ 注意：若你的 Google Cloud 專案有綁 billing account（包含 $300 免費試用），**free tier 會被自動停用**，需改用 paid tier 或建立另一個沒綁 billing 的新專案。

1. 到 [Google AI Studio](https://aistudio.google.com/apikey) 申請 API key
2. 建 key 時選「**Create API key in new project**」避免踩上面那個坑
3. 填入 `.env`：

   ```env
   GEMINI_API_KEY=your_key_here
   GEMINI_MODEL=gemini-2.0-flash
   ```

**自訂人格**：在 `.env` 寫 `AI_PERSONA="你是..."` 覆蓋預設。

**安全網**：AI 呼叫失敗（timeout、無額度、內容被擋、key 錯誤）時會自動退回寫死回覆，不會讓西寶沉默。啟動時會印 `[ai] provider=...` 告訴你目前用哪個 provider。

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
