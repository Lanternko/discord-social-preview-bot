# TODO

Deferred work with design decisions already aligned. Pick up after blockers clear.

---

## 西寶人格分級（`/tier` 斜線指令）

**狀態**：暫緩。等 `refactor/split-index-modules` 合回 `main` 後再開分支動工。

**Why deferred**：功能會動到 `src/ai/` 幾乎所有檔案（persona、memory、chain、providers），在 refactor 合併前開工會造成兩個大 branch 互相 rebase 地獄。

### 三層 tier

| Tier | turns | max chars | 模型鏈 | Vision |
|---|---|---|---|---|
| `簡短`（預設） | 8 | 300 | 現況免費鏈（Cerebras / Groq / Gemini） | ✗ |
| `標準` | ~20 | 600 | 優先 DeepSeek | ✗ |
| `精細` | ~40 | 1200 | 文字走 DeepSeek；含圖片走 Gemini | ✓（Gemini only） |

### 已對齊的決策

1. **作用範圍**：per-guild + admin only。整個 guild 共用一個 tier，只有具 admin 權限的成員可以用 `/tier` 切換。
2. **持久化**：`data/tier-settings.json`（形如 `{ guildId: "簡短" | "標準" | "精細" }`）。重啟後要讀回。
3. **群組對話記憶（精細模式獨有）**：只記住部分，不吃頻道全部訊息。具體策略（候選：最近 bot 發言那條 thread / 最近 N 則非 bot 訊息 / 有被 reply 的訊息）**實作前再與使用者確認**。

### 實作提醒

- **Vision provider 現況（2026-04 已查證）**：`api.deepseek.com` 僅開放 `deepseek-chat` / `deepseek-reasoner`，兩者皆純文字。`DeepSeek-VL2` 只有 HuggingFace weights，需自架或走 Replicate / Clarifai 這類第三方 hosting（另一組 key + 另一筆費用，收益不大）。**精細 tier 有圖時一律走 Gemini**；Gemini 掛 = 該訊息 fallback 到純文字 DeepSeek，或直接 hardcoded reply。
- **Tier 切換不該動全域常數**：`AI_MEMORY_MAX_TURNS` / `AI_MAX_REPLY_CHARS` 現在是 [src/config.js](src/config.js) 的 config 常數；要改成可以 per-guild 覆寫的查表函式。
- **成本監控**：精細 tier 會讓 DeepSeek 月帳單明顯上升（context 拉長 + 圖片 token 貴）。實作時加一條 `[ai]` log 追蹤。
- **Vision fallback 鏈極短**：有圖訊息只有 Gemini 一層，掛了就退回純文字 DeepSeek 或 hardcoded reply。使用者已知且接受。

---

## AI chain circuit breaker（失敗快取）

**狀態**：想法階段，未開工。

**動機**：目前 `AI_PROVIDER_CHAIN` 每次呼叫都從最高優先級開始試，某層壞掉時會持續浪費 `AI_TIMEOUT_MS`（8s）才進下一層。例如 Cerebras `queue_exceeded` 期間，每次 mention 都要多等 8 秒。

### 設計方向（對齊）

- **時間窗**，不是次數制。次數制在低流量頻道會鎖在較差的 provider 上好幾小時。
- **per-provider 狀態 Map**：`{ nextRetryAt, consecutiveFails }`，in-memory（跟 `aiConversationHistory` 一致，重啟清掉）。
- **失敗分類冷卻**：
  - `401/403`（key 失效）→ 冷卻久一點，甚至 runtime 關閉該層
  - `queue_exceeded` / `timeout` / 5xx → 冷卻 30–60 秒
  - 空 candidate / 安全阻擋 → 不冷卻（這是內容問題不是 provider 問題）
- **Observability**：`[ai] skipping <provider>:<model> (cooldown Xs remaining, reason=<...>)`

### 待決定

- 連續失敗次數是否拉長冷卻（指數退避 vs 固定 60s）
- 是否要一個 `/ai-status` 斜線指令查目前各層狀態（debug 用）

---

## 多圖預覽預設只顯示 3 張

**狀態**：想法階段，未開工。

**動機**：Threads / 其他平台多圖貼文現在全部攤平在 embed 裡，訊息很長佔頻道空間。

### 設計方向（待對齊）

- 預設只顯示前 3 張圖 + 「還有 N 張」提示
- 提供按鈕（`Open on X` 風格）點開看全部，或直接連到原貼文
- Discord 單則 message 最多 10 張 embed image 的硬限制還是存在，這個是 UX 限制不是技術限制

### 待決定

- 「點開看全部」是：（a）編輯原訊息展開全部 embeds、（b）跳轉到原貼文、（c）發 ephemeral follow-up 給點擊者？
- 影響範圍：Threads 多圖 branch、其他平台目前是交給 fixer 處理不會受影響——確認一下 Bahamut / PTT probe 有沒有自組多圖 embed 的路徑
- 3 張這個預設值是否要可調（env var `MULTI_IMAGE_PREVIEW_COUNT`）
