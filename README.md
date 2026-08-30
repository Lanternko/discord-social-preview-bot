# Discord Social Preview Bot 

### 可以在 Discord 預覽社群貼文的機器人！#支援 Threads

一個會攔截 Threads / X / Instagram / Reddit / Pixiv / Bluesky / Bilibili / Facebook / 巴哈姆特 / PTT 連結、並回覆完整預覽的 Discord bot。

同時附帶一個害羞內向的 AI 人格可以聊天（見下方 [@西寶 AI 回覆](#西寶-ai-回覆可選)），也可用 `/voice` 明確要求西寶發一則語音訊息。

###  [邀請西寶到你的伺服器](https://discord.com/oauth2/authorize?client_id=1491051091524059316&permissions=2815164231806016&scope=bot+applications.commands)

不想自己架設？直接邀請就能用！預覽功能完整可用，AI 聊天每天 20 次免費額度（想要更多？用 `/ai-key` 設定你自己的 API 金鑰）。

<img width="609" height="484" alt="image" src="https://github.com/user-attachments/assets/51f4fd21-25cc-4a7d-befb-3c58bd5c9ae8" />
<img width="514" height="83" alt="image" src="https://github.com/user-attachments/assets/74e30b1e-e0a0-4016-8e4c-5cfc3c838b71" />
<img width="855" height="109" alt="image" src="https://github.com/user-attachments/assets/dacb0a19-0529-4832-ac58-d52c42acf566" />


**最近更新**

- 6.01：**AI 分級方案** — `/ai-tier` 取代 `/tier`，入門（flash 免費 20 次/天）/ 標準 / 精細（pro 模型，需自備 API 金鑰）；`/ai-key` 管理 per-guild API 金鑰
- 5.30：**人格重構** — persona 從 A–G 規則清單重寫為敘事式角色描述，加入攝影社、蒐集飾品、文科女生等設定；anti-dodge 改用角色動機驅動
- 4.26：**群友熟悉度** — 每個伺服器自動累積每個人的發言次數，分 5 級（剛認識 / 認識 / 熟人 / 老朋友 / 摯友），西寶對熟人較自然、對剛進群的略生疏
- 4.25：**群組脈絡** — 標準 / 精細方案的西寶會看到頻道最近 15 條訊息，能理解貼圖梗、跨人對話
- 4.18：README 重寫新手安裝流程（五分鐘快速安裝）、標註「西寶」為可改的預設名稱、介紹適合串接的 AI
- 4.17：`@西寶` 引進 AI 聊天功能
- 4.12：Bilibili、Threads 多圖&影片、IG Reels、FB 貼文 可正確顯示（繞過登入要求）

---

## 目錄

- [支援平台](#支援平台)
- [🍋‍🟩 五分鐘快速安裝](#-五分鐘快速安裝) ← **新手從這裡開始**
- [@西寶 AI 回覆（可選）](#西寶-ai-回覆可選)
- [Docker 安裝（替代方案）](#docker-安裝替代方案)
- [預覽行為詳表](#預覽行為詳表)
- [其他功能](#其他功能)
- [疑難排解](#疑難排解)
- [安全提醒](#安全提醒)

---

## 支援平台

Threads / X (Twitter) / Instagram / Reddit / Pixiv / Bluesky / Bilibili / Facebook / 巴哈姆特 / PTT

> 詳細的貼文類型與預覽方式見下方 [預覽行為詳表](#預覽行為詳表)。

---

## 🍋‍🟩 五分鐘快速安裝

新人第一次安裝 bot，只要跑完這 5 步就會動：

### Step 1：安裝 Node.js 20+

確認版本：

```bash
node -v
```

沒裝的話到 [nodejs.org](https://nodejs.org/) 下載 LTS 版本（v20 以上）。

### Step 2：下載專案並安裝依賴

```bash
git clone https://github.com/Lanternko/discord-social-preview-bot.git
cd discord-social-preview-bot
npm install
npx playwright install chromium
```

Linux 多加一行（macOS / Windows 跳過）：

```bash
sudo npx playwright install-deps chromium
```

### Step 3：建立 Discord Bot 並取得 Token

1. 打開 [Discord Developer Portal](https://discord.com/developers/applications) → **New Application** → 取名
2. 左側選單 **Bot** → **Reset Token** → 複製 token（這就是之後要填的 `DISCORD_TOKEN`）
3. 同頁面下方開啟：
   - ✅ `MESSAGE CONTENT INTENT`（**必開**，否則 bot 看不到訊息內容）
   - ✅ `PUBLIC BOT`（想讓別人也能邀你的 bot 才需要）
4. 左側 **Installation** → 勾選 `Guild Install`
5. 左側 **OAuth2 → URL Generator**：
   - SCOPES：勾 `bot` + `applications.commands`
   - BOT PERMISSIONS：勾 `View Channels` / `Send Messages` / `Read Message History` / `Embed Links` / `Manage Messages`（最後一個可選但強烈建議）
   - 複製最下方產生的連結 → 在瀏覽器打開 → 選你的伺服器邀請

### Step 4：設定 `.env`

```bash
cp .env.example .env
```

打開 `.env`，至少填這一行就能跑：

```env
DISCORD_TOKEN=剛剛複製的 bot token
```

其他變數（fixer 網域、AI key 等）全部可以先留空，bot 會用預設值啟動。詳情見 [docs/env.md](docs/env.md)。

Threads viewer 可選擇依序設定最多三個純 hostname（預設先 `fzthreads.com`、再 `fixthreads.seria.moe`）：

```env
THREADS_VIEWER_HOSTS=fzthreads.com,fixthreads.seria.moe
```

舊的 `FIXER_THREADS` / `FIXER_THREADS_SECONDARY` 設定仍相容。若填入完整 URL、path、port、IP、`localhost` 或超過三個 hostname，bot 會拒絕啟動，避免把不可信網址帶進預覽流程。

### Step 5：啟動

```bash
npm start
```

看到類似這行就成功了：

```
[ready] Logged in as YourBotName#1234
```

到你邀請 bot 的 Discord 伺服器丟一個 Threads / X / Instagram 連結測試，bot 會自動回覆預覽。

**macOS 便利啟動**：雙擊 `start-bot.command` / `stop-bot.command`（在背景跑，關掉 terminal 也不會死）。

---

## @西寶 AI 回覆（可選）

在任何頻道 `@西寶 你今天好嗎？` 會觸發回覆。

原本的文字模式仍是預設行為。只有執行 `/voice message:想說的話` 才會生成適合朗讀的日文短句；西寶會先在頻道貼出相同台詞，再送 Discord 語音訊息。語音人格會參考既有的群友熟悉度、個人／群組記憶與最近對話，但語音回合不會寫入文字模式的對話記憶。若 TTS 暫時不可用，已送出的文字台詞仍會保留。

語音服務沿用 Arale 專案的 Irodori HTTP 契約。啟動西寶的害羞聲線服務：

```bash
./scripts/start-voice-tts.sh
```

預設讀取已通過聽感比較的 `data/voice/xibao/irodori/clean-41-sep/speaker_inversion/checkpoint_final.speaker.safetensors`，監聽 `127.0.0.1:8056`。路徑不同時可設定 `XIBAO_VOICE_EMBED` 與 `XIBAO_TTS_SERVER_SCRIPT`；完整環境變數見 [docs/env.md](docs/env.md)。

> **「西寶」只是預設的顯示名稱與人格**。
> - 改名字：到 Discord Developer Portal → Bot → 改 username，或直接在伺服器幫 bot 改暱稱
> - 改人格：在 `.env` 寫 `AI_PERSONA="你是一個..."` 就會整個換掉預設個性
> 下方所有提到「西寶」的地方，都替換成你自己取的名字即可。

### 不用設定也能玩

沒有任何 AI key 時，被 @ 到時還是會：

- 回「`抽籤`」→ 抽今日運勢（寫死）
- 回「`道歉`」→ 固定台詞（寫死）
- 回其他訊息 → 隨機 4 句招呼語（寫死）

### 想要真的能聊天？加一把 API key 就好

支援 3 個 provider，程式內部的 fallback 鏈以「**付費優先 → 備援**」排序：

> **DeepSeek → Groq → Gemini**，任何一層失敗自動掉下一層

只要**擇一**填入 `.env` 就會啟用，全部填最穩。新手建議優先申請 **Groq**（最好上手、不用綁卡），想要更好的中文品質再加 DeepSeek。

<details>
<summary><b>推薦：DeepSeek（超便宜付費、中文最強、不會 queue）</b></summary>

1. 到 [platform.deepseek.com](https://platform.deepseek.com/)（手機或 Google 登入）
2. 充值最少 $2 USD（單日 100 次呼叫約 $0.001 美元，基本用不完）
3. 到 API keys 頁面建立一把 key
4. 填入 `.env`：

   ```env
   DEEPSEEK_API_KEY=你的_key
   DEEPSEEK_MODEL=deepseek-chat
   ```

</details>

<details>
<summary><b>最推薦新手：Groq（申請最簡單、額度大、速度快）</b></summary>

1. 到 [console.groq.com/keys](https://console.groq.com/keys) Google 登入按 Create，**不用綁卡、不用充值**
2. 免費額度：Llama 3.3 70B 每日 100k tokens、Llama 3.1 8B 每日 500k tokens
3. 填入 `.env`：

   ```env
   GROQ_API_KEY=你的_key
   GROQ_MODELS=llama-3.3-70b-versatile,llama-3.1-8b-instant
   ```

`GROQ_MODELS` 逗號分隔：70B 的 100k tokens/day 爆了會自動掉 8B 的 500k tokens/day。

</details>

<details>
<summary><b>最後防線：Gemini（有 billing 陷阱，請先讀）</b></summary>

⚠️ 若 Google Cloud 專案有綁 billing（含 $300 免費試用），**Gemini free tier 會被自動停用**（`limit: 0`）。建 key 時要選「**Create API key in new project**」避免踩雷。

到 [aistudio.google.com/apikey](https://aistudio.google.com/apikey) → **Create API key in new project**，然後：

```env
GEMINI_API_KEY=你的_key
GEMINI_MODEL=gemini-2.0-flash
```

</details>

### AI 方案：`/ai-tier`

per-guild 設定，重啟後仍保留。方案決定了 AI 模型和回覆品質：

| 方案 | 模型 | 回覆長度 | 記憶深度 | 群組脈絡 | 需要 API 金鑰 |
|------|------|---------|---------|---------|-------------|
| **入門**（預設）| DeepSeek Flash | 1~4 句 | 8 輪 | ✗ | 否（每天 20 次） |
| **標準** | DeepSeek Pro | 2~8 句 | 40 輪 | 最近 15 條 | 是（無限） |
| **精細** | DeepSeek Pro | 3~15 句 | 60 輪 | 最近 15 條 | 是（無限） |

**使用方式**：

- `/ai-tier` → 顯示當前方案、模型、剩餘額度（**所有成員**都能用）
- `/ai-tier level:標準` → 切換到標準（**僅限**具「管理伺服器」權限者）
- 標準 / 精細需要先用 `/ai-key set` 設定 DeepSeek API 金鑰

**怎麼選**：

- **入門**：免費、快速、適合一般閒聊。每天 20 次免費額度，超過後自動使用備用模型
- **標準**：推理模型，回覆更聰明、記憶更深，適合日常使用
- **精細**：最詳細的回答 + 群組上下文，西寶能理解群裡的話題脈絡

### 升級到標準 / 精細：`/ai-key`

1. 到 [platform.deepseek.com](https://platform.deepseek.com/) 申請 API 金鑰（充值最少 $2 USD）
2. 在 Discord 執行 `/ai-key set <你的金鑰>`
3. 執行 `/ai-tier level:標準` 或 `/ai-tier level:精細`

- `/ai-key status` → 查看目前方案狀態
- `/ai-key remove` → 移除金鑰，回到免費入門方案

### 進階環境變數

- `AI_PROVIDER=deepseek` → 強制只用某一層（留空 = 全鏈 fallback）
- `AI_PERSONA="你是..."` → 覆蓋預設人格（可保留 `{SENTENCE_MIN}` / `{SENTENCE_MAX}` 等佔位符讓 AI 方案生效）
- 完整變數表見 [docs/env.md](docs/env.md)
- 設計細節見 [docs/ai-providers.md](docs/ai-providers.md)、AI 方案細節見 [docs/persona.md](docs/persona.md)

---

## Docker 安裝（替代方案）

不想裝 Node.js？用 Docker 就好：

```bash
# 建 image
docker build -t discord-social-preview-bot .

# 前景執行（方便看 log）
docker run --rm --env-file .env discord-social-preview-bot

# 背景執行 + 自動重啟
docker run -d \
  --name discord-social-preview-bot \
  --restart unless-stopped \
  --env-file .env \
  discord-social-preview-bot
```

---

## 預覽行為詳表

### Threads

`threads.com/share/...` 短連結會先安全展開成官方 canonical `@user/post/id`，再拿 canonical URL 做 probe 與 viewer fallback。展開只讀取官方 share 回應的單一 redirect header，不會跟隨或抓取 redirect 目的地。

| 貼文類型 | 預覽行為 |
|---|---|
| 純文字 | 自訂 embed（標題＋內文） |
| 單張圖片 | 自訂 embed（標題＋內文＋圖片） |
| 多張圖片 | 全圖集 embed（每張圖各一個 embed，Discord 渲染成 gallery）。含影片的混合貼文會在圖集下方額外附上可播放影片 |
| 影片 | 先把影片下載後當附件上傳（可播放）；放不下才依序嘗試 `THREADS_VIEWER_HOSTS`，全部失敗則顯示可點回 canonical 原文的本機資訊卡 |

### Instagram

| 貼文類型 | 預覽行為 |
|---|---|
| 限時動態 | 無法預覽，直接回報作者名稱 |
| 貼文 / Reels | 依序嘗試 ddinstagram → fxstagram → FixEmbed |

### 其他平台

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

### 無法預覽時的 fallback

| 情形 | Bot 的反應 |
|---|---|
| Threads（所有 viewer 失敗） | 本機資訊卡：canonical 原文連結；影片貼文另保留作者／文案與「影片無法載入」提示 |
| Instagram 限時動態 | 文字訊息：「這是 **@xxx** 的限動！」 |
| Instagram Reels（所有 fixer 失敗） | FixEmbed 連結（最後防線） |
| 巴哈姆特限制板 / 登入牆 | 顯示公開部分，內文可能為空 |
| 已刪除 / 私人 / 被限流的貼文 | 道歉訊息：「對不起對不起…預覽載入失敗了…」 |

---

## 其他功能

- **自動去重**：同一頻道 60 秒內的重複連結只回一次
- **原 embed 自動收起**：bot 有 `Manage Messages` 權限時會抑制原連結的預覽
- **tracking 參數自動去除**：`fbclid` / `gclid` / `mibextid` / `utm_*` / `igsh` 等會在發送前移除，保護分享者不洩漏 tracking 資訊
- **Bilibili 短連結**：`b23.tv` 會先展開再轉 fixer
- **西寶短期記憶**：每頻道記住最近幾組對話，容量隨 `/ai-tier` 而變（入門 8 / 標準 40 / 精細 60）、30 分鐘 TTL
- **群友熟悉度**：每個伺服器自動累積每個成員的發言次數，分 5 級（剛認識 1+ / 認識 5+ / 熟人 20+ / 老朋友 100+ / 摯友 500+），餵給西寶讓她對熟人較自然、對新人略生疏。資料存在 `data/familiarity.json`（gitignored）。**只計算重啟後的訊息**，不會回填過去聊天記錄
- **群組脈絡**（標準 / 精細方案）：被 @ 時西寶會看到頻道最近 15 條訊息（含貼圖名稱），能理解貼圖梗、跨人對話、誰回應誰
- **忽略標記**：訊息含 `nopreview` / `previewignore` / `fxignore` 任一字串 → bot 直接跳過
- **Slash 指令**：`/help`（功能、指令與設定說明）、`/servers`（看 bot 在幾個伺服器）、`/debug-perms`（檢查頻道權限）、`/ai-tier`（查看 / 切換 AI 方案）、`/ai-key`（管理 API 金鑰）、`/memory`（管理記憶）、`/schedule`（管理定時任務）、`/voice`（語音回答）

---

## 疑難排解

### Bot 啟動沒報錯，但不回覆訊息

最常見是 **Message Content Intent 忘了開**。回 Developer Portal → Bot → 確認 `MESSAGE CONTENT INTENT` 打勾，存檔後重啟 bot。

### Slash 指令沒出現

Discord 全域 slash command 需要幾分鐘 propagate。重啟 bot 後等一下即可。想確認 bot 真的有註冊，看 `bot.log` 裡有沒有 `[commands] registered /ai-tier` 這行。

### Bot 對同一則訊息回兩次

通常是開了兩個 bot instance（同個 token）。檢查有沒有舊 process 沒關：

```bash
ps aux | grep 'node.*index.js' | grep -v grep
```

### Threads 預覽很慢

Threads 頁面 metadata 常常延遲載入。可調整 `.env`：

```env
THREADS_PROBE_TIMEOUT_MS=15000
PLAYWRIGHT_GOTO_TIMEOUT_MS=12000
PLAYWRIGHT_META_WAIT_TIMEOUT_MS=3000
```

### 影片沒有 Discord 內建播放器

這是 Discord 的限制 — 自訂 embed 無法呼叫內建的 inline player，只能靠 fixer unfurl。

### PTT 成人板預覽不出來

bot 已經自動帶 `over18=1` cookie，如果還是失敗代表文章已被刪除或私人化。

### 巴哈姆特限制板只顯示部分內容

某些板鎖在登入牆或警告頁後面，bot 只能抓到未登入狀態能看到的部分。

---

## 安全提醒

- **絕對不要** commit `.env` 到 git（本 repo 的 `.gitignore` 已經擋掉，別手動加）
- **絕對不要** 把 bot token 貼到公開場所（Discord / GitHub / Slack）
- 如果不小心外洩，立刻到 Developer Portal → Bot → **Reset Token**

---

## 專案結構

- [src/index.js](./src/index.js) — Discord client 啟動 + `messageCreate` 派發；其餘邏輯都拆到專責模組
- [src/](./src/) — `url-routing` / `preview` / `platforms/*` / `discord-io` / `mention` / `commands` / `tier-*`，AI 子系統獨立在 `src/ai/`
- [src/threads-probe.cjs](./src/threads-probe.cjs) — Playwright 子行程，抽 Threads / 巴哈 / PTT 的 OG meta（必須維持 CommonJS）
- [scripts/](./scripts/) — `smoke.js`（純函式）/ `routing-smoke.js`（payload builder + mock probe）/ `smoke-ai-circuit.js`（AI chain + circuit breaker），用 `npm test` 跑全部
- [scripts/start.sh](./scripts/start.sh) / [scripts/stop.sh](./scripts/stop.sh) — Linux 啟動腳本
- [.env.example](./.env.example) — 環境變數範本
- [docs/](./docs/) — 模組分組與完整 tree 在 [architecture.md](./docs/architecture.md)，其他細節：[routing.md](./docs/routing.md) / [ai-providers.md](./docs/ai-providers.md) / [persona.md](./docs/persona.md) / [env.md](./docs/env.md) / [scripts.md](./docs/scripts.md) / [deploy.md](./docs/deploy.md)

## License

尚未加上 license 檔。
