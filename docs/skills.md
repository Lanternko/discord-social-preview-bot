# AI Skills — 用自然語言叫出特製 prompt

## 問題

排程任務（晚間故事、今日回顧）各自有一份調校過的 prompt。但在一般聊天裡跟西寶說「講個故事」，她只會用聊天人格隨手編三句話 —— 那份調校過的規格（`## ` 標題、150～300 字、單場景、融進兩則真實訊息）**完全用不到**。

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

- **group context 標頭寫著「不要直接複述」**，而故事技能正需要引用真實對話。chat 模式的規格必須明文解除那條（`…只有在你確定要寫故事、真的動筆寫的時候不算`）。同樣的手法 `target-context.js` 對模仿也做過一次。
- **`minTokens` / `minReplyChars` 是下限不是覆寫。** 入門 tier 只有 180 tokens / 300 字，一則故事會被砍在半句。已經給更多的 tier 保留自己的上限。跟 `maxReplyChars`（覆寫，voice-reply 用）語意不同，別搞混。
- **偵測負責 recall，模型負責 precision。** 觸發是**寬**的關鍵字比對（訊息裡有「故事」就載入 pack），因為自然語言要一個故事的講法列不完 —— 上線第一天就漏了「講一個關於X的故事」（主題卡在動詞跟「故事」中間，相鄰式正則比不到），而且**正則漏掉是無聲的**：技能整包沒進呼叫，你只會看到她用聊天人格隨手編三句。反過來，誤載入是**可回收的**：chat 模式 craft block 開頭有一段否決條款（「先自己判斷…如果他只是在聊到、評論某個故事，就把下面整段規格當作不存在」），她自己會退回平常聊天。所以註冊表裡**沒有任何反向 pattern** —— 「剛剛那個故事很好笑」照樣載入，照樣由她否決，這是設計不是漏洞。代價是提到「故事」的訊息多吃約 2KB system prompt。
- **寬偵測的連帶條件有兩個，改觸發時一起看：**
  1. `postProcess` 不能無條件套。`sanitizeBedtimeTitle` 會硬把第一行改成 `## `，套在一則普通聊天回覆上比原本的 bug 還糟。`normalizeStoryOutput` 先用 `looksLikeStory`（標題行＋空行＋內文）確認形狀才動手。
  2. group context 的「不要直接複述」解除條款必須綁在「她真的決定要寫」上，否則她否決了故事、卻照樣去複述群組訊息。
- **硬編碼回應不進註冊表。** 抽籤／運勢／道歉是規則式回應，不是 prompt，永遠不該送進模型。留在 `mention.js`。
- 第一個 match 獲勝，所以窄的技能要排前面。技能觸發都走寬比對之後這條更重要 —— 兩個寬 matcher 會搶同一則訊息。

## 故事的素材從哪來（chat 模式）

聊天情境下，一則故事看得到四塊東西：

| 來源 | 內容 | 成本 |
|---|---|---|
| `fetchGroupContext` | **這個頻道**最後 15 句（tier 設定） | 本來就有 |
| 群友熟悉度 roster | 誰在這個群講過多少話（名字＋發言量分級） | 本來就有 |
| 群組長期印象 | `data/guild-profiles.json` 的摘要＋觀察（群內的梗） | 本來就有 |
| **【這個群最近的其他材料】** | 其他**還熱的房間**最近幾句 ＋ **群友的常聊話題** | 技能觸發時才抓 |

最後一塊是 [src/ai/story-ingredients.js](../src/ai/story-ingredients.js)，2026-09-21 加的。之前故事只看得到「問她的那個頻道剛剛在吵什麼」，所以每則故事都長在當下那個梗上 —— 排程版沒這問題，因為它先掃整個 guild。

兩個收集器都刻意做得便宜：

- **其他房間**：不掃全部頻道（排程版在最大的群掃 62 個，放在 25s 回覆路徑裡太慢）。`lastMessageId` 這個 snowflake 本身就編碼了「這個房間最後一次有人講話是什麼時候」，所以先從 cache 挑出 6 小時內還熱的前 4 個，**只 fetch 那 4 個**，而且是 `Promise.all`（不同頻道不同 rate-limit bucket，等於一次來回）。
- **群友取向**：`data/user-profiles.json` 早就有，是觀察萃取器寫的。chain 平常只注入**說話者**的 profile，故事要的是**全體演員**的。取的是 profile 裡的 `常聊話題` 欄位而不是整段截斷 —— 整段截斷會把預算花在「說話風格」上，把真正有用的話題切在半路。

素材走 **user turn**（`extraUserContext`，chain.js 注入在 group context 前面），不是 `personaSuffix` —— 那是使用者寫的 Discord 文字，不能進 system prompt。區塊自己標著「不寫故事就完全忽略」「不要直接複述」，因為寬偵測下它也會出現在不寫故事的那些回合。

## 加新技能

1. 在 `src/ai/skills/` 建模組，export 上面那個形狀。
2. 加進 `src/ai/skills/index.js` 的 `SKILLS`（注意順序）。
3. 在 `scripts/smoke-skills.js` 加觸發的正反例 —— 反例比正例重要。
4. `npm run test:skills`。

## Phase 2（未做）

讓西寶自己決定要不要叫技能，用現有的 marker 模式（`[貼圖:名字]` 那一套）：persona 裡放一張技能表，她想用就寫 `[技能:故事]`，harness 攔截後帶著該技能的 prompt 重打一次。比 function calling 好的地方是不依賴 provider 支援 tools —— 目前 `providers.js` 完全沒有 tool calling，而且 fallback 鏈（Groq / Gemini）不會一致支援，掉下去就會無聲失去技能。成本是她選用時多一次呼叫。要注意 25s timeout（見 memory `xibao-model-quality-over-speed`）。
