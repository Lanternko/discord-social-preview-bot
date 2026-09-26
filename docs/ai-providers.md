# AI Provider Architecture

## Entry point

`generateAIReply(message, userText)` in [src/ai/chain.js](../src/ai/chain.js) is the single entry point for `@西寶` AI replies. It builds a `userTurn` string via `buildUserTurn()` (from [src/ai/persona.js](../src/ai/persona.js)), resolves the guild's `/ai-tier`, builds a per-guild provider chain via `buildGuildChain()`, then iterates over that chain.

Provider implementations live in [src/ai/providers.js](../src/ai/providers.js); per-channel memory in [src/ai/memory.js](../src/ai/memory.js).

**First non-null reply wins.** On null/error, move to the next layer. Chain exhausted → returns `null` → mention handler falls back to hardcoded replies.

The chain is wrapped by a circuit breaker so a known-broken provider gets skipped (not re-called with an 8 s timeout) for the duration of its cooldown. See [Circuit breaker](#circuit-breaker) below.

## Per-guild chain

DeepSeek is selected per guild, then Kimi (when enabled) and the shared fallback chain are appended:

1. 入門 (`brief`) — `deepseek:<DEEPSEEK_MODEL_FREE>` using the owner `DEEPSEEK_API_KEY`, limited by `AI_FREE_DAILY_LIMIT` for guilds without `/ai-key` or whitelist.
2. 標準 / 精細 (`standard` / `detailed`) — `deepseek:<DEEPSEEK_MODEL>` using the guild `/ai-key`, or the owner key for `DEEPSEEK_PREMIUM_GUILD_IDS`.
3. `kimi:<KIMI_MODEL>` — second-choice provider; removed entirely when `KIMI_ENABLED=false`.
4. `groq:llama-3.3-70b-versatile` — fast backup, 100k tokens/day free.
5. `groq:llama-3.1-8b-instant` — Groq-internal fallback, 500k tokens/day free, lower quality.
6. `gemini:gemini-2.0-flash` — last resort, has billing trap history (see below).

### 尖峰時段降級（`AI_PEAK_PREFER_FALLBACK`，預設開）

DeepSeek 在自己的尖峰時段收**雙倍**價錢，所以尖峰期間**用 owner key 的 DeepSeek entry 會被移到鏈尾**，改由 flat-rate 的 fallback（luna）先跑。DeepSeek 沒有被移除——上面全掛了還是會打到它，只是不再是預設花錢的那一層。

- **時段以 UTC 為準**：`Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday`（[DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing)）。換算台北是平日 09:00–12:00 與 14:00–18:00，但實作**刻意不寫死本地時間**：計費依據是 UTC，寫成本地時間會在主機時區改變時無聲飄掉。判斷在 [src/ai/peak-hours.js](../src/ai/peak-hours.js)。
- **自帶 key 的 guild 不降級**。那把 key 是他們自己付錢、自己選 DeepSeek 的，尖峰加價是他們的決定，不是我們的成本。只有 owner key（入門 tier 的 flash、以及 `DEEPSEEK_PREMIUM_GUILD_IDS` 白名單的 pro）會被移到鏈尾。
- **降級期間不扣 `AI_FREE_DAILY_LIMIT`**。額度是用來付「我們真的打算打的呼叫」；entry 在鏈尾幾乎不會被叫到，先扣會把免費 guild 一天 20 次燒在什麼都沒發生上。代價是尖峰若真的一路 fallback 全掛、打到鏈尾的 DeepSeek，那次不計入當日額度——極罕見，用額度精準度換不浪費。
- log 只在**狀態切換時**各印一行（`[ai] deepseek peak window on/off`），不是每則回覆都印。
- 排程任務（daily recap / bedtime story / morning greeting）走的是 module-level 的 `AI_PROVIDER_CHAIN` / `STORY_PROVIDER_CHAIN`，**不受影響**；它們的排程時間（台北 08:00 / 19:00 / 22:00 → UTC 00:00 / 11:00 / 14:00）本來就全部落在離峰。

If a free guild has exhausted `AI_FREE_DAILY_LIMIT`, the DeepSeek entry is skipped and only Groq/Gemini fallbacks are tried. If no fallback keys are configured, chain exhaustion returns `null` and mention handling uses the hardcoded fallback reply.

## DeepSeek 現役 model（2026-09-21 實測）

`/models` 只剩兩個 id，舊的 `deepseek-chat`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 全數下架——這是 vision entry 長期 404、免費層打不到模型的真正原因。

| | `deepseek-flash`（V4.1-Flash） | `deepseek-v4-pro`（V4-Pro-0813） |
|---|---|---|
| 吃圖 | ✅ | ❌ |
| 價格（離峰 in/out，每 1M） | $0.15 / $0.60 | $0.66 / $1.98 |
| 實測延遲（同 persona、同題目） | 2.1 / 3.4 / 4.5 s | 15.5 / 24.8 / 39.4 s |
| prod 歷史（1105 次 v4-pro 呼叫） | — | 平均 20.4 s，**27% 超過 25 s 逾時線**（bot.log 有 188 次 deepseek timeout） |
| thinking | 預設開，可 `thinking:{type:"disabled"}` | 同左 |

**為什麼主力換成 flash（2026-09-21）**：v4-pro 的 39 s 那題在線上會直接撞 `AI_TIMEOUT_MS=25000` 逾時、掉到下一層，等於花了 pro 的錢拿 luna 的回答。品質方面重跑了當初讓 pro 勝出的「模仿語氣」題：這次**反而是 pro 照抄範例句**（原句 "欸不是/這個真的假的啦/但沒事了各位/懂?" 幾乎原封不動搬回來），flash 用同樣語氣造了新句子。當初的結論是拿 V3.2 的 `deepseek-chat` 比的，換代之後不成立了。要換回去只改 `.env` 一行 `DEEPSEEK_MODEL=deepseek-v4-pro`。

> 待辦（未做）：`AI_PEAK_PREFER_FALLBACK` 當初是為了避開 v4-pro 的尖峰成本才把 DeepSeek 移到鏈尾，flash 便宜 4 倍之後這個取捨值得重新評估。

## 圖片辨識（DeepSeek vision）

DeepSeek 2026-08-21 開的那個實驗性 endpoint `deepseek-v4-flash-vision-exp` 已經下架（2026-09-21 查 `/models` 只剩兩個 id），現在吃圖的是 **`deepseek-flash`**（V4.1-Flash；`deepseek-v4-pro` 純文字不吃圖）。實測 `thinking:{type:"disabled"}` 在 flash 上照樣有效，15 個 token 就正確描述完一張圖。（[docs](https://api-docs.deepseek.com/guides/vision/)）實作在 [src/ai/vision.js](../src/ai/vision.js)，鏈的組裝在 `buildVisionEntry`（[chain.js](../src/ai/chain.js)）。

**vision 是插在鏈頭，不是取代鏈。** 只有這個 endpoint 看得到圖，底下每一層都是瞎的，所以：

- 圖片以 OpenAI 相容的 content block（`{type:"image_url", image_url:{url}}`）掛在**最後一個 user turn** 上，而且只用 `overrides.images` 傳進 `callDeepSeek`——`turns` 本身永遠是純字串，否則同一個陣列丟給下游純文字 endpoint 會直接 400。
- **我們自己下載圖，送 base64 data URL，不把連結丟給 DeepSeek。** DeepSeek 是支援外部 URL，但它得自己去抓：實測（2026-09-10）連一個普通的公開圖片 URL 都回 `Failed to download image`，而 Discord CDN 連結還多了簽章與過期。連結路徑會用我們看不到也重試不了的方式壞掉。下載失敗 → 那張不送 → 全部失敗就等於沒有圖，退回瞎的文字鏈。
- **thinking 一律關（`thinking:{type:"disabled"}` + headroom 0）。** 實測同一張圖：thinking 開著時燒掉 300+ 個 `reasoning_content` token 然後回**空字串**；關掉之後 1.8 s 正確描述。看圖是用看的，不是用想的。
- 歷史 turn 不重掛圖：舊圖已經在她自己的回覆裡被描述過，重送等於每一輪重新計費。
- user turn 會多一行「附了 N 張圖片，但你這次看不到內容，別假裝看得到」的註記；vision entry 在送出前把它換成「內容就在下面」。**這行是給瞎的那幾層看的**——沒有它，模型會很開心地編出圖片內容。這行也會進短期記憶，所以她記得剛才有張她沒看到的圖。
- vision 模型死掉/改名 → 該次回覆退回瞎的文字鏈，聲音不變、只是看不到。Ops signal：`[vision] deepseek model=… images=N` 有出現但 `provider failed label=deepseek:…:vision`。

**圖片從哪來**：@ 她的那則訊息的附件；那則沒附件時，取**被回覆訊息**的附件——「@西寶 這張是什麼」去回覆別人的照片是最常見的送圖方式，而那則訊息自己一張圖都沒有。只吃 DeepSeek 支援的四種格式（jpeg/png/gif/webp），其他格式、超過 `VISION_MAX_BYTES` 的直接跳過（`[vision] skip oversized attachment`）。貼圖片**連結**（embed）目前不算。

**成本與時段**：一張圖最多 384 tokens、flash 費率。vision entry **尖峰也留在鏈頭**——`AI_PEAK_PREFER_FALLBACK` 是拿來省文字錢的，而再怎麼降級，瞎的 provider 也回答不了「這張是什麼」。但免費 guild 燒完 `AI_FREE_DAILY_LIMIT` 之後連 vision 也不給（額度就是用來擋 owner key 的花費，而圖是比較貴的那半）。

**timeout 另計**：`VISION_FETCH_TIMEOUT_MS`（10 s）管我們抓 Discord CDN 那段，`VISION_TIMEOUT_MS`（25 s）管送給 DeepSeek 那段——兩段網路加起來本來就不該塞進文字用的 `AI_TIMEOUT_MS`（8 s）。

## Call shape

- All providers use `withAbortTimeout()` for timeout + error handling.
- DeepSeek V4 defaults to thinking mode. `/voice` and daily recaps explicitly use the regular `high` thinking policy with reasoning headroom; voice requests therefore retain the provider's long-tail latency risk.
- DeepSeek + Groq share OpenAI-compatible format: `messages[]`, `Bearer` auth.
- Gemini uses its own REST shape: `contents[]`, `?key=`.
- Each provider call returns a result object: `{ ok: true, text }` on success, `{ ok: false, kind, ... }` on failure (`kind` ∈ `auth` / `rate_limit` / `timeout` / `network` / `server` / `queue_exceeded` / `empty` / `unknown`). Helpers `ok(text)` / `fail(kind, extra)` in [providers.js](../src/ai/providers.js).
- Any per-layer failure triggers the next layer — **bot never goes silent**.

## Circuit breaker

[src/ai/circuit.js](../src/ai/circuit.js) keeps a per-provider-label cooldown so the chain doesn't waste `AI_TIMEOUT_MS` (8 s) re-trying a known-broken provider on every mention.

**State** is `Map<label, { cooldownUntil, lastFailureKind, lastFailureAt, failCount }>`, in-memory, cleared on restart. Same lifetime model as `aiConversationHistory`.

**Cooldown by failure kind** (`getCooldownMs`):

| `kind` | Cooldown | Why |
|---|---|---|
| `auth` | 10 min | 401/403 — key likely revoked or wrong; don't hammer |
| `rate_limit` | `Retry-After` header (parsed by `parseRetryAfterMs`) → fallback 60 s | Honour what the API tells us |
| `timeout` / `network` / `server` | 60 s | Transient; one minute is enough for blip recovery |
| `queue_exceeded` | 30 s | Legacy provider-specific throttle; retained defensively |
| `empty` | 0 s (no cooldown) | Content issue (safety block / empty candidate), not a provider issue — let next call try again |
| anything else | 30 s | Defensive default |

**Where it's wired** — [src/ai/chain.js](../src/ai/chain.js) `runProviderChain`:

1. Before each provider call: `isProviderAvailable(label)`. If cooling, log `[ai] skip cooling-down provider=<label>` and continue to next.
2. After call: `recordProviderSuccess(label)` (clears state) on `{ ok: true }`; `recordProviderFailure(label, failure)` on `{ ok: false }`.

**Observability**:

- `[ai] skip cooling-down provider=<label>` — provider was skipped this call.
- `[ai] provider failed label=<...> kind=<...> cooldownMs=<N>` — cooldown was just set.
- `getCircuitSnapshot()` returns the current state for a future `/ai-status` slash command (not built yet).

**`empty` is intentional non-cooldown.** Safety blocks and empty model output are about *what was asked*, not about *the provider being unhealthy*. Cooling on `empty` would punish the next innocent caller and mask provider availability. Asserted by `scripts/smoke-ai-circuit.js` — see [scripts.md](scripts.md).

## Observability

Log prefix: `[ai]`.

- Startup: `[ai] chain=<a> → <b> → ... timeout=<ms>`
- Per reply: `[ai] used <provider>:<model> tier=<tier> premium=<bool> len=<chars> history_before=<N> group_ctx=<N> roster=<N> profile=<0|1>` (N = prior turns injected)
- Per call: `x-ratelimit-remaining-{tokens,requests}` from Groq/DeepSeek when provided (`logRateHeaders()`) — live quota drain.
- Chain exhausted: `[ai] chain exhausted (X providers tried), falling back to hardcoded reply` — **the ops signal** to grep for.

## Short-term conversation memory

`aiConversationHistory: Map<channelId, { turns: Array<{role, content}>, lastActivity }>` holds per-channel rolling history.

- `generateAIReply` reads via `getChannelAIHistory(channelId)` and prepends to the current user turn when building `messages[]` (OpenAI-compat) or `contents[]` (Gemini, via `buildGeminiContents` role mapping `assistant→model`).
- After a successful reply, both sides of the exchange are saved via `recordAITurn(channelId, role, content, maxTurns)` — `maxTurns` comes from the guild's tier config.
- Turns beyond `tierConfig.memoryMaxTurns * 2` entries are evicted from the head.
- Channels inactive beyond `AI_MEMORY_TTL_MS` are dropped by `cleanupAIConversationHistory()`.

### Eviction runs in two places

Avoids silent channels lingering in RAM forever:

1. **Lazy** — on every `getChannelAIHistory()` read.
2. **Periodic** — `setInterval(cleanupAIConversationHistory, AI_MEMORY_SWEEP_INTERVAL_MS)` where sweep = `max(60s, AI_MEMORY_TTL_MS/4)`. The interval is `.unref()`'d so it doesn't block process exit.

No persistence — restart clears everything.

## Long-term memory (evidence pipeline)

Per-user profiles in `data/user-profiles.json` ([user-profile-store.js](../src/user-profile-store.js)), built by [observation-extractor.js](../src/ai/observation-extractor.js). Flow: pending interactions → LLM 萃取 observations → LLM consolidation 成結構化條目. Log prefixes: `[observation-extractor]`, `[consolidate]`, `[backlog-sweep]`, `[alias]`.

**Two intake paths, one Discord messageId each.** `direct` = the user @ed 西寶 and got an AI reply. `passive` = the user's line sat in the last 3 group-context rows when *someone else* triggered 西寶 (`getPersonalMemoryContextEntries` in chain.js). Dedup is **by messageId only, never by text** — repeating the same sentence across messages can itself be a trait; the same message scooped twice is the only certain duplicate. Backlog is capped at `PENDING_MAX_COUNT` (60, oldest dropped).

**Evidence is code-enforced, not LLM-trusted.** Extraction prompts number every pending row and tag it 【直接互動】/【旁聽片段】; the model must return `evidence: [編號]` per observation. `attachEvidence` resolves those to `{messageId, at, source}` records and caps confidence: no resolvable message → ≤0.3, single message → ≤0.4, passive-only evidence → ≤0.5. Same-text observations extracted in later batches merge and pool evidence (union by messageId), so a trait can *earn* stability over time.

**Stability bar** (`isStableObservation`): ≥3 distinct messageIds, or 2 distinct messageIds ≥6 h apart. Consolidation splits observations into 已達證據門檻 (may be stated in the profile) vs 證據不足 (must be ignored or hedged with 或許/有時 — never asserted). Both personas demand neutral behavioural wording and explicitly ban unsupported praise (靈魂人物/精準/擅長…).

**Profile format: structured items, not prose.** A profile is `entry.items = {style, topics, interaction, notes}` (說話風格／常聊話題／互動偏好／注意, max 3/4/3/2). Each item is `{text ≤40字, evidence[], firstAt, lastSeenAt, tentative}`. `entry.profile` is still written — it's the rendered text (one field per line, items joined with `；`), kept for legacy readers and history. `buildUserProfileBlock` injects a nested dot list; `profileTextOf(entry)` is the one accessor for "the profile as text" (chain target enrichment, story ingredients).

**Provenance is code-enforced, like evidence.** The consolidation prompt numbers sources — `I*` = existing items (舊印象), `O*` = observations split into 已達證據門檻 / 證據不足 — and the model must return `{"items":[{"field","text","from":["I2","O5"]}]}`. `resolveConsolidatedItems` drops any item citing no known source, pools evidence from cited sources, and only advances `lastSeenAt` when a cited *observation* backs it — rewording an old item doesn't refresh it. `tentative` (rendered `（或許）`) is set by code when the pooled evidence isn't stable and every cited source was itself tentative; the persona is told not to write 或許 itself. `{"items":[]}` = keep the old profile.

**Theseus's ship: decay + history.** An item unconfirmed for `ITEM_STALE_MS` (120 d) is hidden at render time and dropped at the next consolidation — impressions must keep earning their place, first impressions can't anchor forever. New observations win on conflict; evaluative wording (praise *or* put-downs) and 西寶's own reactions are not traits. `profileHistory` keeps the last 5 rendered profiles (pushed only when the text changes) so drift is auditable. `/memory show` lists each item with its 佐證 count and 最後確認 date. 暱稱 is a Discord display name (joke decorations included) — a form of address only, never「自稱」or trait evidence.

**綽號 (aliases) — what other people call someone.** Display names are joke-decorated and often don't contain the name friends actually use (「峰哥」 for 「峰【…】」). [alias-extractor.js](../src/ai/alias-extractor.js) reuses the group-context rows a reply already fetched (no extra Discord call; rows carry raw `content` + `replyToUserId`), buffers them per guild in memory (≤80, dedup by messageId), and every 30 new lines asks the model for `{person: P#, alias, evidence: [L#]}` over a numbered roster and numbered lines. **The model only proposes; code decides** (`resolveAliasCandidates`): the alias must literally appear in a cited line, the speaker can't be the target, a line that replies to / tags someone *else* doesn't count, and pronouns / kinship terms (姐姐, 哥哥, 學長…) / 西寶's own names / anyone's display name verbatim are rejected — the 2026-09-27 real-chat probe had the model proposing 「姐姐」 (5 messages, would have confirmed) and 「西寶寶」 for humans. Stored on the profile entry as `aliases[{alias, evidence[{messageId, at, speakerId}], lastSeenAt}]`; **confirmed at ≥2 distinct messages**, ages out after 120 d like items. Confirmed aliases appear in the profile block (`群友常叫他：…`), the familiarity roster (`名字（群友叫：…）`), and imitation name matching (`nameMatchCandidates`); `/memory show` also lists unconfirmed ones.

**One-shot migration** — [scripts/redistill-profiles.js](../scripts/redistill-profiles.js) converts pre-items prose into items: each old clause becomes an `I*` source (`legacy`, no evidence, `lastSeenAt = profileAt` so it still ages; clauses the old text already hedged with 或許/可能/有時 stay tentative), and the model splits/cites them. Skips already-migrated entries unless `--all`; `--dry-run` to preview old vs new, `--guild <id>` to scope. It must run **while the bot is stopped** (the bot's in-memory store cache clobbers outside writes on its next save) and refuses to start if a `src/index.js` process is visible; mind the watchdog cron before stopping the bot.

**Backlog sweep** ([profile-sweep.js](../src/ai/profile-sweep.js)). Extraction normally fires only on the user's own next successful AI reply — passively-scooped users would otherwise accumulate forever (the 30-筆 小翔 case, 2026-07-19). A timer (start +5 min, then every `PROFILE_SWEEP_INTERVAL_MS`, default 1 h, `0` disables) drains users whose backlog ≥ `EXTRACT_MIN_COUNT`: max 3 users per pass, skips anyone whose last pending row is <10 min old (mid-conversation), oldest `lastExtractedAt` first. Uses the same per-guild provider chain as live replies.

## Gemini billing trap

If a Google Cloud project has a billing account attached (even $300 free trial), the Gemini API free tier becomes `limit: 0`.

**Workaround**: create a new project **without billing** via AI Studio's "Create API key in new project" flow.

Groq has no equivalent trap — just sign up, create key, use it. DeepSeek is paid up-front, no trap either.

**Currently we use DeepSeek as primary**, so this trap only bites if the whole chain exhausts and someone tries to rely on Gemini alone.
