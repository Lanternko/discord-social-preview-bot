# Environment Variables

## `/voice` voice reply

| Variable | Default | Notes |
|---|---|---|
| `TTS_SERVER_URL` | `http://127.0.0.1:8055` | Shared Arale Irodori `/tts` and `/warmup` (one process, both voices) |
| `TTS_REQUEST_TIMEOUT_MS` | `60000` | Per-request timeout, including a cold model start |
| `TTS_DEFAULT_REF_ID` | `xibao` | Must stay `xibao` on the shared server, or mood lookup would pick Arale's SI |
| `VOICE_MAX_REPLY_CHARS` | `60` | Transcript cap before sending text to TTS |

`scripts/start-voice-tts.sh` no longer starts a second Irodori on 8056. It checks that `8055` already exposes the `xibao` extra embed; if not, it calls Arale's `start_tts_irodori.sh` (bf16, extra embed + seed `1082616115`, no Arale mood tempo). Override the checkpoint with `XIBAO_VOICE_EMBED`. These settings affect only `/voice`; mentions, scheduled posts, and the existing text persona remain text-only.

| Variable | Default | Notes |
|---|---|---|
| `DISCORD_TOKEN` | *(required)* | |
| `FIXER_INSTAGRAM` | `ddinstagram.com` | Instagram fixer host |
| `FIXER_INSTAGRAM_SECONDARY` | `fxstagram.com` | Second Instagram fixer tried if primary unfurls empty |
| `FIXER_TWITTER` | `fxtwitter.com` | |
| `FIXER_THREADS` | `fixthreads.seria.moe` | |
| `FIXER_THREADS_SECONDARY` | `fzthreads.com` | Second Threads fixer tried if primary unfurls empty. Was `threadsez.net` — swapped 2026-07 because it went dead (connection refused) and `fzthreads.com` fetches sensitive/walled posts the primary can't |
| `FIXER_REDDIT` | `rxddit.com` | |
| `FIXER_PIXIV` | `phixiv.net` | |
| `FIXER_BLUESKY` | `bskx.app` | |
| `FIXER_BILIBILI` | `vxbilibili.com` | |
| `FIXER_FACEBOOK` | `facebed.com` | |
| `FIXEMBED_BASE_URL` | `https://fixembed.app/embed?url=` | Generic fallback |
| `SUPPRESS_ORIGINAL_EMBEDS` | `true` | Needs Manage Messages permission |
| `REPLY_MODE` | `reply` | `reply` or `send` |
| `THREADS_GRAPHQL_ENABLED` | `true` | Threads metadata 走 Meta 自家 GraphQL 的快路徑（見 `src/threads-graphql.js`）。設 `false` 就整條關掉、只用 Playwright probe |
| `THREADS_GRAPHQL_DOC_ID` | `7448594591874178` | GraphQL persisted query id。**Meta 會不定期換掉**，換掉後每次呼叫都回 `The GraphQL document with ID ... was not found.`，會無聲退回 probe（慢、且有 DOM 競態）。log 出現 `[threads-gql] api error` 連續刷就是該更新這個值 |
| `THREADS_GRAPHQL_APP_ID` | `238260118697367` | `X-Ig-App-Id`，Threads web 的固定值 |
| `THREADS_GRAPHQL_LSD` | `hgmSkqDnLNFckqa7t1vJdn` | `X-Fb-Lsd` token。未登入請求不驗這個值，只要求存在且與 body 的 `lsd` 一致 |
| `THREADS_GRAPHQL_TIMEOUT_MS` | `6000` | 單次 GraphQL 請求逾時。超時＝miss，退回 probe |
| `THREADS_PROBE_TIMEOUT_MS` | `15000` | Per-URL subprocess timeout。必須容得下 goto(8s) + meta settle(1.5s) + media poll(2.5s) |
| `THREADS_PROBE_MAX_CONCURRENT` | `3` | 同時執行的 probe 子行程（每個都是一整顆 chromium）。滿了就排隊，不是失敗。無上限時彼此搶 CPU → 頁面還沒 layout 就讀取 → 影片被當成沒有 |
| `THREADS_PROBE_QUEUE_TIMEOUT_MS` | `8000` | 排隊等位子的上限，超過就無視上限直接跑。避免爆量時預覽遲到好幾分鐘 —— 寧可退化成舊的搶 CPU 行為，也不要一個沒人在看的預覽 |
| `THREADS_METADATA_CACHE_TTL_MS` | `600000` | 10 min Threads metadata cache |
| `EMBED_CHECK_DELAY_MS` | `5000` | Wait before checking if URL embed unfurled |
| `MULTI_IMAGE_PREVIEW_COUNT` | `3` | Threads 多圖 carousel 顯示前 N 張。被截斷時最後一個 embed 的 description 追加 `... 還有 N 張` 提示。clamp 上限 10（Discord 硬上限） |
| `PLAYWRIGHT_GOTO_TIMEOUT_MS` | `8000` | Inside threads-probe |
| `PLAYWRIGHT_META_WAIT_TIMEOUT_MS` | `1500` | Inside threads-probe |
| `PLAYWRIGHT_MEDIA_WAIT_TIMEOUT_MS` | `2500` | 第一次讀不到媒體時，最多再輪詢多久等 `<video>` 掛上。Threads 的 video 元素比 DOMContentLoaded 晚 ~0.3–1.5s，且**不吐 og:video**，DOM 是唯一來源。純圖貼文最多多花這麼久 |
| `VIDEO_ATTACHMENT_ENABLED` | `true` | 主開關。Threads 影片 / 含影片的多圖貼文會下載 mp4 → 當 Discord 附件上傳（可播放）。設 `false` 全關，一律退回 fixer |
| `VIDEO_ATTACHMENT_GUILD_IDS` | —（空 = 全部） | 逗號分隔白名單。空 = 所有伺服器都能上傳影片（仍受下方上限保護）；填了就只有這些 guild 能用，其餘走 fixer |
| `VIDEO_ATTACHMENT_MAX_BYTES` | `0`（自動） | `0` = 用該伺服器 boost tier 的 Discord 上傳上限（25 / 50 / 100 MiB）。填正整數再往下 clamp，永遠不超過伺服器上限 |
| `VIDEO_ATTACHMENT_MAX_CONCURRENT` | `2` | 全域同時下載上限。滿了時新的影片貼文直接退回 fixer，不排隊、不堆積 |
| `VIDEO_ATTACHMENT_TIMEOUT_MS` | `20000` | 單支影片下載逾時 → 退回 fixer |

