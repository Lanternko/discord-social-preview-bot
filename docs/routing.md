# Platform Routing (`buildPreviewPayloads`)

Top-level dispatcher: [src/preview.js](../src/preview.js). Per-platform builders under [src/platforms/](../src/platforms/).

## Threads

Threads 的 `/share/<token>` 會先由 [src/threads-url.js](../src/threads-url.js) 展開成 `https://www.threads.com/@user/post/id`，之後 probe、viewer 與本機 fallback 全部只使用這個 canonical URL。Resolver 只允許精確的官方 HTTPS share URL，使用 `redirect: manual` 讀取單一 `Location`（不跟隨），並再次驗證官方 host 與 post path；timeout 2.5 秒、最多 4 個並行請求、同 URL inflight dedupe，以及最多 512 筆的正／負快取。解析失敗時保留原 share URL，不會請求轉址目的地。

| Condition | Output |
|---|---|
| No image **AND** no video (`isTextOnly`) or `twitterCard === "summary"` | Custom embed (text only) |
| Multiple images (`imageCount > 1`) | Multi-image carousel embed — 顯示前 `MULTI_IMAGE_PREVIEW_COUNT` 張（default 3）。若被截斷，最後一個 embed 的 description 追加提示（e.g. `... 還有 6 張`）。沒有 button — 原本每個 embed 的標題就連回原貼文。檢查順序早於 video；混合 image+video 走 carousel **並**帶 `videoAttachment`（discord-io 把 mp4 下載後當附件上傳，可播放影片在圖集下方；放不下就只剩 carousel、影片降級為封面）|
| Has video / `videoCount > 0` (regardless of og:image presence) | 先試 `videoAttachment`（下載 mp4 → 上傳可播放影片）；放不下 / 停用 / 逾時 → 依 `THREADS_VIEWER_HOSTS` 順序逐一嘗試 viewer → local `embedFallback`（canonical link +「影片無法載入」note） |
| `summary_large_image` + single image | Custom embed with image |
| Generic / partial metadata | Compact text embed |
| Probe error | 依序嘗試 `THREADS_VIEWER_HOSTS` → local canonical `embedFallback` |
| Login wall (`isThreadsLoginWall` — probe returned `Threads • Log in` / generic `Join Threads to share ideas…`) | Treated as a probe error → same ordered viewer chain → local fallback |
| Content-less stub (`isContentlessStub` — 停在 permalink 但只有 `Threads` 標題，無 description／card／媒體／ancestors) | Treated as a probe error → same ordered viewer chain → local fallback |

**回覆貼文的上文（reply context）**：分享出來的 Threads 連結很常是一則**回覆**，而 Threads 的 `og:description` 只帶那則回覆本身的文字——梗的鋪陳（被回覆的原貼文）完全不會進預覽。Probe 因此另外抓 `ancestors`：thread 頁面會把所有祖先貼文依 DOM 順序排在目標貼文之前，用**目標貼文自己的 permalink**（`<time>` 的 `<a href>`）定位目標，其前面的 `div[data-pressable-container]` 就是祖先鏈。**刻意不用捲動位置判斷**——頁面會自動把目標捲到頂端，但那是非同步的，用位置會踩到跟 media race 同一類的競態；permalink 不會。貼文內文則靠 role 辨識（`span[dir="auto"]` 且不在 `<a>`／`[role="button"]` 內、本身也不包 `<time>`），因為 Threads 的 class name 每次 build 都會換。

輸出格式（[src/platforms/threads.js](../src/platforms/threads.js) 的 `buildReplyDescription`）：祖先以 Discord 引言（`> `）呈現、標上 `**@作者**`，回覆本身在下方以 `↳ ` 開頭。鏈太深時只留 root（這串在講什麼）＋直接被回覆者（這則在回什麼），中間標 `⋯（中間還有 N 則）`。非回覆貼文 `ancestors` 為空、description 原封不動。三個 case 都由 routing smoke 釘住。

**Order is load-bearing.** See [src/platforms/threads.js](../src/platforms/threads.js) — the `if` ladder order determines which branch a mixed (image+video) post falls into. Hard-asserted by [scripts/routing-smoke.js](../scripts/routing-smoke.js):

- **MIXED case** (multi-image AND video → carousel gallery kept AND carries `videoAttachment` for a real uploaded video — NOT dropped to a bare video fixer that loses the images)
- **VIDEO-NO-IMAGE case** (video with `image=null` MUST still route to fixer chain — was a regression where `isTextOnly = !metadata.image` silently dropped these to text embed)

