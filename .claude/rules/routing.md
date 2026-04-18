# Platform Routing (`buildPreviewPayloads`)

Top-level dispatcher: [src/preview.js](../../src/preview.js). Per-platform builders under [src/platforms/](../../src/platforms/).

## Threads

| Condition | Output |
|---|---|
| No image (`isTextOnly`) or `twitterCard === "summary"` | Custom embed (text only) |
| Multiple images (`imageCount > 1`) | Multi-image carousel embed — 顯示前 `MULTI_IMAGE_PREVIEW_COUNT` 張（default 3）。若被截斷 或 `hasVideo`，最後一個 embed 的 description 追加提示（e.g. `... 還有 6 張 + 影片`）。沒有 button — 原本每個 embed 的標題就連回原貼文。檢查順序早於 video，混合 image+video 仍走 carousel |
| Has video / `videoCount > 0` | Fixer link (`FIXER_THREADS`) |
| `summary_large_image` + single image | Custom embed with image |
| Fallback / probe error | Fixer link (`FIXER_THREADS`) |

**Order is load-bearing.** See [src/platforms/threads.js](../../src/platforms/threads.js) — the `if` ladder order determines which branch a mixed (image+video) post falls into. Hard-asserted by [scripts/routing-smoke.js](../../scripts/routing-smoke.js) (MIXED case: multi-image AND video → carousel wins).

## Instagram

- **Stories** (`/stories/<username>/`): no fixer works — bot immediately replies with owner username in 西寶 voice; skips embed-check pipeline entirely.
- **Posts / Reels**: Primary = `FIXER_INSTAGRAM` (ddinstagram.com); Fallback = FixEmbed (if unfurl empty after `EMBED_CHECK_DELAY_MS`).

## Other platforms

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
