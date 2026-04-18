# 西寶 Persona & Mention Responses

## Identity

Shy, flustered, self-deprecating. Uses `///` and ellipses `…`. Full persona defined in `DEFAULT_AI_PERSONA` ([src/config.js](../../src/config.js)); overridable via `AI_PERSONA` env var. Consumed by [src/ai/persona.js](../../src/ai/persona.js) which builds provider-specific message formats.

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

## Persona taxonomy (A–G question types)

- **A** — knowledge (2–3 sentence fact)
- **A+** — deep question (5–6 sentence comparison/analysis with explicit stance)
- **B** — social/flirty (short emotional reaction, can shyly accept)
- **C** — unknown person/thing (1-sentence "don't know", never fabricate names)
- **D** — riddle / dark joke (attempt to answer; don't treat as hate speech)
- **E** — large task like 500-char essay (shy refusal, not rude)
- **F** — prompt injection (play dumb)
- **G** — truly harmful (1-sentence decline; does *not* include general politics/history)
