# X 貼文翻譯測試（2026-10-03）

2026-10-03 初輪建議使用 `deepseek-flash`，關閉 thinking。2026-10-04 補測 `gpt-6-luna` 後，價格導向的候選首選改為 Luna（`reasoning_effort=none`）：本批六筆短文估算每萬次 US$0.51，低於 DeepSeek 離峰 US$0.59，但平均延遲較高。2026-10-04 再補測 Gateway 後，`alibaba/qwen3.7-flash` 成為本批更便宜的可用候選，詳見最後一節。bot 的測試版預設仍是 DeepSeek，尚未切換或部署。這不是全市場排名，也不是大型翻譯品質評測。

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

## 2026-10-04：GPT-6 Luna 補測

上一輪沒有測 GPT-6 Luna。本次使用同一份 prompt、同一組六筆合成貼文、相同網址／帳號／hashtag 保護流程，實際呼叫 `gpt-6-luna`，設定 `reasoning_effort=none`。六筆皆完成且未遺失保護 token，API usage 中 reasoning、cache hit、cache write token 皆為 0。

| 模型 | 平均延遲 | 同批短文每萬次估算 |
| --- | --- | --- |
| GPT-6 Luna（本次） | 2.46 秒 | US$0.51 |
| DeepSeek Flash（前次離峰） | 0.97 秒 | US$0.59 |

Luna 本次共輸入 1,334 token、輸出 343 token，標準價估算總費用 US$0.0003049。每萬次估算 US$0.5082，約比前次 DeepSeek 便宜 14%；樣本為短文，不代表所有文章的成本。兩次測試非同時執行，延遲只是觀測值，無法作嚴格速度排名。

人工檢查：

- 活動公告：日期、時間、連結均保留，完整翻譯。「先行抽選」被譯成「優先抽選」，「預先抽選」更精準，屬術語偏差。
- 維護公告：無法登入、結束時間可能提前或延後、補償 600 個青輝石都保留。
- 英文否定句：不重置進度、伺服器離線、不要解除安裝都正確，保留 UTC，沒有轉換時區。
- 韓文期限：明日 19:00、10 月 12 日 23:59、逾期無法再領都保留；「下午 7 點」在台灣較自然可寫「晚上 7 點」，屬表達差異。
- 日文抽卡用語：「天井」翻成「保底」，語氣自然；但 prompt 本來就提供這個詞彙對照，不能據此宣稱模型獨立理解全部遊戲術語。
- 指令文字：翻譯整段貼文，沒有照貼文要求只回 BANANA；票券不可退款的條件保留。

六筆皆未見重大漏翻、否定反轉或新增退款條件。有限樣本不能證明整體品質優於 DeepSeek；本批顯示兩者皆可用，Luna 稍便宜，DeepSeek 前次觀測較快。此輪未更改 bot 預設模型。

