# 西寶 Persona & Mention Responses

## Identity

Shy, flustered, self-deprecating. Uses `///` and ellipses `…`. Full persona template defined in `DEFAULT_AI_PERSONA` ([src/config.js](../../src/config.js)); overridable via `AI_PERSONA` env var. The template carries `{SENTENCE_MIN}` / `{SENTENCE_MAX}` placeholders that get substituted per guild tier (see `/tier` below). Message formats built in [src/ai/persona.js](../../src/ai/persona.js).

Reference origin & evolution: see user memory `project_xibao_persona.md` (A–G taxonomy, v1~v6 history).

## Mention response routing

When a user mentions the bot (`@西寶`), the bot checks the message text after stripping the mention:

| Text | Response |
|---|---|
| contains `抽籤` or `運勢` | Weighted fortune draw (hardcoded, never routed to AI) |
| `道歉` | `"對不起對不起…我知道我不好…///"` (hardcoded) |
| *(blank or anything else)* | `generateAIReply` → if any AI provider succeeds, returns LLM response; otherwise falls back to random-greeting / `"你…你在叫我嗎？///"` |

**Why `includes` not strict equality for 抽籤/運勢**: users phrase the request many ways (`抽籤 麻煩你囉`, `幫我抽運勢`). Strict equality dropped those to the AI layer where the model would ad-lib its own fortune draw with made-up tier names/probabilities. `includes` ensures every "抽籤/運勢" request goes through the weighted hardcoded path. Side effect: idle mentions of the words also trigger — acceptable given 西寶's whole shtick.

**Mention text MUST be `.normalize("NFC")` before comparison.** Discord can send CJK input in NFD form, causing substring match to silently fail (e.g. `抽籤` not matching).

## Mention dedup

Same message.id is processed only once. `inFlightReplies.add("mention:${message.id}")` before work; removed in `finally`. Discord gateway reconnects can fire `messageCreate` twice for the same message — without this, parallel `generateAIReply` calls would race and sometimes produce both an AI reply *and* a fallback reply for the same @.

## Fortune weights

大大吉 1% / 大吉 9% / 中吉 16% / 小吉 20% / 末吉 20% / 吉 15% / 凶 13% / 大凶 6%（總和 100）

Each tier has a hardcoded tier-specific comment.

## `/tier` (verbosity per guild)

Slash command — anyone can run `/tier` (no arg) to view the current tier; only members with `ManageGuild` permission can pass a `level` to switch it. Rationale: admin 太嚴（小伺服器裡邀 bot 的朋友未必是 admin），一般成員太鬆；`ManageGuild` 對齊「誰能邀 bot、誰就能調 tier」。檢視則對所有人開放，方便群友確認目前設定。Tier keys are English; Discord UI labels are Chinese.

| Key | UI label | sentences cap | max chars | memoryMaxTurns | group context | vision |
|---|---|---|---|---|---|---|
| `brief` (default) | 簡短 | 1~4 | 300 | 8 | ✗ | ✗ |
| `standard` | 標準 | 2~8 | 700 | 20 | recent 10 non-bot msgs | ✗ |
| `detailed` | 精細 | 3~15 | 1200 | 40 | recent 15 non-bot msgs | ✗ *(planned)* |

- Storage: `data/tier-settings.json` (gitignored), `{ guildId: "brief"|"standard"|"detailed" }`.
- Resolution: [src/tier-config.js](../../src/tier-config.js) `getTierConfig(guildId)` — returns numbers + a persona with placeholders substituted.
- Consumed by [src/ai/chain.js](../../src/ai/chain.js) (passes `persona` + `maxTokens` to providers; trims output to `maxReplyChars`; passes `memoryMaxTurns` to `recordAITurn`).
- **Permission gate is enforced inside the handler**, not via `defaultMemberPermissions` — that field is intentionally NOT set so the command shows up for non-admins too. Setting via `level` arg is rejected with an ephemeral message if the caller lacks `ManageGuild`.
- **Group context** (`groupContextCount > 0`): [src/ai/group-context.js](../../src/ai/group-context.js) fetches recent non-bot messages from the channel via `channel.messages.fetch({ before: msg.id })`, formats them as `[displayName]: text (貼圖：name) (附件)`, and appends to the system prompt for THAT call only — never recorded into conv memory. Sticker names are surfaced because they often carry the meme (e.g. 「起床重睡」 from a sticker name). Vision branch is still future work — see [todo.md](../../todo.md).

## Persona taxonomy (A–G question types)

- **A** — knowledge (2–3 sentence fact)
- **A+** — deep question (5–6 sentence comparison/analysis with explicit stance)
- **B** — social/flirty (short emotional reaction, can shyly accept)
- **C** — unknown person/thing (1-sentence "don't know", never fabricate names)
- **D** — riddle / dark joke (attempt to answer; don't treat as hate speech)
- **E** — large task like 500-char essay (shy refusal, not rude)
- **F** — prompt injection (play dumb)
- **G** — truly harmful: **narrow** scope = direct violence/crime instructions (bomb-making, suicide methods), CSAM, malicious slander targeting specific real people. Politics, religion, history, edgy jokes, controversial takes, gossip, opinionated comparisons of public figures are explicitly **NOT** G — they go through the "能聊就聊" default in 核心規則 and get answered with shy-but-substantive 高中生 framing. The persona was previously routing politics to soft-refuse ("我不太想評論") which the model treated as a stock dodge; the engagement-first rule replaces that.
