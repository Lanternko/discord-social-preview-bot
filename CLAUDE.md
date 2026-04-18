# Discord Social Preview Bot

A Discord bot that intercepts social media links (Threads, Instagram, X, Reddit, Pixiv, Bluesky, Bilibili, Facebook, Bahamut, PTT) and replies with rich previews. Also hosts a `@西寶` AI personality.

## Architecture

CommonJS modules under `src/`. Entry point is `src/index.js`; everything else is a focused module.

```
src/
├── index.js              # Client init, event handlers, dispatcher (~150 lines)
├── config.js             # All env vars + constants (FIXER_*, AI_*, timeouts, persona)
├── url-routing.js        # Host sets, normalizeUrl, extractSupportedUrls, isXxxUrl, fixers
├── utils.js              # trimDescription, pickRandom
├── probe.js              # Playwright subprocess wrapper + Threads metadata cache
├── embeds.js             # All EmbedBuilder factories (Threads / Bahamut / PTT / Bilibili)
├── platforms/
│   ├── threads.js        # buildThreadsPayload — multi-image, video, single, fallback dispatch
│   ├── instagram.js      # buildInstagramPayload — story owner detection + ddinstagram fixer
│   ├── bilibili.js       # buildBilibiliPayload — b23.tv expansion + vxbilibili fixer
│   ├── bahamut.js        # buildBahamutPayload — playwright probe + custom embed
│   └── ptt.js            # buildPttPayload — playwright probe + custom embed
├── preview.js            # buildPreviewPayloads — top-level platform dispatcher
├── discord-io.js         # send/suppress/empty-embed/dedup state/permissions
├── ai/
│   ├── persona.js        # AI_PERSONA + buildUserTurn + OpenAI/Gemini message format helpers
│   ├── memory.js         # Per-channel conversation history + sweep timer
│   ├── providers.js      # callDeepSeek/callGroq/callCerebras/callGemini + withAbortTimeout
│   └── chain.js          # buildAIProviderChain + generateAIReply
├── mention.js            # @西寶 dispatcher (抽籤 / 道歉 / AI / hardcoded fallback)
├── commands.js           # Slash commands (/servers, /debug-perms, /tier)
├── tier-store.js         # Per-guild /tier persistence (data/tier-settings.json)
├── tier-config.js        # Tier lookup + persona overlay — getTierConfig(guildId)
└── threads-probe.cjs     # Playwright subprocess (CJS — runs in own process)
```

`threads-probe.cjs` runs in a separate process via `execFile` to keep Playwright off the Discord event loop.

`scripts/smoke.js` exercises pure functions (URL routing, persona, fortune helpers) — run with `node scripts/smoke.js` to verify a refactor didn't break behaviour. No I/O, no Discord, no AI calls.

All log prefixes are scoped: `[preview]`, `[threads-meta]`, `[ai]`, `[probe]`, `[permissions]`, `[mention]`, `[commands]`. Grep one to isolate.

## NEVER

- **NEVER** push directly to `main`. All changes go on a branch → PR → merge.
- **NEVER** merge a branch into `main` without passing local tests / smoke run first.
- **NEVER** let a function own more than one responsibility. When adding behaviour, decide if it belongs in an existing function or needs a new one — don't wedge flags into unrelated code.
- **NEVER** convert `threads-probe.cjs` to ESM. It must stay CommonJS because Playwright's `chromium.launch` has to run in a subprocess (blocking the Discord event loop freezes the gateway).
- **NEVER** attach a billing account to the Google Cloud project that owns the Gemini API key. See [ai-providers.md](.claude/rules/ai-providers.md) for the trap — workaround is creating a new project without billing.
- **NEVER** commit `.env` or any file containing real API keys / Discord tokens.
- **NEVER** refactor beyond the scope the task demands. One commit, one concern.

## Core gotchas (load-bearing — won't be obvious from code alone)

