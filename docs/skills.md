# AI Skills — 用自然語言叫出特製 prompt

## 問題

排程任務（晚間故事、今日回顧）各自有一份調校過的 prompt。但在一般聊天裡跟西寶說「講個故事」，她只會用聊天人格隨手編三句話 —— 那份調校過的規格（`## ` 標題、180～420 字、單場景、融進兩則真實訊息）**完全用不到**。

Skill registry 讓同一份規格可以被「問」出來。

## 機制

`src/ai/skills/` 是註冊表。每個技能一個模組：

```js
module.exports = {
  id: "story",
  label: "說故事",
  match(text) -> boolean,            // 本地正則，零 API 成本
  build({ message, text }) -> {      // 可 async
    personaSuffix,                   // 規格 —— 進 system prompt
    minTokens, minReplyChars,        // 這個輸出格式需要的預算下限
    postProcess,                     // 可選：正規化輸出格式
  },
};
```

[src/mention.js](../src/mention.js) 在呼叫 `generateAIReply` 前先 `detectSkill(text)`，把 pack 折進**本來就要發生的那一次**呼叫。**零額外 API call、零額外延遲。**

## 為什麼規格走 `personaSuffix` 而不是 user turn

排程路徑把規格和素材揉成一個 user-role 字串（[src/scheduler.js](../src/scheduler.js) 的 `turns = [{ role: "user", content: prompt }]`）。排程情境下無所謂，但聊天情境下兩者必須分開：

- **規格**是「怎麼寫」的指示，跟人格同一層級 → `personaSuffix`（system role，接在 persona 尾端、group context 之前，維持 DeepSeek 前綴快取）。
- **素材**在聊天情境下就是 chain 已經注入的 `【最近群組對話】` user turn，不需要另外撈。

所以 [src/bedtime-story.js](../src/bedtime-story.js) 拆成 `buildStoryCraftBlock({ mode })` + `buildStoryIngredientsBlock()`；`buildBedtimeStoryPrompt` 照舊把兩塊組起來，排程輸出 **byte-identical**（`scripts/smoke-skills.js` 守著）。

## 坑

- **group context 標頭寫著「不要直接複述」**，而故事技能正需要引用真實對話。chat 模式的規格必須明文解除那條（`那份紀錄平常標著「不要直接複述」，寫故事這次不算`）。同樣的手法 `target-context.js` 對模仿也做過一次。
- **`minTokens` / `minReplyChars` 是下限不是覆寫。** 入門 tier 只有 180 tokens / 300 字，一則故事會被砍在半句。已經給更多的 tier 保留自己的上限。跟 `maxReplyChars`（覆寫，voice-reply 用）語意不同，別搞混。
- **誤判很貴。** 不像 `detectImitationIntent` 可以放寬 —— 故事技能誤觸會讓她寫 400 字而不是聊天。所以觸發要求動詞貼著「故事」，而且先用 `STORY_REFERENCE_RE` 擋掉「剛剛那個故事很好笑」這種**在談論**故事的句子。
- **硬編碼回應不進註冊表。** 抽籤／運勢／道歉是規則式回應，不是 prompt，永遠不該送進模型。留在 `mention.js`。
- 第一個 match 獲勝，所以窄的技能要排前面。

## 加新技能

1. 在 `src/ai/skills/` 建模組，export 上面那個形狀。
2. 加進 `src/ai/skills/index.js` 的 `SKILLS`（注意順序）。
3. 在 `scripts/smoke-skills.js` 加觸發的正反例 —— 反例比正例重要。
4. `npm run test:skills`。

## Phase 2（未做）

讓西寶自己決定要不要叫技能，用現有的 marker 模式（`[貼圖:名字]` 那一套）：persona 裡放一張技能表，她想用就寫 `[技能:故事]`，harness 攔截後帶著該技能的 prompt 重打一次。比 function calling 好的地方是不依賴 provider 支援 tools —— 目前 `providers.js` 完全沒有 tool calling，而且 fallback 鏈（Groq / Gemini）不會一致支援，掉下去就會無聲失去技能。成本是她選用時多一次呼叫。要注意 25s timeout（見 memory `xibao-model-quality-over-speed`）。
