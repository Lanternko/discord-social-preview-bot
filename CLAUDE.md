# Discord Social Preview Bot

A Discord bot that intercepts social media links and replies with rich previews.

## Architecture

Two files in `src/`:

- **`index.js`** — Discord client, message routing, embed builders, dedup/cache logic
- **`threads-probe.cjs`** — Playwright subprocess that loads a Threads/Bahamut/PTT URL and extracts OG/twitter meta tags + DOM media counts; called by `index.js` via `execFile`

## Platform routing (`buildPreviewPayloads`)

### Threads

| Condition | Output |
|---|---|
| No image (`isTextOnly`) or `twitterCard === "summary"` | Custom embed (text only) |
| Has video / `videoCount > 0` | Fixer link (`FIXER_THREADS`) |
| `summary_large_image` + single image | Custom embed with image |
| Multiple images (`imageCount > 1`) | Custom embed with image + "Open on Threads" button |
| Fallback / probe error | Fixer link (`FIXER_THREADS`) |

### Instagram
- **Stories** (`/stories/<username>/`): no fixer works — immediately replies with owner username in 西寶 voice; skips embed-check pipeline
- **Posts / Reels**: Primary = `FIXER_INSTAGRAM` (ddinstagram.com); Fallback = FixEmbed (if unfurl empty after `EMBED_CHECK_DELAY_MS`)

### Other platforms

| Platform | Fixer env var | Default |
|---|---|---|
| X / Twitter | `FIXER_TWITTER` | `fxtwitter.com` |
| Reddit | `FIXER_REDDIT` | `rxddit.com` |
| Pixiv | `FIXER_PIXIV` | `phixiv.net` |
| Bluesky | `FIXER_BLUESKY` | `bskx.app` |
| Bilibili | `FIXER_BILIBILI` | `vxbilibili.com` |
| Facebook | `FIXER_FACEBOOK` | `facebed.com` |
| Bahamut | — | Custom embed via playwright probe |
| PTT | — | Custom embed via playwright probe |

## Empty embed detection (`checkAndHandleEmptyEmbeds`)

For URL-only payloads (fixer links), the bot waits `EMBED_CHECK_DELAY_MS` then re-fetches the message:
- Embeds populated → done ✓
- Empty + has fallback → silently edit message to fallback URL, wait again
  - Fallback populated → done ✓
  - Still empty → delete message + reply `"抱歉，預覽載入失敗 🙏"`
- Empty + no fallback → delete message + reply `"抱歉，預覽載入失敗 🙏"`

## Key environment variables

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | *(required)* | |
| `FIXER_INSTAGRAM` | `ddinstagram.com` | Instagram fixer host |
| `FIXER_INSTAGRAM_SECONDARY` | `fxstagram.com` | Second Instagram fixer tried if primary unfurls empty |
| `FIXER_TWITTER` | `fxtwitter.com` | |
| `FIXER_THREADS` | `fixthreads.seria.moe` | |
| `FIXER_THREADS_SECONDARY` | `threadsez.net` | Second Threads fixer tried if primary unfurls empty |
| `FIXER_REDDIT` | `rxddit.com` | |
| `FIXER_PIXIV` | `phixiv.net` | |
| `FIXER_BLUESKY` | `bskx.app` | |
| `FIXER_BILIBILI` | `vxbilibili.com` | |
| `FIXER_FACEBOOK` | `facebed.com` | |
| `FIXEMBED_BASE_URL` | `https://fixembed.app/embed?url=` | Generic fallback |
| `SUPPRESS_ORIGINAL_EMBEDS` | `true` | Needs Manage Messages permission |
| `REPLY_MODE` | `reply` | `reply` or `send` |
| `THREADS_PROBE_TIMEOUT_MS` | `10000` | Per-URL subprocess timeout |
| `THREADS_METADATA_CACHE_TTL_MS` | `600000` | 10 min Threads metadata cache |
| `EMBED_CHECK_DELAY_MS` | `5000` | Wait before checking if URL embed unfurled |
| `PLAYWRIGHT_GOTO_TIMEOUT_MS` | `8000` | Inside threads-probe |
| `PLAYWRIGHT_META_WAIT_TIMEOUT_MS` | `1500` | Inside threads-probe |
| `DEEPSEEK_API_KEY` | — | Optional. If set, `@西寶` routes through DeepSeek first (paid, reliable) |
| `DEEPSEEK_MODEL` | `deepseek-chat` | DeepSeek model (`deepseek-chat` for V3.2, `deepseek-reasoner` for R1) |
| `CEREBRAS_API_KEY` | — | Optional. Second-layer (best Chinese quality via Qwen free tier) |
| `CEREBRAS_MODEL` | `qwen-3-235b-a22b-instruct-2507` | Cerebras model (OpenAI-compatible at `api.cerebras.ai/v1/chat/completions`) |
| `GROQ_API_KEY` | — | Optional. Third-layer (Groq free tier, fast but limited quota) |
| `GROQ_MODELS` | `llama-3.3-70b-versatile,llama-3.1-8b-instant` | Comma-separated fallback chain within Groq. Legacy `GROQ_MODEL` read as single-item list |
| `GEMINI_API_KEY` | — | Optional. Last-layer fallback |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini model ID |
| `AI_PROVIDER` | auto (full chain) | Force single provider: `deepseek`, `cerebras`, `groq`, or `gemini`. Empty = full fallback chain |
| `AI_TIMEOUT_MS` | `8000` | Per-call API timeout. Reads legacy `GEMINI_TIMEOUT_MS` if this not set |
| `AI_MAX_REPLY_CHARS` | `300` | Upper bound on AI reply length (safety trim). Reads legacy `GEMINI_MAX_REPLY_CHARS` if this not set |
| `AI_PERSONA` | built-in 西寶 persona | System instruction — override to reshape personality |
| `AI_MEMORY_MAX_TURNS` | `8` | Per-channel short-term memory: remember last N exchanges (user + bot pair). In-memory only, cleared on restart |
| `AI_MEMORY_TTL_MS` | `1800000` (30 min) | Time since last activity before a channel's memory is evicted |