`isTextOnly` requires NO image AND NO video. A video-only post without `og:image` previously fell into the text-only branch and silently dropped the video.

**Content-less stub guard** (`isContentlessStub` in [src/probe.js](../src/probe.js)): 被牆／已移除的貼文不一定會轉址離開 permalink，也不一定吐登入牆文案——2026-09-16 的 `@cuqhytr/post/DdRLvLZE-Rr` 停在原網址、17 個 meta tag、標題只有 `Threads`、沒有 description／card／媒體。那個形狀會掉進 `isTextOnly` 分支，被當成真的純文字貼文，產出一張內容只有「Threads」四個字的 embed。因此把「標題是裸站名（或空）且完全沒有內容」視為 probe miss，交給 viewer chain + local fallback。判準刻意保守：真貼文的標題一定帶作者（`X (@y) on Threads`），任何殘存的 postText／圖／影片／ancestors 都不會被丟掉。

**Login-wall guard** (`isThreadsLoginWall` in [src/probe.js](../src/probe.js)): Threads serves a logged-out `Threads • Log in` interstitial for sensitive / flagged posts even to a working probe. `fetchThreadsMetadata` detects it and throws. Discord 的 viewer unfurl 也會再驗證內容：空 embed、`Threads • Log in`、`Join Threads…` 與只有 `Thread` / `Threads` 的泛用卡片都視為失敗並嘗試下一個 viewer；第一個含實質文字或媒體的 embed 才停止。

Viewer 由 `THREADS_VIEWER_HOSTS` 設定，格式為最多三個逗號分隔的純 DNS hostname；預設順序 `fzthreads.com,fixthreads.seria.moe`。URL、path、port、IP、`localhost` 或超過三個值會在啟動時直接報錯。舊的 `FIXER_THREADS` / `FIXER_THREADS_SECONDARY` 仍作為相容設定。Threads 不帶 `recoverUrls`，因此 bot process 不會抓取第三方 viewer HTML；所有 viewer 都失敗時改用已建好的 canonical local embed。

**Video attachment** ([src/video.js](../src/video.js)): a bot-built embed can't hold a playable video, so video / MIXED payloads carry `videoAttachment` (a direct mp4 URL). `sendPreviews` → `resolveOutgoing` downloads + re-uploads it as a Discord file (which DOES render an inline player). On any miss — disabled, guild not in `VIDEO_ATTACHMENT_GUILD_IDS`, over the guild's upload cap, at `VIDEO_ATTACHMENT_MAX_CONCURRENT`, or a fetch failure — it returns null and the payload keeps its existing behaviour (carousel for MIXED, fixer chain for video-only). A HEAD size pre-check + concurrency cap + per-fetch timeout keep a flood of video links from overwhelming the host. Env knobs in [env.md](env.md); pure gating asserted by `scripts/smoke.js`.

## Instagram

- **Stories** (`/stories/<username>/`): no fixer works — bot immediately replies with owner username in 西寶 voice; skips embed-check pipeline entirely.
- **Posts / Reels**: [src/instagram-url.js](../src/instagram-url.js) first normalizes `instagram.com` / `www.instagram.com`, singularizes `/reels/` to `/reel/`, removes query tracking, and validates the post shortcode. Discord then tries `INSTAGRAM_VIEWER_HOSTS` in order (default `instagram7.com,oginstagram.com,deinstagram.com`). Empty embeds, login walls, unavailable/not-found cards, and generic no-media cards advance to the next viewer; the first meaningful text/media embed wins. All viewers failing → **OG recovery** from `INSTAGRAM_OG_RECOVERY_HOSTS` (`instagram7.com,deinstagram.com,fxig.seria.moe`, bot-side fetch) → local placeholder embed linked to the canonical Instagram URL (`placeholderFallback`).

Viewer config accepts at most three plain DNS hostnames and retains legacy `FIXER_INSTAGRAM` / `FIXER_INSTAGRAM_SECONDARY` compatibility.

**Why these lists (2026-09-15):** bot.log since 2026-08-31 (264 previews) — instagram7 won ~68%, deinstagram 23, fxig only 9, all-failed 17. A reel then failed on all three while another bot's `oginstagram.com` unfurled fine, so oginstagram replaced fxig as viewer #2. oginstagram serves our host a Cloudflare challenge (403) but lets Discord's crawler through, so it is a Discord-side viewer only. Conversely, fetched from our host, instagram7 has the richest OG (@user + likes + caption + thumbnail) while fxig / deinstagram only give a generic title + cover — so instagram7 leads the OG recovery list. The placeholder ranks *below* OG recovery because it carries no post content.