## 巴哈姆特登入（場外 bsn=60076）

場外整板掛「兒少保護警示」，未登入的 probe 只拿得到警示頁。設了帳密就用手機 App 登入 API（`api.gamer.com.tw/mobile_app/user/v3/do_login.php`，vcode 固定 `9487`，復刻 [ermiana](https://github.com/canaria3406/ermiana)）換 `BAHAENUR`/`BAHARUNE` cookie，塞進 probe 的 browser context。**帳號本身要滿 15 歲、完成手機認證、開啟「顯示敏感內容」**，否則登入了照樣被牆（log `[baha-session] still walled while logged in`）。建議開小帳，別用主帳。

| Variable | Default | Notes |
|---|---|---|
| `BAHA_USER_ID` | — | 巴哈帳號。和密碼都有才啟用；沒設 = 維持未登入行為 |
| `BAHA_PASSWORD` | — | 巴哈密碼 |
| `BAHA_SESSION_TTL_MS` | `259200000`（3 天） | session 快取多久後主動重登（in-memory，重啟會重登一次） |
| `BAHA_LOGIN_COOLDOWN_MS` | `600000` | 登入失敗後多久不再嘗試；也是「剛登入過、被牆也不強制重登」的窗口，免得每個場外連結都去撞登入 API |

## AI provider keys

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | Optional. Primary provider (paid, reliable) |
| `DEEPSEEK_MODEL` | `deepseek-chat` | `deepseek-chat` for V3.2, `deepseek-reasoner` for R1, `deepseek-v4-pro` for V4 (reasoning model) |
| `DEEPSEEK_MODEL_FREE` | `deepseek-v4-flash` | Model used by the 入門 `/ai-tier` plan when the owner DeepSeek key is available |
| `DEEPSEEK_VISION_MODEL` | `deepseek-v4-flash-vision-exp` | DeepSeek 唯一吃圖的 endpoint（2026-08-21 上線，**實驗性**，id 可能被改名/下架）。文字能力等同 v4-flash，每張圖最多 384 tokens、以 flash 費率計 |
| `VISION_ENABLED` | `true` | 設 `false` 後 @西寶 附圖只會走純文字鏈（她會說看不到） |
| `VISION_MAX_IMAGES` | `4` | 一次最多送幾張（一整排 Discord 圖片牆 ≈ 4 張，約 1.6k tokens） |
| `VISION_MAX_BYTES` | `8388608` | 單張上限。圖是我們自己下載後轉 base64 送出，太大的圖等於慢下載 + 肥 request |
| `VISION_TOTAL_MAX_BYTES` | `16777216` | 一次呼叫所有圖的總上限（base64 會膨脹 4/3，DeepSeek request body 上限 48 MiB） |
| `VISION_FETCH_TIMEOUT_MS` | `10000` | 我們去 Discord CDN 抓圖的逾時 |
| `VISION_TIMEOUT_MS` | `25000` | vision 呼叫本身的逾時，比文字的 `AI_TIMEOUT_MS` 長 |
| `DEEPSEEK_PREMIUM_GUILD_IDS` | — | Comma-separated guild IDs allowed to use 標準 / 精細 with the owner DeepSeek key instead of setting `/ai-key` |
| `AI_PEAK_PREFER_FALLBACK` | `true` | 尖峰時段（UTC 平日 01–04、06–10）把 owner key 的 DeepSeek 移到鏈尾，改由 luna 先跑；設 `false` 則永遠 DeepSeek 優先 |
| `AI_FREE_DAILY_LIMIT` | `20` | Per-guild daily DeepSeek calls for 入門 when the guild has no `/ai-key`; counters are in-memory and reset on restart |
| `DEEPSEEK_REASONING_HEADROOM` | `2048` | Extra `max_tokens` added on top of the tier budget **for DeepSeek only**. Reasoning models (`deepseek-v4-pro` / `-reasoner`) burn most of the budget on hidden `reasoning_content`; without headroom the tier's small display budget (brief=180) gets fully consumed → `finish_reason=length` with empty content. Visible length is still capped by `maxReplyChars`. Set to 0 for non-reasoning models like `deepseek-chat` if you want to save tokens |
| `KIMI_API_KEY` | — | Optional. Second provider after DeepSeek |
| `KIMI_ENABLED` | `true` | Set `false` to remove Kimi from all provider chains without deleting its key, for example while the account balance is empty |
| `KIMI_MODEL` | `kimi-k2.6` | Kimi model name |
| `GROQ_API_KEY` | — | Optional. Third layer (Groq free tier) |
| `GROQ_MODELS` | `llama-3.3-70b-versatile,llama-3.1-8b-instant` | Comma-separated within-Groq fallback. Legacy `GROQ_MODEL` read as single-item list |
| `GEMINI_API_KEY` | — | Optional. Last-layer fallback. **See [ai-providers.md](ai-providers.md) for billing trap** |
| `GEMINI_MODEL` | `gemini-2.0-flash` | |
| `AI_PROVIDER` | auto (full chain) | Force single provider: `deepseek`, `kimi`, `groq`, `gemini`. Empty = full chain; `KIMI_ENABLED=false` still keeps Kimi disabled |
| `AI_TIMEOUT_MS` | `8000` | Per-call API timeout. Reads legacy `GEMINI_TIMEOUT_MS` if unset |
| `RECAP_KIMI_TIMEOUT_MS` | `45000` | Daily-recap-only Kimi timeout; interactive replies still use `AI_TIMEOUT_MS` |
| `RECAP_DEEPSEEK_TIMEOUT_MS` | `90000` | Daily-recap-only DeepSeek timeout. Recaps explicitly keep thinking enabled and retain `DEEPSEEK_REASONING_HEADROOM` |
| `RECAP_GEMINI_TIMEOUT_MS` | `45000` | Daily-recap-only Gemini fallback timeout. The recap chain excludes Groq/Llama |
| `AI_PERSONA` | built-in 西寶 persona | System instruction template — override to reshape personality. Placeholders `{SENTENCE_MIN}` / `{SENTENCE_MAX}` are replaced per AI plan |
| `AI_MEMORY_TTL_MS` | `1800000` | Inactivity before channel memory is evicted (30 min) |
| `AI_LONG_TERM_MEMORY_ENABLED` | `true` | Enables user/guild long-term observation extraction and profile prompt blocks |
| `PROFILE_SWEEP_INTERVAL_MS` | `3600000` | Backlog-sweep cadence for passively-collected pending interactions (1 h). `0` disables the sweep |
| `EMOJI_TRUSTED_GUILD_IDS` | — | Comma-separated guild IDs whose custom emoji may be shared when the current guild is also trusted |
| `APP_EMOJI_ENABLED` | `true` | Include 西寶's own application-owned emoji library (up to 2000, usable in every guild) in her emoji table. Managed with `node scripts/app-emoji.js` |
| `STICKER_REPLY_ENABLED` | `true` | Let 西寶 post stickers (`[貼圖:名字]`). Off = the sticker table never enters the prompt, so she never tries |
| `STICKER_LIBRARY_DIR` | `<repo>/assets/stickers` | Folder of image files 西寶 can post as her own stickers. Absolute by default so a worktree/cwd change can't silently empty it |
| `STICKER_LIBRARY_MAX_BYTES` | `2097152` | Per-file cap for the sticker library (2 MB). Oversized files are skipped at load, not at send |
| `BOT_OWNER_IDS` | — | Comma-separated user IDs with owner privilege: 🗑️ deletes ANY of 西寶's messages in any guild, bypassing the poster / `ManageMessages` checks (works on orphaned previews too) |

**Reply length, memory depth, and DeepSeek model selection are now per-guild AI plan settings** (see [persona.md](persona.md) `/ai-tier` section), not env vars. The legacy `AI_MAX_REPLY_CHARS` / `AI_MEMORY_MAX_TURNS` env vars are no longer read.
