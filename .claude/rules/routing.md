# Platform Routing (`buildPreviewPayloads`)

Top-level dispatcher: [src/preview.js](../../src/preview.js). Per-platform builders under [src/platforms/](../../src/platforms/).

## Threads

| Condition | Output |
|---|---|
| No image **AND** no video (`isTextOnly`) or `twitterCard === "summary"` | Custom embed (text only) |
| Multiple images (`imageCount > 1`) | Multi-image carousel embed — 顯示前 `MULTI_IMAGE_PREVIEW_COUNT` 張（default 3）。若被截斷，最後一個 embed 的 description 追加提示（e.g. `... 還有 6 張`）。沒有 button — 原本每個 embed 的標題就連回原貼文。檢查順序早於 video；混合 image+video 走 carousel **並**帶 `videoAttachment`（discord-io 把 mp4 下載後當附件上傳，可播放影片在圖集下方；放不下就只剩 carousel、影片降級為封面）|
| Has video / `videoCount > 0` (regardless of og:image presence) | 先試 `videoAttachment`（下載 mp4 → 上傳可播放影片）；放不下 / 停用 / 逾時 → Primary fixer (`FIXER_THREADS`) → secondary fixer (`FIXER_THREADS_SECONDARY`) → embedFallback (compact embed + 「影片無法載入」note) → OG recovery |
| `summary_large_image` + single image | Custom embed with image |
| Generic / partial metadata | Compact text embed |
| Probe error | Primary + secondary fixer + OG recovery list (was: just primary fixer) |
| Login wall (`isThreadsLoginWall` — probe returned `Threads • Log in` / generic `Join Threads to share ideas…`) | Treated as a probe error → same primary + secondary fixer + OG recovery fallthrough |

**Order is load-bearing.** See [src/platforms/threads.js](../../src/platforms/threads.js) — the `if` ladder order determines which branch a mixed (image+video) post falls into. Hard-asserted by [scripts/routing-smoke.js](../../scripts/routing-smoke.js):

- **MIXED case** (multi-image AND video → carousel gallery kept AND carries `videoAttachment` for a real uploaded video — NOT dropped to a bare video fixer that loses the images)
- **VIDEO-NO-IMAGE case** (video with `image=null` MUST still route to fixer chain — was a regression where `isTextOnly = !metadata.image` silently dropped these to text embed)

`isTextOnly` requires NO image AND NO video. A video-only post without `og:image` previously fell into the text-only branch and silently dropped the video.

**Login-wall guard** (`isThreadsLoginWall` in [src/probe.js](../../src/probe.js)): Threads serves a logged-out `Threads • Log in` interstitial for sensitive / flagged posts even to a working probe. `fetchThreadsMetadata` detects it (title `Threads • Log in` or the generic `Join Threads to share ideas…` description) and throws, so the post drops to the fixer chain instead of rendering a useless login card. The secondary fixer `fzthreads.com` fetches many of these where `fixthreads.seria.moe` also walls — asserted by `scripts/smoke.js`.

**Video attachment** ([src/video.js](../../src/video.js)): a bot-built embed can't hold a playable video, so video / MIXED payloads carry `videoAttachment` (a direct mp4 URL). `sendPreviews` → `resolveOutgoing` downloads + re-uploads it as a Discord file (which DOES render an inline player). On any miss — disabled, guild not in `VIDEO_ATTACHMENT_GUILD_IDS`, over the guild's upload cap, at `VIDEO_ATTACHMENT_MAX_CONCURRENT`, or a fetch failure — it returns null and the payload keeps its existing behaviour (carousel for MIXED, fixer chain for video-only). A HEAD size pre-check + concurrency cap + per-fetch timeout keep a flood of video links from overwhelming the host. Env knobs in [env.md](env.md); pure gating asserted by `scripts/smoke.js`.

## Instagram