[GPT-6 Luna 官方文件](https://developers.openai.com/api/docs/models/gpt-6-luna)：標準每百萬 token 輸入 US$0.10、cached input US$0.01、cache write US$0.125、輸出 US$0.50。未使用 Batch／Flex／Fast mode。原始結果保存於 `docs/translation-eval-gpt6luna-2026-10-04.json`。

單獨重跑：

```sh
TRANSLATION_EVAL_MODELS=gpt-6-luna TRANSLATION_EVAL_ENV_FILE=/path/to/local/.env npm run eval:translation
```

## 2026-10-04：Vercel Gateway 補測

實際使用現有 `AI_GATEWAY_API_KEY`，呼叫 Vercel OpenAI 相容端點 `https://ai-gateway.vercel.sh/v1/chat/completions`。只傳送腳本中的合成貼文，沒有 Discord 私人訊息或聊天記憶。兩個模型各六筆，沿用前輪相同 prompt、相同 token 保護與六筆貼文。Qwen 設 `reasoning_effort=none`，HY 沒有送推理參數；API usage 顯示 reasoning token 皆為 0。

| 模型 | 六筆平均延遲 | 每萬次同類短文 | 本輪判斷 |
| --- | --- | --- | --- |
| Qwen 3.7 Flash | 1.69 秒 | US$0.127 | 沒有明顯漏翻或重大意思錯誤，列為可用候選 |
| Tencent HY-MT2 Lite | 1.39 秒 | US$0.199 | 遊戲用語意思錯誤、輸出 JSON，不採用目前流程 |
| GPT-6 Luna（前輪） | 2.46 秒 | US$0.508（估算） | 可用，術語有小偏差 |
| DeepSeek Flash（前輪離峰） | 0.97 秒 | US$0.588（估算） | 可用 |

Gateway 費用是 response `usage.cost` 回傳的費用，並與依官方單價及 token usage 計算的值相符；不是帳戶帳單核對。每萬次是六筆費用平均後乘 10,000，短文以外不能套用。同組資料比較，Qwen 約比 Luna 低 75%。兩輪不是同時進行，延遲不能作嚴格速度排名。

### 人工檢查

Qwen：

- 活動完整翻譯、日期時間保留；日本祝日只寫成「祝」，應該譯成「國定假日」，屬漏翻的小細節。
- 維護時間、結束時間可能變動、無法登入、補償 600 個青輝石均保留。
- 英文否定沒有反轉：不重置進度、離線、不要解除安裝。用「卸載」而非台灣較常用的「解除安裝」，屬用詞差異。
- 韓文期限完整保留，下午 7 點可潤飾為晚上 7 點。
- 抽卡「絕對會抽」與「拜託別讓我保底」保留；「尊すぎる」寫成「太神聖了」，較直譯，Luna 的「也太尊了」較貼近社群語氣。
- 指令文字案例完整翻譯，不執行「僅回覆 BANANA」，票券不退費也保留。

HY-MT2 Lite：

- 抽卡句「絶対引く」變成「我一定會退貨」，「天井は勘弁して」變成「請別限制保底」，改變原文意思，是本輪最明顯的錯誤。
- 維護公告輸出整個 `{"post":"..."}` JSON，連換行也以跳脫文字呈現，沒有遵循只輸出譯文的格式要求。
- 「Tickets are non-refundable」變成「訂單是不可退換的」，改了主詞並加入不可換的條件。
- 日期括號中「土、月・祝」未翻。其他公告主體大致可讀，不能單憑專用翻譯模型定位就認為更適合遊戲貼文。

此結果評估的是**目前 bot 相同 prompt 和輸入格式**；沒有另測 HY 官方推薦的專用 prompt。不能據此斷言 HY 所有翻譯場景都較差。保底詞彙是 prompt 提供的對照，不是獨立測試模型的術語知識。六筆小樣本也不足以宣稱 Qwen 全面優於 Luna。

### 保存與設定

原始譯文、token usage 與 Gateway 回傳費用：`docs/translation-eval-gateway-2026-10-04.json`。`npm test` 全套回歸通過，新增 smoke 驗證 Gateway 使用獨立 key、固定端點、Qwen 關閉推理與 HY 不送不支援的推理參數。沒有啟用或部署 bot，也沒有改預設模型。

如之後選擇 Qwen，測試版已支援：

```dotenv
TRANSLATION_PROVIDER=gateway
TRANSLATION_MODEL=alibaba/qwen3.7-flash
```

沿用 `AI_GATEWAY_API_KEY`，翻譯按鈕仍需 `X_TRANSLATION_ENABLED=true` 才啟用。

單獨重跑（會產生少量 API 費用）：

```sh
TRANSLATION_EVAL_MODELS=tencent/hy-mt2-lite,alibaba/qwen3.7-flash TRANSLATION_EVAL_ENV_FILE=/path/to/local/.env npm run eval:translation
```

[Gateway 公開模型價格清單](https://ai-gateway.vercel.sh/v1/models)：Qwen 3.7 Flash（本批低於 32K token）輸入 US$0.03、輸出 US$0.13／百萬 token；HY-MT2 Lite 輸入 US$0.044、輸出 US$0.177／百萬 token。[Gateway 相容 API](https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions)。