## Bilibili

API-first via `https://api.bilibili.com/x/web-interface/view?bvid=...`. Success → custom embed (title / desc / cover / UP 主) **carrying a `videoAttachment`** — the direct mp4 at `https://media.<FIXER_BILIBILI>/video/<bvid>/1` (verified: `200 video/mp4`, no auth token; the `?_=` query is a cache-buster only). `resolveOutgoing` downloads + re-uploads it as a playable Discord video (MIXED-style, same mechanism as Threads). When the upload succeeds it **swaps the cover embed for a cover-less `videoAttachmentEmbeds`** (title / UP 主 / desc only) — the cover is just a still frame of the video, so keeping it would duplicate the player. On any miss (disabled / guild not allow-listed / over the upload cap / at `VIDEO_ATTACHMENT_MAX_CONCURRENT` / fetch fail) the attachment resolves to null and the payload keeps its full cover embed — no regression. (The embed swap is generic: `resolveOutgoing` applies `videoAttachmentEmbeds` whenever a video attaches; the Threads MIXED carousel omits it, so its gallery — whose images differ from the video — is untouched.) Bilibili is a video platform, so the mp4 is constructed straight from the BVID (no extra fetch). Failure (API error) → `FIXER_BILIBILI` (vxbilibili.com) with OG recovery. b23.tv short links are followed via redirect first.

## Other platforms

| Platform | Hosts (`isXxxUrl`) | Fixer env var | Default |
|---|---|---|---|
| X / Twitter | x.com, twitter.com, mobile.twitter.com | `FIXER_TWITTER` (+ `FIXER_TWITTER_SECONDARY`) | `fxtwitter.com` (→ `vxtwitter.com`) |
| Reddit | reddit.com, old.reddit.com, redd.it | `FIXER_REDDIT` | `rxddit.com` |
| Pixiv | pixiv.net | `FIXER_PIXIV` | `phixiv.net` |
| Bluesky | bsky.app | `FIXER_BLUESKY` | `bskx.app` |
| Facebook | facebook.com, m.facebook.com, fb.watch | `FIXER_FACEBOOK` | `facebed.com` |
| Bahamut | forum.gamer.com.tw, m.gamer.com.tw | — | Custom embed via 純 fetch 快路徑（[bahamut-fetch.js](../src/bahamut-fetch.js)，~150-460ms），miss 才退 playwright probe（`[preview] bahamut-custom ... source=http|probe`）；登入 cookie 兩條路都吃。 Embed image = 文章第一張圖（GIF 會動）, og:image 只在文章沒圖時墊底（全站預設的 `bahaLOGO_*` 不算，純文字文就不放圖）；description 取 `.c-article__content` 的 innerText 保留原文分行（og:description 會把換行壓平，只當後備）；文章有 YouTube 嵌入時第一支影片網址當 message content，讓 Discord 自己 unfurl 出播放器（bot embed 塞不了播放器）。標題砍掉「@板名 哈啦板 - 巴哈姆特」尾巴、author 只留「暱稱 (帳號)」。restricted board → public-summary embed with login notice。場外（兒少保護警示）：設了 `BAHA_USER_ID`/`BAHA_PASSWORD` 就帶登入 cookie probe（被牆 → 強制重登再試一次），沒設或仍被牆 → 警示文字不當摘要、退回原連結 |
| PTT | ptt.cc | — | Custom embed via 純 fetch 快路徑（[ptt-fetch.js](../src/ptt-fetch.js)：靜態 HTML + `over18=1` cookie，~5-90ms）；miss（404 / 被導去年齡牆 / 版型改動）才退 playwright probe。兩條路吐同一個 metadata shape，`[preview] ptt-custom ... source=http|probe` 看得出走哪條 |

X 的 fxtwitter unfurl 會被判無效而改貼 vxtwitter 的三種情況：「This post is unavailable」殘頁、只剩「名字 (@帳號)」沒內文也沒圖、以及貼文明明有媒體（建 payload 時非同步查 `api.fxtwitter.com/status/<id>`，embed check 時才 await）卻 unfurl 成沒圖的卡。查詢失敗/逾時就不要求媒體。grep `[twitter]`。

除 Threads 外的 URL-only platforms（X / Reddit / Pixiv / Bluesky / Facebook / Bilibili-fixer-fallback / Instagram）都帶 `recoverUrls`，讓 empty-embed detector 用 OG metadata recovery。Threads 刻意不做 bot-side viewer fetch，改走 local canonical embed。

