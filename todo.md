# TODO

Deferred work with design decisions already aligned. Pick up after blockers clear.

---

## 西寶人格分級（`/tier` 斜線指令）

**狀態**：Phase 1 完成（`feat/tier-system`）— infra + `/tier` 指令 + persona overlay 已落地，brief/standard/detailed 實際會影響回覆字數、記憶深度、句數 cap。**Phase 2 未做**：精細 tier 的群組 context 收集（最近 15 則非 bot 訊息）、vision 分支（detailed + 圖片 → Gemini）。

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

## Threads `hasVideo` log 印出 URL 而不是 boolean

**狀態**：想法階段，未開工。小 cosmetic bug，1 行修。

**動機**：multi-image + video 混合貼文的 log 會印成這樣：

```
[preview] threads-multi-image carousel count=9 hasVideo=https://scontent-tpe1-1.cdn.../mp4?params... https://www.threads.com/...
```

`hasVideo=` 後面是整串 video URL 而不是 `true`/`false`。

**Root cause**：[src/platforms/threads.js](src/platforms/threads.js)

```js
const hasVideo = metadata.video || metadata.videoCount > 0;
```

當 `metadata.video` 是 URL 字串時，`||` short-circuit 回傳 URL 本身而不是 boolean。

**影響**：純 cosmetic — URL 是 truthy，後續 `if (allImages)` 判斷不受影響，功能完全正常。只是 log 很醜、grep 不好抓。

**修法**：

```js
const hasVideo = Boolean(metadata.video) || metadata.videoCount > 0;
```

**歷史**：這條是 PR #12 (`feat/threads-multi-image-priority`) 合進 main 時就有的 bug，不是 refactor 引入的。2026-04-19 lab shadow deploy 時從 bot.log 發現。
