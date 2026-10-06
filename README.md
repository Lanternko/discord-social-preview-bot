# Discord Social Preview Bot

貼社群連結，自動回完整預覽的 Discord bot——Threads、X、Instagram 這些 Discord 原生預覽常常壞掉的平台都能正常顯示，影片直接上傳成能播的。附帶一個害羞內向的 AI 人格「西寶」可以聊天。

### [👉 邀請西寶到你的伺服器](https://discord.com/oauth2/authorize?client_id=1491051091524059316&permissions=2815164231806016&scope=bot+applications.commands)

不想自己架設就直接邀請：預覽功能完整可用，AI 聊天每個伺服器每天 20 次免費（用 `/ai-key` 設定自己的 DeepSeek 金鑰就不限次數）。

<img width="609" height="484" alt="預覽範例" src="https://github.com/user-attachments/assets/51f4fd21-25cc-4a7d-befb-3c58bd5c9ae8" />
<img width="514" height="83" alt="西寶回覆" src="https://github.com/user-attachments/assets/74e30b1e-e0a0-4016-8e4c-5cfc3c838b71" />
<img width="855" height="109" alt="西寶回覆" src="https://github.com/user-attachments/assets/dacb0a19-0529-4832-ac58-d52c42acf566" />

---

## 功能

**連結預覽**

- **支援平台**：Threads / X (Twitter) / Instagram（貼文、Reels）/ Reddit / Pixiv / Bluesky / Bilibili / Facebook / Pinterest / 巴哈姆特 / PTT
- **影片能播**：Threads、Bilibili、Pinterest 等的影片會下載後直接上傳；太大放不下才改貼可播放的轉址連結
- **多圖相簿**、**長圖自動拼回一張**、X / Pixiv 的 R18 圖**打碼後上傳**
- **X 外文貼文一鍵翻譯**成繁體中文（按鈕切換，大家都看得到）
- **多層 fallback**：主要來源失敗會依序退到備用 viewer、OG 資訊卡，全部失敗才回「預覽載入失敗」
- 自動去除 `fbclid` / `utm_*` / `igsh` 等追蹤參數；同頻道 60 秒內同連結只回一次
- 訊息含 `nopreview` / `previewignore` / `fxignore` → 跳過
- 在西寶的訊息按 🗑️（或右鍵 → 應用程式 →「刪除西寶訊息」）可刪掉預覽

各平台的詳細路由與 fallback 順序見 [docs/routing.md](docs/routing.md)。

**@西寶 聊天**

- `@西寶` 就能聊天；附圖她看得到；記得頻道最近對話與群友的長期印象
- 說「講個故事」「模仿某某」「你會什麼」會觸發對應技能
- `抽籤` / `運勢` 抽今日運勢，`道歉` 固定台詞（不經 AI）
- 會用伺服器的貼圖與 emoji；`/voice` 讓她用語音回答

> 「西寶」只是預設名稱與人格：改 Discord 上的 bot 名稱即可改名，`.env` 設 `AI_PERSONA="你是..."` 即可換掉整個人格。

**最近更新**（完整列表見 [help-changelog.md](src/ai/skills/help-changelog.md)）

- 10.04：X 外文貼文加上「翻譯成繁體中文」按鈕
- 09.29：`/ai-chat` 可關掉「回覆／@everyone 就叫出西寶」，只留直接 @
- 09.27：`/language` 切換回覆語言（繁中 / 简中 / 日本語 / English）；X 原生預覽正常時不再重複貼卡
- 09.26：支援 Pinterest；長圖自動拼接
- 09.10：@西寶 附圖看得懂；Threads 預覽變快

---

## 指令