Facebook 的 OG recovery 比較特別：facebed 沒快取、每次都即時爬 Facebook（常態 2–5s），所以 `recoverStrategy` 設成 **同時抓** facebed 與 facebook.com 本身（UA=`facebookexternalhit/1.1`，逾時 15s），先回來的贏。facebook.com 對不存在/不公開的貼文會回 200 登入牆（「登入或註冊即可查看」），用 `requireOgUrl` 擋（真貼文才有 og:url）。

**Reddit short links** (`redd.it/<id>`) now correctly route to `rxddit.com/<id>` (was: falling into FixEmbed wrapper because `buildFallbackUrl` only matched `reddit.com` / `www.reddit.com`).

## Empty embed detection (`checkAndHandleEmptyEmbeds`)

For URL-only payloads (fixer links), the bot waits `EMBED_CHECK_DELAY_MS` then re-fetches the message. **Four-layer fallback** — every layer must fail before apology:

1. **Primary `content`** (fixer URL) — Discord unfurled it → done ✓
2. **`fallbackContents`**（任意長度的 ordered viewer list；舊 `fallbackContent` 自動相容成單一元素）— 每次 edit 後等待 `EMBED_CHECK_DELAY_MS`，第一個有效 unfurl 即停止 ✓
3. **`embedFallback`** (pre-built embed payload) — edit message, no further waiting needed. Done ✓
4. **OG recovery (`recoverUrls`)** — for each candidate URL, plain HTTP fetch + parse `og:title` / `og:description` / `og:image`, build a generic embed and edit. Implementation: [src/og-fallback.js](../src/og-fallback.js). Done ✓
5. **`placeholderFallback`** (content-less link card, e.g. Instagram「預覽目前無法載入」) — edit message. Ranks below OG recovery, unlike `embedFallback` which holds real metadata. Done ✓

Only if all five fail (or each is null/missing) → delete message + reply failure message. Threads payload 永遠提供 local `embedFallback`，所以 viewer 全失敗時仍保留 canonical click-through；其他平台維持原有 OG recovery / apology 行為。Returns `{ allSucceeded: false }` so [src/index.js](../src/index.js) knows NOT to suppress the user's native Discord embed.

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

## Deleting 西寶's messages (🗑️ reaction)

Handler: [src/reaction-delete.js](../src/reaction-delete.js), wired as `messageReactionAdd` in [src/index.js](../src/index.js). For the "傳錯連結想清掉誤發預覽" case — react 🗑️ on the bot's message and it deletes that message.

- **Scope**: any message authored by 西寶 (preview, AI reply, fortune, recap…), never anyone else's.
- **Emoji**: 🗑️ only (`U+1F5D1`). `isTrashEmoji` strips the optional `U+FE0F` variation selector so both `🗑` and `🗑️` match; other emoji (❌, 🚮) are ignored.
- **Context menu twin**: right-click a message → Apps > `刪除西寶訊息` (message context menu command, registered in [src/commands.js](../src/commands.js) as `DELETE_MESSAGE_COMMAND`, handled by `handleDeleteMessageContext`). Same `isAuthorizedToDelete` gate as the reaction; unlike the reaction every path replies ephemerally (interactions must be acknowledged).
- **Authorization** (conservative, to stop griefing):
  0. A **bot owner** (`BOT_OWNER_IDS` env, comma-separated user IDs) → delete, any guild, no other checks. Checked first — works even on orphaned previews whose reference is gone.
  1. The **link poster** — 西寶's preview is a `message.reply`, so `fetchReference()` gives the original author's id with no persistent state. If the reactor is that author → delete.
  2. A **`ManageMessages` mod** in that channel → delete (cleans up others' / orphaned previews).
  - Reactions from bots are ignored; a message 西寶 didn't author is never touched — owner privilege included.
- **Gap (by design, no state kept)**: if the poster deletes their *original* message first, the preview orphans and `fetchReference()` can no longer prove authorship — then only a `ManageMessages` mod or a bot owner can 🗑️ it. React on the preview *before* deleting the original, or just let a mod clear it.
- **Requires**: `GuildMessageReactions` intent + `Partials.Message/Channel/Reaction` (so a 🗑️ on a pre-restart, uncached message still fires the event). Both set in [src/index.js](../src/index.js).
- Grep `[delete]`. Authorization matrix asserted by `scripts/routing-smoke.js`; `isTrashEmoji` by `scripts/smoke.js`.
