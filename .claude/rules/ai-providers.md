# AI Provider Architecture

## Entry point

`generateAIReply(message, userText)` in [src/ai/chain.js](../../src/ai/chain.js) is the single entry point for `@西寶` AI replies. It builds a `userTurn` string via `buildUserTurn()` (from [src/ai/persona.js](../../src/ai/persona.js)), then iterates over `AI_PROVIDER_CHAIN` (built once at module load by `buildAIProviderChain()`).

Provider implementations live in [src/ai/providers.js](../../src/ai/providers.js); per-channel memory in [src/ai/memory.js](../../src/ai/memory.js).

**First non-null reply wins.** On null/error, move to the next layer. Chain exhausted → returns `null` → mention handler falls back to hardcoded replies.

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
- Any per-layer failure (network, timeout, HTTP error, safety block, empty candidate) returns `null` and triggers the next layer — **bot never goes silent**.

## Observability

Log prefix: `[ai]`.

- Startup: `[ai] chain=<a> → <b> → ... timeout=<ms>`
- Per reply: `[ai] used <provider>:<model> len=<chars> history_before=<N>` (N = prior turns injected)
- Per call: `x-ratelimit-remaining-{tokens,requests}` from Groq/Cerebras (`logRateHeaders()`) — live quota drain.
- Chain exhausted: `[ai] chain exhausted (X providers tried), falling back to hardcoded reply` — **the ops signal** to grep for.

## Short-term conversation memory

`aiConversationHistory: Map<channelId, { turns: Array<{role, content}>, lastActivity }>` holds per-channel rolling history.

- `generateAIReply` reads via `getChannelAIHistory(channelId)` and prepends to the current user turn when building `messages[]` (OpenAI-compat) or `contents[]` (Gemini, via `buildGeminiContents` role mapping `assistant→model`).
- After a successful reply, both sides of the exchange are saved via `recordAITurn(channelId, role, content)`.
- Turns beyond `AI_MEMORY_MAX_TURNS * 2` entries are evicted from the head.
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
