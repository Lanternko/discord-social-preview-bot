# Environment Variables

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
| `THREADS_PROBE_TIMEOUT_MS` | `10000` | Per-URL subprocess timeout |
| `THREADS_METADATA_CACHE_TTL_MS` | `600000` | 10 min Threads metadata cache |
| `EMBED_CHECK_DELAY_MS` | `5000` | Wait before checking if URL embed unfurled |
| `MULTI_IMAGE_PREVIEW_COUNT` | `3` | Threads 多圖 carousel 顯示前 N 張。超出或含 video 時，最後一個 embed 的 description 追加 `... 還有 N 張 + 影片` 提示。clamp 上限 10（Discord 硬上限） |
| `PLAYWRIGHT_GOTO_TIMEOUT_MS` | `8000` | Inside threads-probe |
| `PLAYWRIGHT_META_WAIT_TIMEOUT_MS` | `1500` | Inside threads-probe |

## AI provider keys

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | Optional. Primary provider (paid, reliable) |
| `DEEPSEEK_MODEL` | `deepseek-chat` | `deepseek-chat` for V3.2, `deepseek-reasoner` for R1, `deepseek-v4-pro` for V4 (reasoning model) |
| `DEEPSEEK_MODEL_FREE` | `deepseek-v4-flash` | Model used by the 入門 `/ai-tier` plan when the owner DeepSeek key is available |
| `DEEPSEEK_PREMIUM_GUILD_IDS` | — | Comma-separated guild IDs allowed to use 標準 / 精細 with the owner DeepSeek key instead of setting `/ai-key` |
| `AI_FREE_DAILY_LIMIT` | `20` | Per-guild daily DeepSeek calls for 入門 when the guild has no `/ai-key`; counters are in-memory and reset on restart |
| `DEEPSEEK_REASONING_HEADROOM` | `2048` | Extra `max_tokens` added on top of the tier budget **for DeepSeek only**. Reasoning models (`deepseek-v4-pro` / `-reasoner`) burn most of the budget on hidden `reasoning_content`; without headroom the tier's small display budget (brief=180) gets fully consumed → `finish_reason=length` with empty content. Visible length is still capped by `maxReplyChars`. Set to 0 for non-reasoning models like `deepseek-chat` if you want to save tokens |
| `GROQ_API_KEY` | — | Optional. Third layer (Groq free tier) |
| `GROQ_MODELS` | `llama-3.3-70b-versatile,llama-3.1-8b-instant` | Comma-separated within-Groq fallback. Legacy `GROQ_MODEL` read as single-item list |
| `GEMINI_API_KEY` | — | Optional. Last-layer fallback. **See [ai-providers.md](ai-providers.md) for billing trap** |
| `GEMINI_MODEL` | `gemini-2.0-flash` | |
| `AI_PROVIDER` | auto (full chain) | Force single provider: `deepseek`, `groq`, `gemini`. Empty = full chain |
| `AI_TIMEOUT_MS` | `8000` | Per-call API timeout. Reads legacy `GEMINI_TIMEOUT_MS` if unset |
| `AI_PERSONA` | built-in 西寶 persona | System instruction template — override to reshape personality. Placeholders `{SENTENCE_MIN}` / `{SENTENCE_MAX}` are replaced per AI plan |
| `AI_MEMORY_TTL_MS` | `1800000` | Inactivity before channel memory is evicted (30 min) |
| `AI_LONG_TERM_MEMORY_ENABLED` | `true` | Enables user/guild long-term observation extraction and profile prompt blocks |
| `EMOJI_TRUSTED_GUILD_IDS` | — | Comma-separated guild IDs whose custom emoji may be shared when the current guild is also trusted |

**Reply length, memory depth, and DeepSeek model selection are now per-guild AI plan settings** (see [persona.md](persona.md) `/ai-tier` section), not env vars. The legacy `AI_MAX_REPLY_CHARS` / `AI_MEMORY_MAX_TURNS` env vars are no longer read.
