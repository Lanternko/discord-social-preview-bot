# Environment Variables

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
| `MULTI_IMAGE_PREVIEW_COUNT` | `3` | Threads 多圖 carousel 顯示前 N 張。超出會截斷並掛「前往 Threads 查看完整內容」按鈕（有 video 也會掛）。clamp 上限 10（Discord 硬上限） |
| `PLAYWRIGHT_GOTO_TIMEOUT_MS` | `8000` | Inside threads-probe |
| `PLAYWRIGHT_META_WAIT_TIMEOUT_MS` | `1500` | Inside threads-probe |

## AI provider keys

| Variable | Default | Notes |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | Optional. Primary provider (paid, reliable) |
| `DEEPSEEK_MODEL` | `deepseek-chat` | `deepseek-chat` for V3.2, `deepseek-reasoner` for R1 |
| `CEREBRAS_API_KEY` | — | Optional. Second layer (Qwen free tier) |
| `CEREBRAS_MODEL` | `qwen-3-235b-a22b-instruct-2507` | OpenAI-compatible at `api.cerebras.ai/v1/chat/completions` |
| `GROQ_API_KEY` | — | Optional. Third layer (Groq free tier) |
| `GROQ_MODELS` | `llama-3.3-70b-versatile,llama-3.1-8b-instant` | Comma-separated within-Groq fallback. Legacy `GROQ_MODEL` read as single-item list |
| `GEMINI_API_KEY` | — | Optional. Last-layer fallback. **See [ai-providers.md](ai-providers.md) for billing trap** |
| `GEMINI_MODEL` | `gemini-2.0-flash` | |
| `AI_PROVIDER` | auto (full chain) | Force single provider: `deepseek`, `cerebras`, `groq`, `gemini`. Empty = full chain |
| `AI_TIMEOUT_MS` | `8000` | Per-call API timeout. Reads legacy `GEMINI_TIMEOUT_MS` if unset |
| `AI_MAX_REPLY_CHARS` | `300` | Upper bound on AI reply (safety trim). Reads legacy `GEMINI_MAX_REPLY_CHARS` if unset |
| `AI_PERSONA` | built-in 西寶 persona | System instruction — override to reshape personality |
| `AI_MEMORY_MAX_TURNS` | `8` | Per-channel short-term memory: last N exchanges (user+bot pair). In-memory only |
| `AI_MEMORY_TTL_MS` | `1800000` | Inactivity before channel memory is evicted (30 min) |
