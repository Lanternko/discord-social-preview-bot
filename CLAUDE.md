# Discord Social Preview Bot

A Discord bot that intercepts social media links (Threads, Instagram, X, Reddit, Pixiv, Bluesky, Bilibili, Facebook, Bahamut, PTT) and replies with rich previews. Also hosts a `@西寶` AI personality.

## Architecture

CommonJS modules under `src/`. Entry point [src/index.js](src/index.js) is just bootstrap + dispatch; all business logic is in focused modules. Module-by-module breakdown + full tree in [docs/architecture.md](docs/architecture.md).

## NEVER

- **NEVER** do feature work in the shared main checkout — and **NEVER** `git checkout` a different branch there — while another session/feature may be active. A working tree's HEAD is a property of the **folder**, not the conversation: every process pointed at that folder (other Claude sessions, your terminals, the running bot's source dir) shares one branch, so a checkout silently stomps all of them. Each concurrent feature gets its **own** `git worktree` — sibling `apps/dspb-<feature>/` (e.g. `dspb-bilibili`, `dspb-imitation`). See [`worktrees.md`](docs/worktrees.md).
- **NEVER** push directly to `main`. All changes go on a branch → PR → merge.
- **NEVER** merge a branch into `main` without `npm test` passing locally.
- **NEVER** let a function own more than one responsibility. When adding behaviour, decide if it belongs in an existing function or needs a new one — don't wedge flags into unrelated code.
- **NEVER** convert `threads-probe.cjs` to ESM. It must stay CommonJS because Playwright's `chromium.launch` has to run in a subprocess (blocking the Discord event loop freezes the gateway).
- **NEVER** attach a billing account to the Google Cloud project that owns the Gemini API key. See [ai-providers.md](docs/ai-providers.md) for the trap — workaround is creating a new project without billing.
- **NEVER** commit `.env` or any file containing real API keys / Discord tokens.
- **NEVER** refactor beyond the scope the task demands. One commit, one concern.

## Core gotchas (load-bearing — won't be obvious from code alone)

- **Mention text → `.normalize("NFC")` before comparison.** Discord can send CJK input in NFD form, causing strict equality (e.g. `抽籤`) to silently fail.
- **Threads routing order in `buildPreviewPayloads` is load-bearing.** The `if` ladder order determines which branch a mixed (image + video) post falls into — multi-image is checked before video, so a MIXED post stays a carousel gallery and carries a `videoAttachment` (discord-io downloads the mp4 and uploads it as a playable video below the gallery), rather than dropping to a bare video fixer. Hard-asserted by `scripts/routing-smoke.js` (MIXED case). Run `npm run test:routing` before merging any reorder.
- **Video attachment is the only way to show a playable video the bot controls.** Bot-built embeds can't hold a video, so [src/video.js](src/video.js) downloads the mp4 and re-uploads it. It's the last thing `sendPreviews` resolves (`resolveOutgoing`); on ANY miss (disabled / guild not allow-listed / over the guild upload cap / at the concurrency cap / fetch fail) it returns null and the payload keeps its existing behaviour (carousel for MIXED, fixer chain for video-only). Guards: HEAD size pre-check, `VIDEO_ATTACHMENT_MAX_CONCURRENT`, per-fetch timeout — so a flood of video links can't overwhelm the host. Grep `[video]`.
- **`normalizeUrl` tracking-param lists are NOT interchangeable.** `t` is a tracking param on X/Twitter but a timestamp on YouTube — that's why there's a `HOST_GATED_TRACKING_PARAMS` list. When adding a param, decide if it's meaningful on any supported host and gate accordingly.
- **`inFlightReplies` Set uses two key formats** (`msgId:urls...` and `mention:msgId`) because Discord gateway reconnects can fire `messageCreate` twice — without dedup, the mention path would produce both an AI reply and a fallback reply for the same message.
- **AI chain failures are silent by design.** Each provider failure (network, timeout, safety block, empty candidate) returns a `{ ok: false, kind }` and moves to the next layer. The ops signal is the single log line `[ai] chain exhausted (X providers tried), falling back to hardcoded reply` — grep for it when debugging a dead 西寶.
- **Circuit breaker skips cooling-down providers.** A failed provider gets a kind-specific cooldown (`auth` 10 min, `rate_limit` honours `Retry-After`, `timeout`/`network`/`server` 60 s, `empty` 0 s). Until cooldown clears, the chain logs `[ai] skip cooling-down provider=<label>` and goes straight to the next layer. State is in-memory; restart clears it.
- **Empty embed fallback chain has 4 layers**, in order: `content` (primary fixer) → `fallbackContent` (secondary fixer) → `embedFallback` (pre-built embed) → **OG recovery** (`recoverUrls` lazy fetched + parsed for og:title/description/image, rendered as a generic embed). Only if all four fail does `checkAndHandleEmptyEmbeds` delete the bot's message and post `抱歉，預覽載入失敗 🙏`. The OG layer is what makes "至少要顯示 description" hold even when both fixers are dead. Implementation: [src/og-fallback.js](src/og-fallback.js), wiring in [src/discord-io.js](src/discord-io.js).
- **Suppress original embed is deferred for URL-only previews.** When the bot's preview is URL-only, `suppressOriginalEmbeds` runs only AFTER `checkAndHandleEmptyEmbeds` confirms success. Why: if every layer above fails and we delete our preview, the user's native Discord embed must still be visible — otherwise they lose all preview. Pre-rendered embed payloads (Threads probe success, Bilibili API success, Bahamut/PTT) suppress immediately.