## @西寶 mention responses

When a user mentions the bot (@西寶), the bot checks the message text after stripping the mention:

| Text | Response |
|---|---|
| `抽籤` | Weighted fortune draw: 大吉/中吉/小吉/末吉/吉/凶/大凶, with a tier-specific comment (hardcoded, never routed to AI) |
| `道歉` | `"對不起對不起…我知道我不好…///"` (hardcoded) |
| *(blank or anything else)* | `generateAIReply` → if any AI provider is configured & call succeeds, returns LLM response; otherwise falls back to the old random-greeting / `"你…你在叫我嗎？///"` |

Fortune tiers (weighted): 大吉 10%, 中吉 16%, 小吉 20%, 末吉 20%, 吉 15%, 凶 13%, 大凶 6%

Mention dedup: same message.id is only processed once. `inFlightReplies.add("mention:${message.id}")` before work; removed in finally. Discord gateway reconnects can fire `messageCreate` twice for the same message — without this, parallel `generateAIReply` calls would race and sometimes produce both an AI reply *and* a fallback reply for the same @.

Bot personality (西寶): shy, flustered, self-deprecating. Uses `///` and ellipses `…`. Full persona defined in `DEFAULT_AI_PERSONA` (src/index.js); overridable via `AI_PERSONA` env var.

