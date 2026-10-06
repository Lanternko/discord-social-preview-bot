# 自己架設 Discord Social Preview Bot

## 1. 安裝

需要 Node.js 24+。

```bash
git clone https://github.com/Lanternko/discord-social-preview-bot.git
cd discord-social-preview-bot
npm install
npx playwright install chromium
```

Linux 另外需要：

```bash
sudo npx playwright install-deps chromium
```

## 2. 建立 Discord Bot

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. **Bot** → **Reset Token** → 複製 token；同頁開啟 ✅ `MESSAGE CONTENT INTENT`（**必開**）
3. **OAuth2 → URL Generator**：SCOPES 勾 `bot` + `applications.commands`；權限勾 `View Channels` / `Send Messages` / `Read Message History` / `Embed Links` / `Attach Files` / `Manage Messages`（最後一個用來收起原本的預覽，建議開）→ 用產生的連結邀請 bot

## 3. 設定並啟動

```bash
cp .env.example .env
```

`.env` 只填 `DISCORD_TOKEN` 就能跑，其餘全部有預設值。

```bash
npm start
```

看到 `[ready] Logged in as ...` 即成功。macOS 可雙擊 `start-bot.command` / `stop-bot.command` 背景執行。

<details>
<summary><b>Docker</b></summary>

```bash
docker build -t discord-social-preview-bot .
docker run -d --name discord-social-preview-bot --restart unless-stopped \
  --env-file .env discord-social-preview-bot
```

</details>

## 4. 開啟 AI 聊天（可選）

沒填任何 AI 金鑰時，@西寶 只會回寫死的招呼語、抽籤、道歉。在 `.env` 填任一把金鑰就能聊天，填越多越穩——任一層失敗（逾時、額度、安全阻擋）會自動換下一層：

| Provider | `.env` | 預設 model | 備註 |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-flash` | 主力；便宜、中文好。@西寶 附圖先給它看 |
| OpenAI 相容 | `OPENAI_API_KEY` | `gpt-5.6-luna` | DeepSeek 看圖失敗時帶圖再看一次；可用 `OPENAI_BASE_URL` 指向其他相容服務 |
| Groq | `GROQ_API_KEY` | `qwen/qwen3.8-27b` | 免費、不用綁卡，**新手最好上手** |
| Gemini | `GEMINI_API_KEY` | `gemini-3.6-flash` | 最後防線，見下方 billing 陷阱 |

> ⚠️ **Gemini billing 陷阱**：Google Cloud 專案綁了 billing（含 $300 試用）會讓 Gemini free tier 變成 `limit: 0`。到 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 建 key 時選「**Create API key in new project**」。

完整變數（model 覆寫、逾時、尖峰降級、每日額度、語音 TTS 等）見 [env.md](env.md)，鏈的設計與熔斷機制見 [ai-providers.md](ai-providers.md)。

---

## 疑難排解

| 症狀 | 原因 / 解法 |
|---|---|
| 啟動沒報錯但不回覆 | 沒開 `MESSAGE CONTENT INTENT`，開了之後重啟 |
| Slash 指令沒出現 | 全域指令要幾分鐘才會同步，稍等即可 |
| 同一則訊息回兩次 | 同個 token 開了兩個 instance：`ps aux \| grep "[n]ode src/index.js"` |
| Threads 預覽很慢 / 退成 fixer | Playwright 版本更新後沒裝 browser：再跑一次 `npx playwright install chromium` |
| @西寶 只回寫死的句子 | 所有 AI 層都失敗；log 裡找 `[ai] chain exhausted` 往上看是哪一層、什麼原因 |
| 巴哈限制板只有部分內容 | 登入牆後的內容抓不到；場外可設 `BAHA_USER_ID` / `BAHA_PASSWORD` |

**安全**：不要 commit `.env`、不要把 bot token 貼到任何公開地方；外洩了立刻到 Developer Portal → Bot → **Reset Token**。
