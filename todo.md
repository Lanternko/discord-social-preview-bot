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
