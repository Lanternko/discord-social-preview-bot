# Architecture

CommonJS modules under `src/`. Entry point is [src/index.js](../../src/index.js); everything else is a focused module.

## Module groups

- **Bootstrap** — [index.js](../../src/index.js) wires Discord client, intents, and the `messageCreate` dispatcher. ~150 lines, no business logic of its own.
- **Config** — [config.js](../../src/config.js) reads every env var and exports the constants (`FIXER_*`, `AI_*`, timeouts, default persona). One source of truth; nothing else touches `process.env`.
- **URL plumbing** — [url-routing.js](../../src/url-routing.js) handles host sets, `normalizeUrl`, `extractSupportedUrls`, `isXxxUrl` predicates, and `replaceHostFixer` / `buildFallbackUrl`. [utils.js](../../src/utils.js) holds `trimDescription` / `pickRandom`.
- **Probe** — [probe.js](../../src/probe.js) wraps the Playwright subprocess via `execFile` and caches Threads metadata. The actual browser code lives in [threads-probe.cjs](../../src/threads-probe.cjs) — kept CommonJS because it must run in its own process (Playwright's `chromium.launch` blocks the Discord event loop).
- **Embeds** — [embeds.js](../../src/embeds.js) is the single home for `EmbedBuilder` factories (Threads / Bahamut / PTT / Bilibili).
- **OG fallback** — [og-fallback.js](../../src/og-fallback.js) is the lightweight HTTP fetch + OG meta parser, plus a generic embed builder. Used by `checkAndHandleEmptyEmbeds` as the last layer before delete. No Playwright — plain `fetch` + regex over `<head>`. Streams responses with a `</head>` early-bail to keep latency low.
- **Platforms** — [platforms/](../../src/platforms/) holds one builder per platform (`threads.js`, `instagram.js`, `bilibili.js`, `bahamut.js`, `ptt.js`). Each returns a `{ content?, embeds?, fallbackContent?, embedFallback?, recoverUrls?, recoverEmbedOptions?, sourceUrl? }` payload. `recoverUrls` is the OG-fallback layer — list of URLs whose HTML to fetch + parse for OG tags when both primary and secondary fixer unfurl empty.
- **Preview dispatcher** — [preview.js](../../src/preview.js) `buildPreviewPayloads` runs all per-URL builders in parallel via `Promise.all`. Per-platform branches dispatch to the correct builder; URL-only platforms (X/Reddit/Pixiv/Bluesky/Facebook) all share `buildSimpleFixerPayload` which always populates `recoverUrls`. The `if` ladder inside each platform builder is what's load-bearing — see [routing.md](routing.md).
- **Discord I/O** — [discord-io.js](../../src/discord-io.js) handles send/suppress/empty-embed/dedup state/permissions.
- **Mention** — [mention.js](../../src/mention.js) is the `@西寶` dispatcher (抽籤 / 道歉 / AI / hardcoded fallback). See [persona.md](persona.md).
- **Slash commands** — [commands.js](../../src/commands.js) registers and handles `/servers`, `/debug-perms`, `/tier`. [tier-store.js](../../src/tier-store.js) persists `/tier` to `data/tier-settings.json`; [tier-config.js](../../src/tier-config.js) does lookup + persona overlay (`getTierConfig(guildId)`).
- **AI subsystem** — [ai/](../../src/ai/) is its own world. See [ai-providers.md](ai-providers.md) for the chain shape and circuit breaker.

## src/ai/

- [persona.js](../../src/ai/persona.js) — `AI_PERSONA` template + `buildUserTurn` + OpenAI/Gemini message format helpers.
- [memory.js](../../src/ai/memory.js) — per-channel conversation history + sweep timer.
- [providers.js](../../src/ai/providers.js) — `callDeepSeek` / `callGroq` / `callCerebras` / `callGemini` + `withAbortTimeout` + `parseRetryAfterMs` + `ok` / `fail` result helpers.
- [circuit.js](../../src/ai/circuit.js) — provider circuit breaker (`isProviderAvailable` / `recordProviderFailure` / cooldown lookup). Stops the chain from re-trying a known-broken provider every call.
- [group-context.js](../../src/ai/group-context.js) — fetches recent non-bot messages and formats them into a `## 最近群組對話` block injected into the system prompt for `standard` / `detailed` tiers.
- [chain.js](../../src/ai/chain.js) — `buildAIProviderChain` + `runProviderChain` + `generateAIReply`. Single entry point for `@西寶` AI replies.

## src/ tree (full)

```
src/
├── index.js              # Client init, event handlers, dispatcher (~150 lines)
├── config.js             # All env vars + constants
├── url-routing.js        # Host sets, normalizeUrl, extractSupportedUrls, isXxxUrl, fixers
├── utils.js              # trimDescription, pickRandom
├── probe.js              # Playwright subprocess wrapper + Threads metadata cache
├── embeds.js             # All EmbedBuilder factories
├── platforms/
│   ├── threads.js        # buildThreadsPayload — multi-image, video, single, fallback
│   ├── instagram.js      # buildInstagramPayload — story owner detection + ddinstagram
│   ├── bilibili.js       # buildBilibiliPayload — b23.tv expansion + vxbilibili
│   ├── bahamut.js        # buildBahamutPayload — playwright probe + custom embed
│   └── ptt.js            # buildPttPayload — playwright probe + custom embed
├── preview.js            # buildPreviewPayloads — top-level platform dispatcher
├── discord-io.js         # send/suppress/empty-embed/dedup state/permissions
├── ai/
│   ├── persona.js        # AI_PERSONA + buildUserTurn + message format helpers
│   ├── memory.js         # Per-channel conversation history + sweep timer
│   ├── providers.js      # callDeepSeek/callGroq/callCerebras/callGemini + ok/fail/parseRetryAfterMs
│   ├── circuit.js        # Per-provider cooldown state (isProviderAvailable / recordProviderFailure)
│   ├── group-context.js  # Recent non-bot messages → system-prompt block (standard/detailed tiers)
│   └── chain.js          # buildAIProviderChain + runProviderChain + generateAIReply
├── mention.js            # @西寶 dispatcher (抽籤 / 道歉 / AI / hardcoded fallback)
├── commands.js           # Slash commands (/servers, /debug-perms, /tier)
├── tier-store.js         # Per-guild /tier persistence (data/tier-settings.json)
├── tier-config.js        # Tier lookup + persona overlay — getTierConfig(guildId)
└── threads-probe.cjs     # Playwright subprocess (CJS — runs in own process)
```

## Log prefixes

All scoped — grep one to isolate a subsystem:

`[preview]` · `[threads-meta]` · `[ai]` · `[group-context]` · `[probe]` · `[permissions]` · `[mention]` · `[commands]`

## Smoke tests

Three layers, all in [scripts/](../../scripts/) — see [scripts.md](scripts.md):

- `scripts/smoke.js` — pure functions (URL routing, persona, group-context formatting, tier lookup).
- `scripts/routing-smoke.js` — platform payload builders with mocked probe (catches Threads branch-order regressions).
- `scripts/smoke-ai-circuit.js` — AI provider chain + circuit breaker behaviour.

Run all three with `npm test`.