## Key behavioural summary

- **Threads**: text-only (no image AND no video) → custom embed. Video → **video attachment** (download mp4 → upload it; [src/video.js](src/video.js)), falling back to the fixer chain + OG recovery when it can't attach. Single image → custom embed. Multiple images → carousel of 前 `MULTI_IMAGE_PREVIEW_COUNT` 張（default 3）；截斷時最後一個 embed description 追加 `... 還有 N 張` 提示；含 video 的混合貼文另外把影片當附件上傳（放不下才退 fixer）。Probe error → primary + secondary fixer + OG recovery list. Full decision table in [routing.md](docs/routing.md).
- **Bilibili**: API-first via `https://api.bilibili.com/x/web-interface/view` (already in code, now wired). Success → custom info bar **+ `videoAttachment`**（media.vxbilibili 的直鏈 mp4）：discord-io 下載後上傳可播放影片，上方以 `videoAttachmentContent` 純文字資訊欄呈現（可點標題＋作者，無 embed 框）。**放不下（超過上傳上限）/停用/失敗 → 改貼 vxbilibili fixer 連結**（`videoAttachmentMissContent`）——Discord 串流遠端 mp4 不吃上傳上限，大影片仍有原生播放器；unfurl 空了才退含封面 embed（embedFallback）→ OG recovery。Failure（API error）→ vxbilibili fixer + OG recovery.
- **Instagram Stories**: no fixer works — bot replies with owner username in 西寶 voice and skips the embed-check pipeline entirely.
- **Everything else (X/Twitter / Reddit / Pixiv / Bluesky / Facebook)**: fixer host as primary with `recoverUrls` for OG-recovery if unfurl is empty.
- **@西寶 AI reply chain**: Per-guild tier determines model — 入門 uses DeepSeek Flash (20/day free limit), 標準/精細 use DeepSeek Pro (requires guild API key or whitelist). Fallback: Groq (llama 70B → 8B) → Gemini. First non-null wins; chain exhausted → hardcoded reply. Per-channel short-term memory keeps last `tierConfig.memoryMaxTurns` turns. Guild keys stored in `data/guild-api-keys.json`; daily counters in-memory (reset on restart). Details in [ai-providers.md](docs/ai-providers.md).
- **Hardcoded mention responses**: `抽籤`/`運勢` → weighted fortune draw; `道歉` → fixed apology string. Never routed to AI. See [persona.md](docs/persona.md).
- **Ignore markers**: `nopreview`, `previewignore`, `fxignore` anywhere in a message suppresses the bot.
- **Dedup window**: 60 s per channel+URL (`DEDUPE_WINDOW_MS`).
- **刪除西寶的訊息**：在西寶發的**任何**訊息上按 🗑️ 反應，**或**右鍵 → 應用程式 > `刪除西寶訊息`（context menu，實作在 [src/commands.js](src/commands.js)）→ 貼連結的本人（用 reply reference 認出，不需額外狀態）、有 `ManageMessages` 的管理員，或 `BOT_OWNER_IDS` 裡的 bot owner 可刪掉那則。只動西寶自己的訊息。需 `GuildMessageReactions` intent + Message/Channel/Reaction partials（皆已設於 [src/index.js](src/index.js)）。反應路徑實作 [src/reaction-delete.js](src/reaction-delete.js)，grep `[delete]`。

