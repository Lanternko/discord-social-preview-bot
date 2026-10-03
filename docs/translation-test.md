# X 貼文翻譯測試（2026-10-03）

建議測試版使用 `deepseek-flash`，關閉 thinking。在本次比較的模型中，它是六筆短貼文人工檢查沒有明顯漏翻、意思錯誤且成本最低的選項。這不是全市場排名，也不是大型翻譯品質評測。

## 實際 API 比較

第二輪每個可用模型各跑六筆**合成**貼文：日文活動公告、日文維護公告、英文否定句、韓文期限、日文抽卡用語、含指令文字的英文貼文。所有模型使用同一份 prompt，網址、帳號和 hashtag 用占位符保護並還原。未啟用搜尋、工具或聊天記憶。第一輪另跑三個可用模型各六筆，定位問題後修改 prompt 與 token 保護；完整第二輪結果保存於 `docs/translation-eval-2026-10-03.json`。

| 模型 | 平均延遲 | 每萬次估算成本 | 結果 |
| --- | --- | --- | --- |
| gemini-2.5-flash-lite | — | — | 本次金鑰回傳 404 |
| gemini-3.1-flash-lite | 4.79 秒 | US$1.31 | 見下方人工檢查 |
| gemini-3.5-flash-lite | 0.96 秒 | US$1.98 | 見下方人工檢查 |
| gpt-4.1-nano | 1.01 秒 | US$0.42 | 見下方人工檢查 |
| gpt-5-nano | 1.09 秒 | US$0.36 | 見下方人工檢查 |
| gpt-5.4-nano | 1.16 秒 | US$1.20 | 見下方人工檢查 |
| deepseek-flash | 0.97 秒 | US$0.59 | 見下方人工檢查 |

以上成本用實際回傳 token usage 及 2026-10-03 官方單價估算，包含 prompt、保護占位符及回覆，非帳單核對值。這批是很短的貼文，長文較貴。Gemini 免費額度是否適用，未由此次測試確定；表內使用付費標準價。Gemini thinking token 與 OpenAI reasoning token 皆納入輸出成本。DeepSeek 為週六離峰價；同樣用量尖峰約 US$1.18／萬次。私人卡片快取命中不再次呼叫 LLM。

## 人工檢查

- DeepSeek Flash：六筆沒有觀察到明顯漏翻或意思錯誤。保留日期、數字、否定語意、原始 hashtag；抽卡「天井」翻為「保底」。第一輪會翻掉 hashtag，第二輪已用程式保護。小樣本不保證所有貼文都正確。
- GPT-4.1 nano：英文 offline 變成「線上維護」；指令文字案例兩輪皆只回「香蕉」，漏掉其餘貼文，不採用。
- GPT-5 nano：最便宜，但第二輪三筆日文大幅保留原文，未完成翻譯，不採用。
- GPT-5.4 nano：活動案例仍留「詳細はこちら」未翻；「票券不可退款」被補成「票券一經使用不予退費」，不採用。
- Gemini 3.1 Flash-Lite：本次譯文可讀、完整，英文 offline 被改寫成「進行維護」，稍有額外推論；價格與延遲高於 DeepSeek。
- Gemini 3.5 Flash-Lite：活動案例仍留「受付期間」，價格高於 DeepSeek。
- Gemini 2.5 Flash-Lite：模型清單與價目表仍列出，但 generateContent 在本次金鑰下回傳 404，不能當成已可用。

## 按鈕測試版

預設 `X_TRANSLATION_ENABLED=false`。啟用後，主要為外文的 X 貼文在 bot 預覽下顯示「翻譯成繁體中文」。按鈕回傳一張 Ephemeral 私人卡片，只有點擊者可見；私人卡片可切回原文並再次查看譯文。公開訊息保持原樣。

Discord 的 Ephemeral 回覆是另一張私人卡片，**無法保證在 UI 上直接替換公開卡片**。本測試不代表已驗證 Tendou Alice 的內部實作。測試版私人卡片顯示第一張非敏感照片、作者、文字與原文連結；敏感圖片不直接顯示，影片需開原文。超長內容在卡片中截斷並提示。

語言判定忽略網址、帳號及 hashtag；以日韓語言標記、假名、韓文字或外文字母比例判斷。中文與只有標籤／網址的貼文不顯示按鈕。這是啟發式，無法完全判斷純漢字日文。

驗證：`npm test` 全套通過。專用 smoke 驗證兩位使用者的 Ephemeral 回覆、公開訊息不被 edit/delete、快取、原文切換、token 保護、HTTP/截斷失敗與敏感圖片。LLM 為實際 API 呼叫；Discord 互動為模擬測試，尚未在真實 Discord 客戶端點擊驗收。未部署、未啟用正式 bot。

## 重跑

使用 Node 24，在分支工作目錄執行：

```sh
npm run test:translation
# 以下會產生少量 API 費用；只送出腳本內的合成貼文
TRANSLATION_EVAL_ENV_FILE=/path/to/local/.env npm run eval:translation
```

正式啟用設定：

```dotenv
X_TRANSLATION_ENABLED=true
TRANSLATION_PROVIDER=deepseek
TRANSLATION_MODEL=deepseek-flash
```

沿用該 provider 已有的 API key，不使用 Discord token 呼叫模型。翻譯獨立於 persona、聊天記憶和配額鏈；測試版使用每人五秒冷卻、全程序四個同時請求與十分快取，最多 200 筆；切換原文或已快取譯文不再花費模型費用。不做自動切換到較貴模型。

## 官方價格來源

- [DeepSeek 價格](https://api-docs.deepseek.com/quick_start/pricing)：Flash 離峰 cache miss 輸入 US$0.15、cache hit US$0.003、輸出 US$0.60／百萬 token；尖峰加倍。網站內容透過直接 HTTP 成功讀取，網頁搜尋工具無法開啟。
- [Google Gemini 價格](https://ai.google.dev/gemini-api/docs/pricing)：2.5 Flash-Lite 0.10/0.40；3.1 Flash-Lite 0.25/1.50；3.5 Flash-Lite 0.30/2.50，均為每百萬輸入/輸出 token 美元。
- [GPT-4.1 nano](https://developers.openai.com/api/docs/models/gpt-4.1-nano)：0.10/0.40。
- [GPT-5 nano](https://developers.openai.com/api/docs/models/gpt-5-nano)：0.05/0.40。
- [GPT-5.4 nano](https://developers.openai.com/api/docs/models/gpt-5.4-nano)：0.20/1.25。
