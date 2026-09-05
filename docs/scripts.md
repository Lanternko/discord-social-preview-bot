# Smoke tests

Three self-contained Node scripts under [scripts/](../scripts/). No Jest, no Mocha — each script is `node scripts/<name>.js`, exits non-zero on any failure. They share one stub: `process.env.DISCORD_TOKEN = "smoke-dummy"` so `src/config.js` doesn't crash on import.

Why three layers and not one: pure-function tests can't reach payload-builder branch order, and payload-builder tests can't reach AI chain behaviour. Each layer plugs a different blind spot.

## `npm test` runs all three

```bash
npm test            # all three, sequentially, fail-fast
npm run test:pure   # scripts/smoke.js
npm run test:routing # scripts/routing-smoke.js
npm run test:circuit # scripts/smoke-ai-circuit.js
```

## scripts/smoke.js — pure functions

Fastest layer (no I/O, no mocks). Covers everything that takes plain values in and returns plain values out.

| What it covers | Module |
|---|---|
| `normalizeUrl` strips universal + host-gated tracking params | [url-routing.js](../src/url-routing.js) |
| `extractSupportedUrls` filters & dedups | [url-routing.js](../src/url-routing.js) |
| `replaceHostFixer` / `buildFallbackUrl` | [url-routing.js](../src/url-routing.js) |
| `isThreadsUrl` / `isInstagramUrl` / `isInstagramStoryUrl` / `extractInstagramStoryOwner` / `isBilibiliUrl` / `isBahamutUrl` / `isPttUrl` / `extractBilibiliBvid` | [url-routing.js](../src/url-routing.js) |
| `shouldIgnoreMessage` (bot author + ignore markers) | [url-routing.js](../src/url-routing.js) |
| `trimDescription` / `pickRandom` | [utils.js](../src/utils.js) |
| `buildUserTurn` (`<sender name="..."/>` wrapping, name fallback ladder, empty-text placeholder) | [ai/persona.js](../src/ai/persona.js) |
| `buildOpenAIMessages` / `buildGeminiContents` (role mapping `assistant→model`) | [ai/persona.js](../src/ai/persona.js) |
| `formatGroupMessage` / `buildGroupContextBlock` (group-context formatting) | [ai/group-context.js](../src/ai/group-context.js) |
| `isValidTier` | [tier-store.js](../src/tier-store.js) |
| `buildPersonaFromTemplate` placeholder substitution | [tier-config.js](../src/tier-config.js) |
| `getTierConfig` defaults to `brief` for missing guildId | [tier-config.js](../src/tier-config.js) |
| `parseOgFromHtml` extracts og:* / twitter:* / `<title>` (incl. reverse attr order, HTML entities) | [og-fallback.js](../src/og-fallback.js) |
| `decodeHtmlEntities` covers named + decimal + hex entities | [og-fallback.js](../src/og-fallback.js) |
| `hasUsefulMetadata` / `buildGenericFallbackEmbed` | [og-fallback.js](../src/og-fallback.js) |
| `buildFallbackUrl` `redd.it` / `old.reddit.com` route to `rxddit` (regression) | [url-routing.js](../src/url-routing.js) |
| `isTrashEmoji` matches 🗑️ with/without the FE0F variation selector | [reaction-delete.js](../src/reaction-delete.js) |

**When to run**: every refactor touching URL handling, persona/template wiring, tier lookup, or group-context formatting. Cheap enough to run on every save.

## scripts/routing-smoke.js — payload builders with mocked probe

Mocks [probe.js](../src/probe.js) `fetchThreadsMetadata` / `fetchPageProbeMetadata` and `global.fetch` (for Bilibili API + b23.tv expansion + Instagram display-name probe), then asserts the shape of the payload returned by each builder.

**Why this layer exists**: in PR #15 a Threads `if`-ladder reorder slipped past pure-function smoke twice — pure tests don't reach `buildThreadsPayload` and there's no way to test branch order without simulating probe metadata.

Branches covered:

