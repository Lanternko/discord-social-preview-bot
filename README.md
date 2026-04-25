# Discord Social Preview Bot 

### 可以在 Discord 預覽社群貼文的機器人！#支援 Threads

一個會攔截 Threads / X / Instagram / Reddit / Pixiv / Bluesky / Bilibili / Facebook / 巴哈姆特 / PTT 連結、並回覆完整預覽的 Discord bot。

同時附帶一個害羞內向的 AI 人格可以聊天（見下方 [@西寶 AI 回覆](#西寶-ai-回覆可選)）。

<img width="609" height="484" alt="image" src="https://github.com/user-attachments/assets/51f4fd21-25cc-4a7d-befb-3c58bd5c9ae8" />
<img width="514" height="83" alt="image" src="https://github.com/user-attachments/assets/74e30b1e-e0a0-4016-8e4c-5cfc3c838b71" />
<img width="855" height="109" alt="image" src="https://github.com/user-attachments/assets/dacb0a19-0529-4832-ac58-d52c42acf566" />


**最近更新**

- 4.26：**群友熟悉度** — 每個伺服器自動累積每個人的發言次數，分 5 級（剛認識 / 認識 / 熟人 / 老朋友 / 摯友），西寶對熟人較自然、對剛進群的略生疏；persona 大幅鬆綁政治 / 敏感話題、() 動作描述（如「（小聲）」）頻率收斂、不再用「我先去整理書」當話題擋箭牌
- 4.25：**群組脈絡** — 標準 / 精細 tier 的西寶會看到頻道最近 10~15 條訊息，能理解貼圖梗、跨人對話；解除暱稱禁令可自然稱呼群友；`/tier`（無參數）對所有人開放可見
- 4.19：新增 `/tier` 斜線指令（簡短 / 標準 / 精細），具管理伺服器權限者可切換西寶回覆詳細度（節省 token 或詳細回答）
- 4.18：README 重寫新手安裝流程（五分鐘快速安裝）、標註「西寶」為可改的預設名稱、介紹適合串接的 AI
- 4.17：`@西寶` 接上 AI，會很害羞地跟你閒聊（需自備 API key，可用全免費方案）
- 4.15：預覽失敗時會道歉 orz、運勢抽籤
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

其他變數（fixer 網域、AI key 等）全部可以先留空，bot 會用預設值啟動。詳情見 [.claude/rules/env.md](.claude/rules/env.md)。

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

支援 4 個 provider，程式內部的 fallback 鏈以「**付費優先 → 中文品質 → 備援**」排序：

> **DeepSeek → Cerebras → Groq → Gemini**，任何一層失敗自動掉下一層

只要**擇一**填入 `.env` 就會啟用，全部填最穩。新手建議優先申請 **Groq**（最好上手、不用綁卡），想要更好的中文品質再加 Cerebras / DeepSeek。

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
<summary><b>進階免費：Cerebras Qwen 235B（中文品質最強、1M tokens/day）</b></summary>

比 Groq 稍微麻煩一點點，但中文品質明顯更好。

1. 到 [cloud.cerebras.ai](https://cloud.cerebras.ai/platform/) Google 登入，Free tier 直接給 key
2. 填入 `.env`：

   ```env
   CEREBRAS_API_KEY=你的_key
   CEREBRAS_MODEL=qwen-3-235b-a22b-instruct-2507
   ```

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

### 切換回覆詳細度：`/tier`

per-guild 設定，重啟後仍保留（存在 `data/tier-settings.json`）：

| Tier | UI 選項 | 總體句數 | A 知識 | A+ 深度比較 | B 社交撩 | E 做事 | 記憶深度 | 群組脈絡 |
|---|---|---|---|---|---|---|---|---|
| `brief`（預設）| 簡短 | 1~4 句 | 2~3 | 3~4 | 1~2 | ≤4 | 8 輪 | ✗ |
| `standard` | 標準 | 2~8 句 | 3~5 | 6~8 | 2~3 | ≤8 | 20 輪 | 最近 10 條 |
| `detailed` | 精細 | 3~15 句 | 5~8 | 10~15 | 3~5 | ≤15 | 40 輪 | 最近 15 條 |

**使用方式**：

- `/tier` → 顯示當前伺服器的詳細度設定（**所有成員**都能用）
- `/tier level:標準` → 切換到標準（**僅限**具「管理伺服器」權限者）
- 通常邀 bot 進來的那個人就有「管理伺服器」權限

**怎麼選**（個人建議）：

- **brief**：最保持西寶「話很少」的害羞人設；節省 Token，適合用免費 AI 的人（如 Groq、Qwen）
- **standard**：日常預設最平衡；A+ 6~8 句能給理由、E 做事 ≤8 句可給完整步驟
- **detailed**：資訊量最大但成本最高（Token 費用明顯上升，但記憶力很好、也更聰明）

想要聽詳細理由使用 `detailed`，一般閒聊使用 `brief` ，付費 API 用 `standard`。

### 進階環境變數

- `AI_PROVIDER=deepseek` → 強制只用某一層（留空 = 全鏈 fallback）
- `AI_PERSONA="你是..."` → 覆蓋預設人格（可保留 `{SENTENCE_MIN}` / `{SENTENCE_MAX}` 等佔位符讓 tier 生效）
- 完整變數表見 [.claude/rules/env.md](.claude/rules/env.md)
- 設計細節見 [.claude/rules/ai-providers.md](.claude/rules/ai-providers.md)、tier 細節見 [.claude/rules/persona.md](.claude/rules/persona.md)

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

| 貼文類型 | 預覽行為 |
|---|---|
| 純文字 | 自訂 embed（標題＋內文） |
| 單張圖片 | 自訂 embed（標題＋內文＋圖片） |
| 多張圖片 | 全圖集 embed（每張圖各一個 embed，Discord 渲染成 gallery） |
| 影片 | 依序嘗試 fixthreads → threadsez → 資訊卡 fallback |

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
| Threads 影片（所有 fixer 失敗） | 資訊卡：作者名稱＋文案＋「影片無法載入，請點連結觀看」 |
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
- **西寶短期記憶**：每頻道記住最近幾組對話，容量隨 `/tier` 而變（簡短 8 / 標準 20 / 精細 40）、30 分鐘 TTL
- **群友熟悉度**：每個伺服器自動累積每個成員的發言次數，分 5 級（剛認識 1+ / 認識 5+ / 熟人 20+ / 老朋友 100+ / 摯友 500+），餵給西寶讓她對熟人較自然、對新人略生疏。資料存在 `data/familiarity.json`（gitignored）。**只計算重啟後的訊息**，不會回填過去聊天記錄
- **群組脈絡**（standard / detailed tier）：被 @ 時西寶會看到頻道最近 10~15 條訊息（含貼圖名稱），能理解貼圖梗、跨人對話、誰回應誰
- **忽略標記**：訊息含 `nopreview` / `previewignore` / `fxignore` 任一字串 → bot 直接跳過
- **Slash 指令**：`/servers`（看 bot 在幾個伺服器）、`/debug-perms`（檢查頻道權限）、`/tier`（查看 / 切換西寶詳細度，見 [上方](#切換回覆詳細度tier)）

---

## 疑難排解

### Bot 啟動沒報錯，但不回覆訊息

最常見是 **Message Content Intent 忘了開**。回 Developer Portal → Bot → 確認 `MESSAGE CONTENT INTENT` 打勾，存檔後重啟 bot。

### `/servers` / `/tier` 指令沒出現

Discord 全域 slash command 需要幾分鐘 propagate。重啟 bot 後等一下即可。想確認 bot 真的有註冊，看 `bot.log` 裡有沒有 `[commands] registered /tier` 這行（首次註冊）或 `[commands] updated /tier`（描述更新）。

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
- [.claude/rules/](./.claude/rules/) — 模組分組與完整 tree 在 [architecture.md](./.claude/rules/architecture.md)，其他細節：[routing.md](./.claude/rules/routing.md) / [ai-providers.md](./.claude/rules/ai-providers.md) / [persona.md](./.claude/rules/persona.md) / [env.md](./.claude/rules/env.md) / [scripts.md](./.claude/rules/scripts.md) / [deploy.md](./.claude/rules/deploy.md)

## License

尚未加上 license 檔。