- **Stories** (`/stories/<username>/`): no fixer works — bot immediately replies with owner username in 西寶 voice; skips embed-check pipeline entirely.
- **Posts / Reels**: Primary = `FIXER_INSTAGRAM` (ddinstagram.com) → Secondary = `FIXER_INSTAGRAM_SECONDARY` (fxstagram.com) → embedFallback = FixEmbed wrapper → OG recovery (fetches fixer host's HTML for OG tags).

## Bilibili

API-first via `https://api.bilibili.com/x/web-interface/view?bvid=...`. Success → custom embed (title / desc / cover / UP 主) **carrying a `videoAttachment`** — the direct mp4 at `https://media.<FIXER_BILIBILI>/video/<bvid>/1` (verified: `200 video/mp4`, no auth token; the `?_=` query is a cache-buster only). `resolveOutgoing` downloads + re-uploads it as a playable Discord video **below** the cover embed (MIXED-style, same mechanism as Threads). On any miss (disabled / guild not allow-listed / over the upload cap / at `VIDEO_ATTACHMENT_MAX_CONCURRENT` / fetch fail) the attachment resolves to null and the payload degrades to the cover embed alone — no regression. Bilibili is a video platform, so the mp4 is constructed straight from the BVID (no extra fetch). Failure (API error) → `FIXER_BILIBILI` (vxbilibili.com) with OG recovery. b23.tv short links are followed via redirect first.

## Other platforms

| Platform | Hosts (`isXxxUrl`) | Fixer env var | Default |
|---|---|---|---|
| X / Twitter | x.com, twitter.com, mobile.twitter.com | `FIXER_TWITTER` | `fxtwitter.com` |
| Reddit | reddit.com, old.reddit.com, redd.it | `FIXER_REDDIT` | `rxddit.com` |
| Pixiv | pixiv.net | `FIXER_PIXIV` | `phixiv.net` |
| Bluesky | bsky.app | `FIXER_BLUESKY` | `bskx.app` |
| Facebook | facebook.com, m.facebook.com, fb.watch | `FIXER_FACEBOOK` | `facebed.com` |
| Bahamut | forum.gamer.com.tw, m.gamer.com.tw | — | Custom embed via playwright probe; restricted board → public-summary embed with login notice |
| PTT | ptt.cc | — | Custom embed via playwright probe |

All "URL-only" platforms above (X / Reddit / Pixiv / Bluesky / Facebook / Bilibili-fixer-fallback / Threads-video / Instagram-non-story) carry a `recoverUrls` list, so the empty-embed detector falls through to OG metadata fetch instead of just deleting.

**Reddit short links** (`redd.it/<id>`) now correctly route to `rxddit.com/<id>` (was: falling into FixEmbed wrapper because `buildFallbackUrl` only matched `reddit.com` / `www.reddit.com`).

## Empty embed detection (`checkAndHandleEmptyEmbeds`)

For URL-only payloads (fixer links), the bot waits `EMBED_CHECK_DELAY_MS` then re-fetches the message. **Four-layer fallback** — every layer must fail before apology:

1. **Primary `content`** (fixer URL) — Discord unfurled it → done ✓
2. **`fallbackContent`** (secondary fixer URL) — edit message, wait `EMBED_CHECK_DELAY_MS`. Unfurled → done ✓
3. **`embedFallback`** (pre-built embed payload) — edit message, no further waiting needed. Done ✓
4. **OG recovery (`recoverUrls`)** — for each candidate URL, plain HTTP fetch + parse `og:title` / `og:description` / `og:image`, build a generic embed and edit. Implementation: [src/og-fallback.js](../../src/og-fallback.js). Done ✓

Only if all four fail (or each is null/missing) → delete message + reply `"抱歉，預覽載入失敗 🙏"`. Returns `{ allSucceeded: false }` so [src/index.js](../../src/index.js) knows NOT to suppress the user's native Discord embed.

This is the "至少要顯示 description" guarantee: as long as at least one fixer host (or the original platform URL for non-auth-walled cases) returns OG tags, the user gets at least a title/description embed.

## Suppress-original deferral

`suppressOriginalEmbeds` is **only** called after `checkAndHandleEmptyEmbeds` returns `{ allSucceeded: true }` for messages with any URL-only payload. Pre-rendered embed payloads (Threads probe success, Bilibili API success, Bahamut/PTT custom embeds) suppress immediately because they're guaranteed to render. Why: if our preview ends up deleted, the user's native Discord embed must still be visible — otherwise they lose all preview.

## URL normalization (`normalizeUrl`)

Strips tracking params before any routing/dedupe. Two lists:

- **`UNIVERSAL_TRACKING_PARAMS`** — stripped on any host (UTM, click IDs like `fbclid`/`gclid`, `mibextid`, etc.)
- **`HOST_GATED_TRACKING_PARAMS`** — stripped only on matching hosts. E.g. `t`/`s` on X/Twitter but **NOT** on YouTube where `t` is a timestamp; `igsh*` on Instagram; Bilibili `share_*`/`spm_id_from`/etc.

**When adding a param**: decide if it's meaningful on any supported host — if yes, gate it.

## Ignore markers

Users can suppress the bot by including `nopreview`, `previewignore`, or `fxignore` anywhere in their message.

## Dedup

- **Channel+URL window**: same channel + URL won't trigger a second reply within 60 s (`DEDUPE_WINDOW_MS`).
- **`inFlightReplies` Set**: prevents duplicate processing if `messageCreate` fires twice (Discord gateway reconnect). Two key formats:
  - URL preview path: `msgId:urls.join("|")`
  - Mention path: `mention:msgId`
