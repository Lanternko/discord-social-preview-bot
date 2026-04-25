# AI Provider Architecture

## Entry point

`generateAIReply(message, userText)` in [src/ai/chain.js](../../src/ai/chain.js) is the single entry point for `@西寶` AI replies. It builds a `userTurn` string via `buildUserTurn()` (from [src/ai/persona.js](../../src/ai/persona.js)), then iterates over `AI_PROVIDER_CHAIN` (built once at module load by `buildAIProviderChain()`).

Provider implementations live in [src/ai/providers.js](../../src/ai/providers.js); per-channel memory in [src/ai/memory.js](../../src/ai/memory.js).

**First non-null reply wins.** On null/error, move to the next layer. Chain exhausted → returns `null` → mention handler falls back to hardcoded replies.

The chain is wrapped by a circuit breaker so a known-broken provider gets skipped (not re-called with an 8 s timeout) for the duration of its cooldown. See [Circuit breaker](#circuit-breaker) below.

## Default chain (when all keys set)

Ordered paid-first → free-quality → fallback:

1. `deepseek:deepseek-chat` — paid V3.2, reliable, no queue, flagship Chinese
2. `cerebras:qwen-3-235b-a22b-instruct-2507` — Qwen 235B free 1M TPD, but `queue_exceeded` common
3. `groq:llama-3.3-70b-versatile` — fast backup, 100k tokens/day free
4. `groq:llama-3.1-8b-instant` — Groq-internal fallback, 500k tokens/day free — lower quality
5. `gemini:gemini-2.0-flash` — last resort, has billing trap history (see below)

## Call shape

- All providers use `withAbortTimeout()` for timeout + error handling.
- Groq + Cerebras share OpenAI-compatible format: `messages[]`, `Bearer` auth.
- Gemini uses its own REST shape: `contents[]`, `?key=`.
- Each provider call returns a result object: `{ ok: true, text }` on success, `{ ok: false, kind, ... }` on failure (`kind` ∈ `auth` / `rate_limit` / `timeout` / `network` / `server` / `queue_exceeded` / `empty` / `unknown`). Helpers `ok(text)` / `fail(kind, extra)` in [providers.js](../../src/ai/providers.js).
- Any per-layer failure triggers the next layer — **bot never goes silent**.

## Circuit breaker

[src/ai/circuit.js](../../src/ai/circuit.js) keeps a per-provider-label cooldown so the chain doesn't waste `AI_TIMEOUT_MS` (8 s) re-trying a known-broken provider on every mention.

**State** is `Map<label, { cooldownUntil, lastFailureKind, lastFailureAt, failCount }>`, in-memory, cleared on restart. Same lifetime model as `aiConversationHistory`.

**Cooldown by failure kind** (`getCooldownMs`):

| `kind` | Cooldown | Why |
|---|---|---|
| `auth` | 10 min | 401/403 — key likely revoked or wrong; don't hammer |
| `rate_limit` | `Retry-After` header (parsed by `parseRetryAfterMs`) → fallback 60 s | Honour what the API tells us |
| `timeout` / `network` / `server` | 60 s | Transient; one minute is enough for blip recovery |
| `queue_exceeded` | 30 s | Cerebras-specific; queue clears fast |
| `empty` | 0 s (no cooldown) | Content issue (safety block / empty candidate), not a provider issue — let next call try again |
| anything else | 30 s | Defensive default |

**Where it's wired** — [src/ai/chain.js](../../src/ai/chain.js) `runProviderChain`:

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
- Per reply: `[ai] used <provider>:<model> len=<chars> history_before=<N>` (N = prior turns injected)
- Per call: `x-ratelimit-remaining-{tokens,requests}` from Groq/Cerebras (`logRateHeaders()`) — live quota drain.
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

## Gemini billing trap

If a Google Cloud project has a billing account attached (even $300 free trial), the Gemini API free tier becomes `limit: 0`.

**Workaround**: create a new project **without billing** via AI Studio's "Create API key in new project" flow.

Groq + Cerebras have no equivalent trap — just sign up, create key, use it. DeepSeek is paid up-front, no trap either.

**Currently we use DeepSeek as primary**, so this trap only bites if the whole chain exhausts and someone tries to rely on Gemini alone.