- **Mention text → `.normalize("NFC")` before comparison.** Discord can send CJK input in NFD form, causing strict equality (e.g. `抽籤`) to silently fail.
- **Threads routing order in `buildPreviewPayloads` is load-bearing.** The `if` ladder order determines which branch a mixed (image + video) post falls into. Changing the order changes which posts go to fixer vs custom embed — verify against a real mixed-media post before merging any reorder.
- **`normalizeUrl` tracking-param lists are NOT interchangeable.** `t` is a tracking param on X/Twitter but a timestamp on YouTube — that's why there's a `HOST_GATED_TRACKING_PARAMS` list. When adding a param, decide if it's meaningful on any supported host and gate accordingly.
- **`inFlightReplies` Set uses two key formats** (`msgId:urls...` and `mention:msgId`) because Discord gateway reconnects can fire `messageCreate` twice — without dedup, the mention path would produce both an AI reply and a fallback reply for the same message.
- **AI chain failures are silent by design.** Each provider failure (network, timeout, safety block, empty candidate) returns `null` and moves to the next layer. The ops signal is the single log line `[ai] chain exhausted (X providers tried), falling back to hardcoded reply` — grep for it when debugging a dead 西寶.
- **Empty embed fallback deletes messages.** If the fixer URL unfurls empty and the secondary also fails, `checkAndHandleEmptyEmbeds` deletes the bot's message and posts `抱歉，預覽載入失敗 🙏`. Expect deleted-message log noise when a fixer is down.

## Key behavioural summary

- **Threads**: text-only → custom embed. Video → fixer link. Single image → custom embed. Multiple images → carousel of 前 `MULTI_IMAGE_PREVIEW_COUNT` 張（default 3）；截斷或含 video 時最後一個 embed description 追加 `... 還有 N 張 + 影片` 提示。Probe error → fixer. Full decision table in [routing.md](.claude/rules/routing.md).
- **Instagram Stories**: no fixer works — bot replies with owner username in 西寶 voice and skips the embed-check pipeline entirely.
- **Everything else**: fixer host (X/Twitter / Reddit / Pixiv / Bluesky / Bilibili / Facebook) with FixEmbed as a generic fallback if unfurl is empty.
- **@西寶 AI reply chain**: DeepSeek (primary, paid) → Cerebras (Qwen free) → Groq (llama 70B → 8B) → Gemini (last resort). First non-null wins; chain exhausted → hardcoded reply. Per-channel short-term memory keeps last ~8 turns. Details in [ai-providers.md](.claude/rules/ai-providers.md).
- **Hardcoded mention responses**: `抽籤` → weighted fortune draw; `道歉` → fixed apology string. Never routed to AI. See [persona.md](.claude/rules/persona.md).
- **Ignore markers**: `nopreview`, `previewignore`, `fxignore` anywhere in a message suppresses the bot.
- **Dedup window**: 60 s per channel+URL (`DEDUPE_WINDOW_MS`).

## Workflow

1. New work → branch off `main` (`feat/xxx`, `fix/xxx`, `docs/xxx`). No direct commits to `main`.
2. Commit on branch. Run locally and smoke-test any behavioural change before requesting merge.
3. Open PR → merge to `main`.
4. After merge, **provide redeploy steps** (see [deploy.md](.claude/rules/deploy.md)) — the host tracks GitHub, not the local tree.
5. Status reports: include **current branch, commit hash, push status, test status**. All human-facing communication in 繁體中文.

## Quick start (local)

```bash
npm install
npx playwright install chromium
npx playwright install-deps chromium
cp .env.example .env   # fill in DISCORD_TOKEN
npm start
```

macOS: use `start-bot.command` / `stop-bot.command`. Full deploy / SSH ops in [deploy.md](.claude/rules/deploy.md).

## Where to look for details

Pure data and per-topic depth live under `.claude/rules/` so this file stays lean:

- [`.claude/rules/env.md`](.claude/rules/env.md) — full environment variable reference.
- [`.claude/rules/routing.md`](.claude/rules/routing.md) — per-platform routing tables, empty-embed fallback flow, URL normalization, ignore markers, dedup.
- [`.claude/rules/ai-providers.md`](.claude/rules/ai-providers.md) — provider chain, call shapes, observability, short-term memory, Gemini billing trap.
- [`.claude/rules/persona.md`](.claude/rules/persona.md) — 西寶 persona, A–G taxonomy, mention routing, fortune weights.
- [`.claude/rules/deploy.md`](.claude/rules/deploy.md) — local run, SSH deploy, redeploy steps, secrets.

## Self-evolution

When a mistake recurs or you learn a non-obvious rule, add it here (under the right section) or to a sub-file under `.claude/rules/`. Lead with the _why_. Keep this file under ~120 lines — if it grows past that, move the newest addition into a sub-file and leave a one-line pointer here.
