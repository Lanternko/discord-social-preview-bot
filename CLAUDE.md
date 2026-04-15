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

## Notes

- `threads-probe.cjs` is CommonJS (`.cjs`) because Playwright's `chromium.launch` must run in a subprocess to avoid blocking the Discord event loop.
- Dedup window: same channel + URL won't trigger a second reply within 60 seconds (`DEDUPE_WINDOW_MS`).
- `inFlightReplies` Set prevents duplicate processing of the same message if `messageCreate` fires twice.
- Log prefix convention: `[preview]`, `[threads-meta]` for easy filtering.