| 指令 | 用途 | 權限 |
|---|---|---|
| `/help` | 功能與設定說明 | 所有人 |
| `/ai-tier` | 查看 / 切換 AI 方案 | 切換需「管理伺服器」 |
| `/ai-key set\|status\|remove` | 管理本伺服器的 DeepSeek 金鑰 | 管理伺服器 |
| `/ai-chat` | 開關「回覆／@everyone 叫出西寶」 | 切換需「管理伺服器」 |
| `/language` | 西寶的回覆語言 | 切換需「管理伺服器」 |
| `/memory show\|guild\|forget-me\|forget-user` | 查看 / 刪除西寶的記憶 | `forget-user` 需管理員 |
| `/schedule add\|list\|remove` | 每日排程（床邊故事 / 早安問候 / 今日回顧） | 管理伺服器 |
| `/voice` | 讓西寶用語音回答 | 所有人 |
| `/debug-perms` | 檢查 bot 在此頻道的權限 | 所有人 |
| `/servers` | bot 加入了幾個伺服器 | 所有人 |

### AI 方案

| 方案 | 回覆長度 | 對話記憶 | 讀群組前文 | 費用 |
|---|---|---|---|---|
| **入門**（預設） | 1~4 句 | 8 輪 | ✗ | 免費，每伺服器每天 20 次 |
| **標準** | 2~8 句 | 40 輪 | 最近 15 則 | 需自備 DeepSeek 金鑰 |
| **精細** | 3~15 句 | 60 輪 | 最近 15 則 | 需自備 DeepSeek 金鑰 |

升級：到 [platform.deepseek.com](https://platform.deepseek.com/) 申請金鑰並儲值 → `/ai-key set` → `/ai-tier level:標準`。設了自己的金鑰後，入門方案也不再有每日上限。**金鑰只用 `/ai-key set` 輸入，絕對不要貼在聊天裡。**

---

## 自己架設

### 1. 安裝

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

### 2. 建立 Discord Bot

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
2. **Bot** → **Reset Token** → 複製 token；同頁開啟 ✅ `MESSAGE CONTENT INTENT`（**必開**）
3. **OAuth2 → URL Generator**：SCOPES 勾 `bot` + `applications.commands`；權限勾 `View Channels` / `Send Messages` / `Read Message History` / `Embed Links` / `Attach Files` / `Manage Messages`（最後一個用來收起原本的預覽，建議開）→ 用產生的連結邀請 bot

### 3. 設定並啟動

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

### 4. 開啟 AI 聊天（可選）

沒填任何 AI 金鑰時，@西寶 只會回寫死的招呼語、抽籤、道歉。在 `.env` 填任一把金鑰就能聊天，填越多越穩——任一層失敗（逾時、額度、安全阻擋）會自動換下一層：

| Provider | `.env` | 預設 model | 備註 |
|---|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-flash` | 主力；便宜、中文好，唯一看得懂圖的一層 |
| Kimi | `KIMI_API_KEY` | `kimi-k2.6` | `KIMI_ENABLED=false` 可關 |
| OpenAI 相容 | `OPENAI_API_KEY` | `gpt-5.6-luna` | 可用 `OPENAI_BASE_URL` 指向其他相容服務 |
| Groq | `GROQ_API_KEY` | `qwen/qwen3.8-27b` | 免費、不用綁卡，**新手最好上手** |
| Gemini | `GEMINI_API_KEY` | `gemini-3.6-flash` | 最後防線，見下方 billing 陷阱 |

> ⚠️ **Gemini billing 陷阱**：Google Cloud 專案綁了 billing（含 $300 試用）會讓 Gemini free tier 變成 `limit: 0`。到 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) 建 key 時選「**Create API key in new project**」。

完整變數（model 覆寫、逾時、尖峰降級、每日額度、語音 TTS 等）見 [docs/env.md](docs/env.md)，鏈的設計與熔斷機制見 [docs/ai-providers.md](docs/ai-providers.md)。

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

---

## 開發

- 入口 [src/index.js](src/index.js) 只負責啟動與派發；模組分工與完整樹狀圖見 [docs/architecture.md](docs/architecture.md)
- `npm test` 跑全部 smoke（純函式 / 路由 payload / AI 鏈熔斷），說明見 [docs/scripts.md](docs/scripts.md)
- 部署與重啟見 [docs/deploy.md](docs/deploy.md)；貢獻流程與注意事項見 [CLAUDE.md](CLAUDE.md)

## License

尚未加上 license 檔。
