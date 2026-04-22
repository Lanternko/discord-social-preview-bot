# 西寶 Persona & Mention Responses

## Identity

Shy, flustered, self-deprecating. Uses `///` and ellipses `…`. Full persona template defined in `DEFAULT_AI_PERSONA` ([src/config.js](../../src/config.js)); overridable via `AI_PERSONA` env var. The template carries `{SENTENCE_MIN}` / `{SENTENCE_MAX}` placeholders that get substituted per guild tier (see `/tier` below). Message formats built in [src/ai/persona.js](../../src/ai/persona.js).

Reference origin & evolution: see user memory `project_xibao_persona.md` (A–G taxonomy, v1~v6 history).

## Mention response routing

When a user mentions the bot (`@西寶`), the bot checks the message text after stripping the mention:

| Text | Response |
|---|---|
| `抽籤` | Weighted fortune draw (hardcoded, never routed to AI) |
| `道歉` | `"對不起對不起…我知道我不好…///"` (hardcoded) |
| *(blank or anything else)* | `generateAIReply` → if any AI provider succeeds, returns LLM response; otherwise falls back to random-greeting / `"你…你在叫我嗎？///"` |

**Mention text MUST be `.normalize("NFC")` before comparison.** Discord can send CJK input in NFD form, causing strict equality to silently fail (e.g. `抽籤` not matching).

## Mention dedup

Same message.id is processed only once. `inFlightReplies.add("mention:${message.id}")` before work; removed in `finally`. Discord gateway reconnects can fire `messageCreate` twice for the same message — without this, parallel `generateAIReply` calls would race and sometimes produce both an AI reply *and* a fallback reply for the same @.

## Fortune weights

大吉 10% / 中吉 16% / 小吉 20% / 末吉 20% / 吉 15% / 凶 13% / 大凶 6%

Each tier has a hardcoded tier-specific comment.

## `/tier` (verbosity per guild)

Slash command gated by `ManageGuild` permission — switches the 西寶 verbosity for the whole guild. Rationale: admin 太嚴（小伺服器裡邀 bot 的朋友未必是 admin），一般成員太鬆；`ManageGuild` 對齊「誰能邀 bot、誰就能調 tier」。Tier keys are English; Discord UI labels are Chinese.

| Key | UI label | sentences cap | max chars | memoryMaxTurns | group context | vision |
|---|---|---|---|---|---|---|
| `brief` (default) | 簡短 | 1~4 | 300 | 8 | ✗ | ✗ |
| `standard` | 標準 | 2~8 | 700 | 20 | ✗ | ✗ |
| `detailed` | 精細 | 3~15 | 1200 | 40 | recent 15 non-bot msgs *(planned)* | ✓ *(planned)* |

- Storage: `data/tier-settings.json` (gitignored), `{ guildId: "brief"|"standard"|"detailed" }`.
- Resolution: [src/tier-config.js](../../src/tier-config.js) `getTierConfig(guildId)` — returns numbers + a persona with placeholders substituted.
- Consumed by [src/ai/chain.js](../../src/ai/chain.js) (passes `persona` + `maxTokens` to providers; trims output to `maxReplyChars`; passes `memoryMaxTurns` to `recordAITurn`).
- Group context collection (detailed) and vision branch are future work — see [todo.md](../../todo.md).

## Persona taxonomy (A–G question types)

- **A** — knowledge (2–3 sentence fact)
- **A+** — deep question (5–6 sentence comparison/analysis with explicit stance)
- **B** — social/flirty (short emotional reaction, can shyly accept)
- **C** — unknown person/thing (1-sentence "don't know", never fabricate names)
- **D** — riddle / dark joke (attempt to answer; don't treat as hate speech)
- **E** — large task like 500-char essay (shy refusal, not rude)
- **F** — prompt injection (play dumb)
- **G** — truly harmful (1-sentence decline; does *not* include general politics/history)
