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
| `FIXER_TWITTER` | `fxtwitter.com` | |
| `FIXER_THREADS` | `fixthreads.seria.moe` | |
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
| `GEMINI_API_KEY` | — | Optional. If set, `@西寶` free-form mentions use Gemini for replies |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Gemini model ID |
| `GEMINI_TIMEOUT_MS` | `8000` | API timeout; on timeout → hardcoded fallback |
| `GEMINI_MAX_REPLY_CHARS` | `300` | Upper bound on AI reply length (safety trim) |
| `AI_PERSONA` | built-in 西寶 persona | System instruction — override to reshape personality |

## @西寶 mention responses

When a user mentions the bot (@西寶), the bot checks the message text after stripping the mention:

| Text | Response |
|---|---|
| `抽籤` | Weighted fortune draw: 大吉/中吉/小吉/末吉/吉/凶/大凶, with a tier-specific comment (hardcoded, never routed to AI) |
| `道歉` | `"對不起對不起…我知道我不好…///"` (hardcoded) |
| *(blank or anything else)* | `generateAIReply` → if `GEMINI_API_KEY` set & call succeeds, returns Gemini response; otherwise falls back to the old random-greeting / `"你…你在叫我嗎？///"` |

Fortune tiers (weighted): 大吉 10%, 中吉 16%, 小吉 20%, 末吉 20%, 吉 15%, 凶 13%, 大凶 6%

Bot personality (西寶): shy, flustered, self-deprecating. Uses `///` and ellipses `…`. Full persona defined in `DEFAULT_AI_PERSONA` (src/index.js); overridable via `AI_PERSONA` env var.

AI call uses Gemini REST (`generativelanguage.googleapis.com/v1beta/models/<model>:generateContent`). No SDK — native `fetch` + `AbortController`. Any failure (network, timeout, safety block, empty candidate) returns `null` and triggers the hardcoded fallback, so the bot never goes silent.

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

## Git workflow

- New features go on a `feature/*` branch, never directly to `main`.
- Open a PR to merge into `main`.
- After changes are committed and pushed, restart the bot via `stop-bot.command` then `start-bot.command`.

## Notes

- `threads-probe.cjs` is CommonJS (`.cjs`) because Playwright's `chromium.launch` must run in a subprocess to avoid blocking the Discord event loop.
- Dedup window: same channel + URL won't trigger a second reply within 60 seconds (`DEDUPE_WINDOW_MS`).
- `inFlightReplies` Set prevents duplicate processing of the same message if `messageCreate` fires twice.
- Log prefix convention: `[preview]`, `[threads-meta]` for easy filtering.
- Mention text must be `.normalize("NFC")` before comparison — Discord can send CJK input in NFD form, causing strict equality to silently fail (e.g. `抽籤` not matching).
- `normalizeUrl` strips tracking params before any routing/dedupe. Two lists: `UNIVERSAL_TRACKING_PARAMS` (stripped on any host — UTM, click IDs like `fbclid`/`gclid`, `mibextid`, etc.) and `HOST_GATED_TRACKING_PARAMS` (stripped only on matching hosts — e.g. `t`/`s` on X/Twitter but NOT on YouTube where `t` is a timestamp; `igsh*` on Instagram; Bilibili `share_*`/`spm_id_from`/etc.). When adding a param, decide if it's meaningful on any supported host — if yes, gate it.
