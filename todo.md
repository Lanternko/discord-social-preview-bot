# TODO

Deferred work with design decisions already aligned. Pick up after blockers clear.

---

## 西寶 AI 分級（`/ai-tier` 斜線指令）

**狀態**：Phase 1+2 完成 — infra + `/ai-tier` 指令 + `/ai-key` per-guild key 管理 + persona overlay + group context + per-category sentence ranges 已落地。Persona 已從 A–G rule-stack 重構為 narrative-driven（2026-05-30），per-category 句數 placeholder 不再使用但保留向後相容。**未做**：vision 分支（精細 + 圖片 → Gemini）。

### 三層 AI 方案（current values in `tier-config.js`）

| Tier | turns | max chars | group context | Vision |
|---|---|---|---|---|
| `入門`（預設） | 8 | 300 | ✗ | ✗ |
| `標準` | 40 | 1200 | recent 15 non-bot msgs | ✗ |
| `精細` | 60 | 2000 | recent 15 non-bot msgs | ✓（planned） |

### 已對齊的決策

1. **作用範圍**：per-guild + `ManageGuild` only for switching。整個 guild 共用一個 AI 方案；所有成員都能用 `/ai-tier` 查看，只有具管理伺服器權限的成員可以切換。
2. **持久化**：`data/tier-settings.json`（形如 `{ guildId: "brief" | "standard" | "detailed" }`）。重啟後要讀回。
3. **群組對話脈絡（標準 / 精細）**：抓最近 15 則非 bot 訊息，作為當次 user-role context 注入，不記進短期 conversation memory。

### 實作提醒

- **Vision provider 現況（2026-04 已查證）**：`api.deepseek.com` 僅開放 `deepseek-chat` / `deepseek-reasoner`，兩者皆純文字。`DeepSeek-VL2` 只有 HuggingFace weights，需自架或走 Replicate / Clarifai 這類第三方 hosting（另一組 key + 另一筆費用，收益不大）。**精細 tier 有圖時一律走 Gemini**；Gemini 掛 = 該訊息 fallback 到純文字 DeepSeek，或直接 hardcoded reply。
- **成本監控**：精細 tier 會讓 DeepSeek 月帳單明顯上升（context 拉長 + 圖片 token 貴）。實作時加一條 `[ai]` log 追蹤。
- **Vision fallback 鏈極短**：有圖訊息只有 Gemini 一層，掛了就退回純文字 DeepSeek 或 hardcoded reply。使用者已知且接受。
