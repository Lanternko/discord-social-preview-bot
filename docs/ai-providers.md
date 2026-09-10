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

Per-user profiles in `data/user-profiles.json` ([user-profile-store.js](../src/user-profile-store.js)), built by [observation-extractor.js](../src/ai/observation-extractor.js). Flow: pending interactions → LLM 萃取 observations → LLM consolidation 成人格摘要. Log prefixes: `[observation-extractor]`, `[consolidate]`, `[backlog-sweep]`.

**Two intake paths, one Discord messageId each.** `direct` = the user @ed 西寶 and got an AI reply. `passive` = the user's line sat in the last 3 group-context rows when *someone else* triggered 西寶 (`getPersonalMemoryContextEntries` in chain.js). Dedup is **by messageId only, never by text** — repeating the same sentence across messages can itself be a trait; the same message scooped twice is the only certain duplicate. Backlog is capped at `PENDING_MAX_COUNT` (60, oldest dropped).

**Evidence is code-enforced, not LLM-trusted.** Extraction prompts number every pending row and tag it 【直接互動】/【旁聽片段】; the model must return `evidence: [編號]` per observation. `attachEvidence` resolves those to `{messageId, at, source}` records and caps confidence: no resolvable message → ≤0.3, single message → ≤0.4, passive-only evidence → ≤0.5. Same-text observations extracted in later batches merge and pool evidence (union by messageId), so a trait can *earn* stability over time.

**Stability bar** (`isStableObservation`): ≥3 distinct messageIds, or 2 distinct messageIds ≥6 h apart. Consolidation splits observations into 已達證據門檻 (may be stated in the profile) vs 證據不足 (must be ignored or hedged with 或許/有時 — never asserted). Both personas demand neutral behavioural wording and explicitly ban unsupported praise (靈魂人物/精準/擅長…).

**Profile format & old-vs-new weighting.** Consolidated profiles are field-per-line（`說話風格：…\n常聊話題：…\n互動偏好：…\n注意：…`，選填欄省略）; `setConsolidatedProfile` preserves the newlines and `buildUserProfileBlock` flattens them to `；` for prompt injection. The consolidation persona treats the existing profile as **舊印象**: new observations win on conflict, and evaluative sentences (praise *or* put-downs) with no surviving observation behind them get rewritten to behaviour or deleted — first impressions no longer anchor forever. 暱稱 is explicitly a Discord display name (joke decorations included), usable as a form of address only — never as「自稱」or trait evidence.

**One-shot migration** — [scripts/redistill-profiles.js](../scripts/redistill-profiles.js) rewrites all pre-existing profiles with the current persona (`--dry-run` to preview, `--guild <id>` to scope, `--all` to redo already-migrated). It must run **while the bot is stopped** (the bot's in-memory store cache clobbers outside writes on its next save) and refuses to start if a `src/index.js` process is visible; mind the watchdog cron before stopping the bot.

**Backlog sweep** ([profile-sweep.js](../src/ai/profile-sweep.js)). Extraction normally fires only on the user's own next successful AI reply — passively-scooped users would otherwise accumulate forever (the 30-筆 小翔 case, 2026-07-19). A timer (start +5 min, then every `PROFILE_SWEEP_INTERVAL_MS`, default 1 h, `0` disables) drains users whose backlog ≥ `EXTRACT_MIN_COUNT`: max 3 users per pass, skips anyone whose last pending row is <10 min old (mid-conversation), oldest `lastExtractedAt` first. Uses the same per-guild provider chain as live replies.

## Gemini billing trap

If a Google Cloud project has a billing account attached (even $300 free trial), the Gemini API free tier becomes `limit: 0`.

**Workaround**: create a new project **without billing** via AI Studio's "Create API key in new project" flow.

Groq has no equivalent trap — just sign up, create key, use it. DeepSeek is paid up-front, no trap either.

**Currently we use DeepSeek as primary**, so this trap only bites if the whole chain exhausts and someone tries to rely on Gemini alone.
