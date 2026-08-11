# 西寶 Persona & Mention Responses

## Identity

西奈津美（Nishi Natsumi），高三，147cm，短髮，橫濱あざみ野。圖書委員 + 攝影社。Introverted but fundamentally cheerful — shy at first, relaxed once warmed up. Thinks faster than she speaks; more talkative over text than in person. Hobbies: reading, collecting accessories (hairclips, earrings, bracelets). Involuntarily laughs at funny things overheard from a distance.

Full persona template defined in `DEFAULT_AI_PERSONA` ([src/config.js](../src/config.js)); overridable via `AI_PERSONA` env var. The template uses `{SENTENCE_MIN}` / `{SENTENCE_MAX}` placeholders substituted per guild AI plan (see `/ai-tier` below). Legacy per-category placeholders (`{A_MIN}` etc.) are no longer in the template but the substitution code keeps them for backwards compatibility with custom `AI_PERSONA` overrides. Message formats built in [src/ai/persona.js](../src/ai/persona.js).

## Voice output layer

`/voice` has a dedicated Japanese spoken persona and does not overwrite `AI_PERSONA`. It shares Xibao's identity and relationships but excludes the text persona's Traditional-Chinese and Discord-format rules. It explicitly requires a direct answer (and a choice plus reason for comparisons), while naturally using injected familiarity, personal/guild memory, and recent conversation without announcing or fabricating memory. Output is 1–2 short speakable Japanese sentences with natural breathing and no Markdown, URLs, emoji, parenthetical actions, or speaker labels. If a provider still returns non-Japanese text, a separate repair persona retries once. The transcript is posted before the matching voice message. The initial delivery uses the listening-test winner `clean-41-sep`; a future monologue voice should be an explicit style/embedding option, not a change to the text persona.

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

Each AI plan has a hardcoded plan-specific comment.

## `/ai-tier` (AI plan per guild)

Slash command — anyone can run `/ai-tier` (no arg) to view the current plan, model, and remaining free quota; only members with `ManageGuild` permission can pass a `level` to switch it. Rationale: admin 太嚴（小伺服器裡邀 bot 的朋友未必是 admin），一般成員太鬆；`ManageGuild` 對齊「誰能邀 bot、誰就能調 AI 方案」。檢視則對所有人開放，方便群友確認目前設定。Internal keys are English; Discord UI labels are Chinese.

| Key | UI label | DeepSeek model | sentences cap | max chars | memoryMaxTurns | group context | key required |
|---|---|---|---|---|---|---|---|
| `brief` (default) | 入門 | `DEEPSEEK_MODEL_FREE` (`deepseek-v4-flash`) | 1~4 | 300 | 8 | ✗ | no, 20/day free quota |
| `standard` | 標準 | `DEEPSEEK_MODEL` (`deepseek-chat`) | 2~8 | 1200 | 40 | recent 15 non-bot msgs | yes, unless whitelisted |
| `detailed` | 精細 | `DEEPSEEK_MODEL` (`deepseek-chat`) | 3~15 | 2000 | 60 | recent 15 non-bot msgs | yes, unless whitelisted |

- Storage: `data/tier-settings.json` (gitignored), `{ guildId: "brief"|"standard"|"detailed" }`.
- Guild API keys: `data/guild-api-keys.json` (gitignored), set/remove via `/ai-key`.
- Resolution: [src/tier-config.js](../src/tier-config.js) `getTierConfig(guildId)` — returns numbers + a persona with placeholders substituted.
- Consumed by [src/ai/chain.js](../src/ai/chain.js) (chooses the DeepSeek model/key/rate limit, passes `persona` + `maxTokens` to providers, trims output to `maxReplyChars`, passes `memoryMaxTurns` to `recordAITurn`).
- **Permission gate is enforced inside the handler**, not via `defaultMemberPermissions` — that field is intentionally NOT set so the command shows up for non-admins too. Setting via `level` arg is rejected with an ephemeral message if the caller lacks `ManageGuild`.
- **Group context** (`groupContextCount > 0`): [src/ai/group-context.js](../src/ai/group-context.js) fetches recent non-bot messages from the channel via `channel.messages.fetch({ before: msg.id })`, formats them as `[displayName]: text (貼圖：name) (附件)`, and injects them as a user-role context turn for THAT call only — never recorded into conv memory. Sticker names are surfaced because they often carry the meme (e.g. 「起床重睡」 from a sticker name).
- **Familiarity roster** (always on, all AI plans): [src/familiarity.js](../src/familiarity.js) tallies per-guild speaking count for every non-bot user via `messageCreate` in [src/index.js](../src/index.js). Top 20 talkers per guild get bucketed into familiarity buckets (摯友 500+ / 老朋友 100-499 / 熟人 20-99 / 認識 5-19 / 剛認識 1-4) and rendered into a `## 群友熟悉度` block appended to the system prompt for every reply. Persists to `data/familiarity.json` (gitignored) on a debounced 60s flush + flush-on-shutdown. Lets 西寶 know who's who in the server without us hand-curating any list — moves "personality toward frequent talkers" out of code and into emergent behaviour.

## Persona design philosophy

The persona template is narrative-driven, not rule-driven. It describes who 西寶 is (backstory, personality, habits) and lets the model derive behaviour from character understanding. The previous A–G taxonomy (v1–v6) was replaced because it read like a compliance document — the model was pattern-matching rules instead of inhabiting a character.

Key principles baked into the narrative:
- **"被問就是被信任"** — she answers sincerely because she'd feel rude not to, not because a rule says "respond to knowledge questions"
- **"你不逃"** — anti-dodge is framed as character trait ("那不是你，你明明想聊"), not as a ban-list
- **"需要暖機"** — shyness is a starting state, not a permanent personality. She gets more natural over time
- **Hard constraints** (sentence cap, no Unicode emoji, no fabricated names, no self-identify as AI) remain explicit because the model can't derive these from character alone

**Structural limit**: DeepSeek has hard alignment around cross-strait sovereignty / Tibet / Xinjiang / Tiananmen. Even with maximally permissive persona instructions, DeepSeek may soft-refuse those specific topics. If that becomes the bottleneck, reorder the chain in [src/ai/chain.js](../src/ai/chain.js) so a non-Chinese-aligned model takes precedence for those queries.