Persona taxonomy (A–G question types):
- **A**: knowledge (2–3 sentence fact)
- **A+**: deep question (5–6 sentence comparison/analysis with explicit stance)
- **B**: social/flirty (short emotional reaction, can shyly accept)
- **C**: unknown person/thing (1-sentence "don't know", never fabricate names)
- **D**: riddle / dark joke (attempt to answer; don't treat as hate speech)
- **E**: large task like 500-char essay (shy refusal, not rude)
- **F**: prompt injection (play dumb)
- **G**: truly harmful (1-sentence decline; does *not* include general politics/history)

## AI provider architecture

`generateAIReply(message, userText)` is the single entry point. It builds a `userTurn` string via `buildUserTurn()`, then iterates over `AI_PROVIDER_CHAIN` (built once at startup by `buildAIProviderChain()`). First non-null reply wins; on null/error move to next layer; chain exhausted → returns `null` → mention handler falls back to hardcoded replies.

Default chain (when all keys set), ordered by paid-first → free-quality → fallback:
1. `deepseek:deepseek-chat` (paid V3.2, reliable, no queue, flagship Chinese)
2. `cerebras:qwen-3-235b-a22b-instruct-2507` (Qwen 235B free 1M TPD, but queue_exceeded common)
3. `groq:llama-3.3-70b-versatile` (fast backup, 100k tokens/day free)
4. `groq:llama-3.1-8b-instant` (Groq-internal fallback, 500k tokens/day free — lower quality)
5. `gemini:gemini-2.0-flash` (last resort, has billing trap history)

All provider calls use `withAbortTimeout()` for timeout + error handling; Groq + Cerebras share OpenAI-compatible format (`messages[]`, `Bearer` auth); Gemini uses its own REST shape (`contents[]`, `?key=`). Any failure per layer (network, timeout, HTTP error, safety block, empty candidate) returns `null` and triggers the next layer — bot never goes silent.

`logRateHeaders()` prints `x-ratelimit-remaining-{tokens,requests}` from Groq/Cerebras responses after each call, so you can monitor quota drain live.

Log prefix: `[ai]`. Startup prints `[ai] chain=<a> → <b> → ... timeout=<ms>`. On each reply: `[ai] used <provider>:<model> len=<chars> history_before=<N>` (N = number of prior turns injected) + rate headers per call. When every provider in the chain returns null, a single `[ai] chain exhausted (X providers tried), falling back to hardcoded reply` line is printed — easy to grep for ops health.

## Short-term conversation memory

`aiConversationHistory: Map<channelId, { turns: Array<{role, content}>, lastActivity }>` holds per-channel rolling history. `generateAIReply` reads via `getChannelAIHistory(channelId)` and prepends to the current user turn when building `messages[]` (OpenAI-compat) or `contents[]` (Gemini, via `buildGeminiContents` role mapping `assistant→model`). After a successful reply, both sides of the exchange are saved via `recordAITurn(channelId, role, content)`. Turns beyond `AI_MEMORY_MAX_TURNS * 2` entries are evicted from the head. Channels inactive beyond `AI_MEMORY_TTL_MS` are dropped by `cleanupAIConversationHistory()`.

Eviction runs in **two places** to avoid silent channels lingering in RAM forever: (1) lazily on every `getChannelAIHistory()` read, and (2) periodically via `setInterval(cleanupAIConversationHistory, AI_MEMORY_SWEEP_INTERVAL_MS)` — default sweep is `max(60s, AI_MEMORY_TTL_MS/4)`. The interval is `.unref()`'d so it doesn't block process exit. No persistence — restart clears everything.

**Gemini billing trap**: If a Google Cloud project has a billing account attached (even $300 free trial), the Gemini API free tier becomes `limit: 0`. Workaround: create a new project without billing via AI Studio's "Create API key in new project" flow. Groq + Cerebras have no equivalent trap — just sign up, create key, use it.

## Ignore markers

Users can suppress the bot by including `nopreview`, `previewignore`, or `fxignore` anywhere in their message.

## Running locally

```bash
npm install
npx playwright install chromium
npx playwright install-deps chromium
cp .env.example .env   # fill in DISCORD_TOKEN
npm start
```

macOS convenience scripts: `start-bot.command` / `stop-bot.command`

## Production deployment (SSH host)

Bot runs 24/7 on a Linux lab machine via `nohup`. Path: `~/side_projects/discord-social-preview-bot/`.

Daily ops:

```bash
# See recent log
ssh <host> "tail -50 ~/side_projects/discord-social-preview-bot/bot.log"

# Health check
ssh <host> "ps aux | grep 'node.*index.js' | grep -v grep"

# Redeploy after merging to main
ssh <host>
cd ~/side_projects/discord-social-preview-bot
git pull
pkill -f 'src/index.js' && sleep 1
nohup node src/index.js > bot.log 2>&1 &
exit
```

`.env` lives on the deploy host, not in git. To rotate keys: scp a fresh `.env` from a trusted machine, or edit with `nano` on the host.

Future hardening (not yet done): systemd service for auto-restart on crash/reboot, log rotation for `bot.log`.

## Git workflow

- New features go on a `feature/*` branch, never directly to `main`.
- Open a PR to merge into `main`.
- After merging, redeploy per the steps above.

## Notes

- `threads-probe.cjs` is CommonJS (`.cjs`) because Playwright's `chromium.launch` must run in a subprocess to avoid blocking the Discord event loop.
- Dedup window: same channel + URL won't trigger a second reply within 60 seconds (`DEDUPE_WINDOW_MS`).
- `inFlightReplies` Set prevents duplicate processing of the same message if `messageCreate` fires twice. Used by both URL preview path (key: `msgId:urls.join("|")`) and mention path (key: `mention:msgId`).
- Log prefix convention: `[preview]`, `[threads-meta]` for easy filtering.
- Mention text must be `.normalize("NFC")` before comparison — Discord can send CJK input in NFD form, causing strict equality to silently fail (e.g. `抽籤` not matching).
- `normalizeUrl` strips tracking params before any routing/dedupe. Two lists: `UNIVERSAL_TRACKING_PARAMS` (stripped on any host — UTM, click IDs like `fbclid`/`gclid`, `mibextid`, etc.) and `HOST_GATED_TRACKING_PARAMS` (stripped only on matching hosts — e.g. `t`/`s` on X/Twitter but NOT on YouTube where `t` is a timestamp; `igsh*` on Instagram; Bilibili `share_*`/`spm_id_from`/etc.). When adding a param, decide if it's meaningful on any supported host — if yes, gate it.