## Workflow

0. **Isolate parallel work in a `git worktree`** — never `git checkout` a feature branch in the shared main checkout (that folder is prod, and its HEAD is shared by every process pointed at it). Setup recipe, naming, and teardown in [`worktrees.md`](docs/worktrees.md).
   ⚠️ 兩個坑都會弄丟真實資料：worktree 裡跑 `npm test` 會生出裝 fixture 的假 `data/`；`git add -A` 會把 `data` symlink commit 進去，之後在主樹 checkout 那支會**刪掉整個 `data/`**（2026-07-05 發生過）。動真資料或 `add -A` 前先讀 [`worktrees.md`](docs/worktrees.md)。
1. New work → branch off `main` (`feat/xxx`, `fix/xxx`, `docs/xxx`) in its own worktree. No direct commits to `main`.
2. Commit on branch. Run `npm test` (all three smokes) before requesting merge.
3. Open PR → merge to `main`.
4. After merge, redeploy (see [deploy.md](docs/deploy.md)). **Prod is the main checkout's working tree on whatever branch it currently has** — there is no `deploy/*` branch; check `git branch --show-current` there and merge the PR into *that* branch, so deploying never needs a `git checkout` in the shared folder.
5. Status reports: include **current branch, commit hash, push status, test status**. All human-facing communication in 繁體中文.

## Quick start (local)

```bash
npm install
npx playwright install chromium
npx playwright install-deps chromium
cp .env.example .env   # fill in DISCORD_TOKEN
npm start
```

macOS: use `start-bot.command` / `stop-bot.command`. Full deploy / SSH ops in [deploy.md](docs/deploy.md).

## Where to look for details

Pure data and per-topic depth live under `docs/` so this file stays lean. **They are read on demand — do NOT move them (back) into `.claude/rules/`**: everything under `.claude/rules/` gets auto-loaded verbatim into every session's (and every subagent's) context, which once cost ~50KB of always-on tokens per agent. Read the file for the area you're touching; skip the rest:

- [`architecture.md`](docs/architecture.md) — module groups, full `src/` tree, log prefixes.
- [`env.md`](docs/env.md) — full environment variable reference.
- [`routing.md`](docs/routing.md) — per-platform routing tables, empty-embed fallback flow, URL normalization, ignore markers, dedup.
- [`ai-providers.md`](docs/ai-providers.md) — provider chain, call shapes, circuit breaker, observability, short-term memory, Gemini billing trap.
- [`persona.md`](docs/persona.md) — 西寶 persona (narrative-driven), mention routing, fortune weights, `/ai-tier` / `/ai-key`.
- [`scripts.md`](docs/scripts.md) — three smoke layers and when to run which.
- [`worktrees.md`](docs/worktrees.md) — 平行開發隔離、假 `data/` 與 symlink 陷阱、shadow-deploy。
- [`deploy.md`](docs/deploy.md) — local run, SSH deploy, redeploy steps, secrets.

## Self-evolution

When a mistake recurs or you learn a non-obvious rule, add it here (under the right section) or to a sub-file under `docs/` (never `.claude/rules/` — see above). Lead with the _why_. Keep this file under ~80 lines — if it grows past that, move the newest addition into a sub-file and leave a one-line pointer here.