- **Threads** — text-only / `twitterCard=summary` with image / multi-image (3 / 5+ / fallback when `imageCount > images.length`) / **MIXED** (multi-image AND video → carousel wins, NOT video fixer — the regression hard-assert) / video-only / **VIDEO-NO-IMAGE** (video with `image=null` MUST still route to fixer chain — regression hard-assert) / single image / generic fallback / probe error (now exposes secondary fixer + `recoverUrls`).
- **Bahamut** — normal / restricted with public title/desc → embed with login notice / restricted with no usable metadata → fixer fallback / probe error.
- **PTT** — normal / probe error.
- **Instagram** — post (primary fixer + `fallbackContent` + `embedFallback` + `recoverUrls`) / story with display-name probe failure / story with display-name probe success.
- **Bilibili** — API success → custom embed (no URL) **+ `videoAttachment`** (media.vxbilibili mp4 constructed from the BVID, MIXED-style playable video) / API failure → vxbilibili URL with `recoverUrls`.
- **Preview dispatcher** ([preview.js](../src/preview.js)) — twitter / **redd.it short** / pixiv / bluesky / facebook all carry `recoverUrls` + `sourceUrl`; multi-URL parallel preserves order.
- **Sticker send** ([mention.js](../src/mention.js) `sendAIReply`) — the `[貼圖:名字]` → outgoing-payload matrix with a mocked `message.reply`: guild sticker → `stickers:[id]` + surviving text / library sticker → `files:[…]` with **no** content / plain reply untouched / a failed sticker send retries text-only (the reply must survive) / an invented name never reaches the channel / a reply that was *only* a bad token falls back to a spoken line. Lives here because the decision is about which send shape goes out, not about a pure return value.
- **Reaction delete** ([reaction-delete.js](../src/reaction-delete.js)) — `handleReactionDelete` authorization matrix with mocked Discord objects (fetchReference / member fetch / permissionsFor): link poster deletes / random user can't / `ManageMessages` mod can / never deletes a non-西寶 message / ignores non-🗑️ / ignores bot reactors. Lives here (not pure smoke) because the auth path needs async Discord I/O.

**When to run**: any reorder of the `if` ladder in `buildThreadsPayload`, any change to `buildPreviewPayloads` dispatch order, any new branch in a platform builder, or any change to `reaction-delete.js` authorization.

## scripts/smoke-ai-circuit.js — AI chain + circuit breaker

Pure unit tests for the AI subsystem's contract — no real provider calls, builds fake `chain` arrays with stubbed `call` functions and asserts state transitions.

Covered:

- `parseRetryAfterMs` — integer seconds, fractional seconds (floor), HTTP-date, missing header, garbage value.
- `ok(text)` / `fail(kind, extra)` result helpers.
- `getCooldownMs` per `kind` (auth 10 min, rate_limit honours retryAfterMs, timeout/network/server 60 s, queue_exceeded 30 s, **empty 0 ms**, unknown 30 s).
- `isProviderAvailable` / `recordProviderSuccess` / `recordProviderFailure` state transitions, `failCount` increments, `cooldownRemainingMs`.
- `runProviderChain` — first ok wins; cooling-down provider is skipped; failure cascades to next provider; chain-all-fail returns `null`; chain-all-cooling returns `null` *and calls nothing*; `empty` failure does NOT cool the provider (still callable next call).

**When to run**: any change to `chain.js`, `circuit.js`, `providers.js` failure classification, or the `ok` / `fail` shape.

## What none of these cover

- Real network calls (DeepSeek / Groq / Gemini, fixer hosts, Discord gateway).
- Discord permission edge cases — exercised manually via the `/debug-perms` command.
- Playwright probe behaviour against real Threads / Bahamut / PTT pages — exercised manually before merging probe changes.

## scripts/app-emoji.js — 素材庫管理（not a test）

Manages 西寶's application-owned emoji library (the 2000-slot one that doesn't touch any server's 50-100 emoji budget). Talks REST only — no gateway login, so it's safe to run while the bot is up.

```bash
node scripts/app-emoji.js list                          # 現有 emoji + 用途推導結果
node scripts/app-emoji.js upload assets/emoji/          # 整個資料夾
node scripts/app-emoji.js upload a.png b.gif --dry-run  # 先看會發生什麼
node scripts/app-emoji.js delete Pepe_Cry
```

Filenames become emoji names (`[A-Za-z0-9_]`, 2-32 chars), ≤256 KB each, existing names are skipped. It warns on any name `emotionForName` can't read a meaning from — those emoji fall out of 西寶's prompt table after the 30-day 【新】 window. **Restart the bot** after an upload; the app-emoji cache is fetched once at `clientReady`. See [persona.md](persona.md).

If a regression slipped past all three smokes, the right move is usually adding a case to one of them — not adding a fourth script. Keep the count to three.
