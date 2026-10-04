# X 貼文翻譯測試（2026-10-03）

目前測試版 `auto` 路由採額度內 GPT-6 Luna、超額 Qwen；DeepSeek離峰切換已實作但預設關閉，因真實資料補測仍有意思反轉。已加入台版人物詞表與換行處理，詳見文件末節。已於2026-10-04部署並啟用；目前每公會每天有獨立5次Luna翻譯額度，超額Qwen，不扣聊天額度。以下按時間保留測試歷史：初輪六筆合成文曾推薦DeepSeek，再推薦Luna、Qwen；真實50篇評測推翻了直接採用Qwen的結論。這不是全市場排名或大型翻譯品質認證。

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

預設 `X_TRANSLATION_ENABLED=false`。啟用後，主要為外文的 X 貼文在 bot 預覽下顯示「翻譯成繁體中文」。

**2026-10-04 起改為原地修改**（原本的 Ephemeral 私人卡片會另外多一則訊息、還重貼照片，太厚重）。按鈕直接改公開預覽本身，全頻道都看到譯文，按鈕變「查看原文」可切回：

- bot 自製卡（多圖相簿、R18 打碼卡）：第一張 embed 的內文換成譯文，footer 加「· 繁體中文翻譯」，相簿圖片與打碼附件不動。
- fixer 連結卡：unfurl 是 Discord 的，改不了；譯文以引用區塊附在連結下方（`-# 繁體中文翻譯` 標記），超過 2000 字上限時截斷並提示開原文。
- 查看原文：自製卡把內文還原成原文，連結卡把標記以下整段拿掉；都不再呼叫模型。
- 失敗時公開訊息不動，只對點擊者送私人錯誤訊息。舊的私人卡片按鈕一律回「目前無法使用」。

同一篇在同一公會只花一次額度（公會內快取），比私人卡片「每人各看一張」更省。

語言判定忽略網址、帳號及 hashtag；以日韓語言標記、假名、韓文字或外文字母比例判斷。中文與只有標籤／網址的貼文不顯示按鈕。這是啟發式，無法完全判斷純漢字日文。

驗證：`npm test` 全套通過。專用 smoke 驗證連結卡與自製卡的原地修改與切回、快取、長度截斷、失敗只私訊點擊者、token 保護與 HTTP/截斷失敗。LLM 為實際 API 呼叫；Discord 互動為模擬測試，尚未在真實 Discord 客戶端點擊驗收。未部署、未啟用正式 bot。

## 重跑

使用 Node 24，在分支工作目錄執行：

```sh
npm run test:translation
# 以下會產生少量 API 費用；只送出腳本內的合成貼文
TRANSLATION_EVAL_ENV_FILE=/path/to/local/.env npm run eval:translation
```

現行測試版啟用設定（正式環境尚未設定）：

```dotenv
X_TRANSLATION_ENABLED=true
TRANSLATION_PROVIDER=auto
TRANSLATION_MODEL=
TRANSLATION_DEEPSEEK_OFFPEAK_ENABLED=false
```

沿用provider既有API key，不使用Discord token呼叫模型。翻譯獨立於persona／聊天記憶，現行路由每公會每日獨立5次Luna翻譯配額，不扣聊天配額；使用每人五秒冷卻、全程序四個同時請求與十分鐘公會內快取，最多200筆。原文切換或快取命中不再花費模型費用；驗證失敗最多同模型重試一次，不將超額公會升回較貴模型。

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

## 2026-10-04：50 篇真實 X 貼文與翻譯按鈕篩選

**更新結論：目前配置的 Qwen 不應直接正式採用。** 六筆合成貼文曾未見重大錯誤，但這輪真實資料出現重複的未翻譯、角色錯名、憑空添加商品角色及關鍵意思遺失。不能沿用前輪「一般貼文可用」的判斷。

### 資料與方法

透過網路搜尋找到公開 X status URL，再用 bot 實際使用的 FxTwitter API 取回正文。共選 50 篇：日文 30、韓文 11、英文 5、中文 4；含蔚藍檔案、BanG Dream! 公告、玩家心得、直播請假、短句及中文借用英文術語的文章。引用的原貼文也按自己的 URL 獨立收錄。不改寫正文、不拼湊搜尋摘要，不以圖片文字或引用卡片內容代替該篇正文。部分 API canonical status ID 與搜尋連結不同，保存 API 回傳的原文 URL。排除無關新聞及含歌詞的文章。

這是針對使用情境挑選的樣本，非隨機抽樣，也不是 50 位不同作者。較長的中文控制文有 887 字元；45 篇翻譯目標的最長文為 346 字元，未涵蓋完整長文文章／執行時間上限。此批沒有自然出現的 prompt injection；前輪合成安全案例仍獨立保留。

先按「對台灣中文讀者是否有值得翻譯的外文正文」逐篇標記，再執行篩選與 API。標籤不是機器模型生成。45 篇標為需要翻譯；4 篇中文及1篇插畫角色名＋SFW illustration 標為不需要。SFW illustration 可譯，但本輪編輯判斷其按鈕資訊價值低，這是可討論的產品邊界。

對45篇目標用相同 Qwen 3.7 Flash、相同 prompt、reasoning none 實際呼叫 Gateway；即使原篩選漏判也會送出，避免只評估模型容易處理的子集。Codex 主代理逐篇對照原文與譯文記錄語意問題；不是獨立雙語人工評審，也沒有權威 reference translation 或統計品質分數。`keep=[]` 不代表數字與條件被自動驗證，這輪依逐篇 reviewFocus 和對照閱讀檢查；URL／帳號／標籤仍由程式保護。將 API 成功與翻譯品質分開報告。

### Qwen 實際結果

45 次 API 全部返回成功、沒有 token 保護失敗。10,488 input token、4,400 output token，Gateway 回報費用 US$0.00088664，平均每次 1.89 秒；同類貼文每萬次約 US$0.197。這是 response 費用而非帳單核對，也不能當作所有推文的價格。

逐篇人工式檢視標記：13 篇主體可接受、12 篇細節偏差、9 篇專名需複核、8 篇阻止直接採用的錯誤、2 篇換行格式問題、1 篇程式保護錯誤。這些類別是評審判斷，非客觀 benchmark 分數；「專名需複核」不宣稱已查證官方中文譯名。

重大例子（完整對照見 JSON）：

- [英文泳裝 Ui 招募公告](https://x.com/EN_BlueArchive/status/1755154436186628254)：Ui 被改成「結衣」；另一篇同角色英文文也如此。
- [韓文四名學生復刻公告](https://x.com/KR_BlueArchive/status/1946110595948036237)：히마리／Himari 被改成「日向」，指向不同角色。
- [競技排名詢問](https://x.com/thegamehhhkk/status/2038851040439935256)：省略「從第6名攻擊第1名」的第1名目標，改成能否攻擊人的一般問題。
- [NEDO 預告](https://x.com/nedo_info/status/2024386040031752663)：正文幾乎全部仍為日文，沒有完成翻譯。
- [要樂奈玩偶公告](https://x.com/bang_dream_info/status/1892574535670440116)：原文只有要樂奈，譯文新增「燈 & 樂奈」，改變商品資訊。
- [維護獎勵公告](https://x.com/EN_BlueArchive/status/2041416140787011865)：Pyroxene 變成「紅柱石」，遊戲貨幣處理錯誤。應提供詞表或保留原文名稱。

維護期限、是否能進入常駐招募等否定條件，多數案例保留；不能因此忽略人物或商品身份錯誤。兩篇文章輸出字面的 `\\n`，目前卡片不會自動將其轉成換行，列為格式問題而非語意正確率。

### 程式問題與五篇重測

原本保護 `[@#][Unicode字母數字]+`，會把 `@Blue_ArchiveJPをフォロー` 的「をフォロー」一起當作帳號保護，模型因此無法翻譯追蹤步驟。已將 handle 限定為 X 的 ASCII 帳號字元，hashtag 仍保留 Unicode；篩選去除帳號的規則同步修正。新增回歸檢查帳號原樣保留、後接日文能翻譯。

未更動 prompt 或模型，修正 handle 後重測5篇：追蹤／轉發步驟正確翻譯；Ui 錯名、NEDO整段日文、排名目標遺失、玩偶新增燈四個模型問題仍重現。這些結果支持目前不直接採用，而非單次生成偶發問題。沒有將原始失敗覆蓋成補測成功。

### 按鈕篩選結果與改動

| 測試 | 該顯示且顯示 | 多顯示 | 漏顯示 | 正確不顯示 |
| --- | ---: | ---: | ---: | ---: |
| 真實50篇，使用API語言標籤 | 45 | 1 | 0 | 4 |
| 同50篇，移除語言標籤 | 45 | 1 | 0 | 4 |
| 另12個合成邊界案例 | 5 | 0 | 0 | 7 |

修改前，無語言標籤時會漏掉短句「お渡しするよー！」。已讓有至少4個字母且含假名／韓文的短文先於8字母門檻判斷。另加入連續至少4個英文單字、至少20個英文字母的片段檢查，避免中文主體／zh標籤掩蓋重要英文條件，例如退款限制；AI agents、System prompt 等短借詞仍不觸發。判斷只用本機規則，不額外呼叫 LLM。

剩餘多顯示是角色名＋SFW illustration。50篇符合標籤49篇、召回45/45；負例僅5篇且有1篇多顯示，不能推論正式環境誤判率很低。沒有針對單篇寫死排除條件。4字母以下的外文、中文夾短英文限制句、只有漢字的日文且沒有ja標籤、中文正文含零星假名等仍有判斷取捨。合成12例包含純URL、標籤、emoji、中文品牌詞、中文夾外文、短日韓英句與單一名稱；**不是12篇真實推文**。

### 保存、驗證與下一步

- 真實正文、原文連結及預先標籤：`docs/translation-real-tweets-2026-10-04.json`。
- 45篇API原始譯文及usage：`docs/translation-eval-real-qwen-2026-10-04.json`。
- 每篇語意評審註記：`docs/translation-real-review-2026-10-04.json`。
- 修正handle後五篇重測：`docs/translation-eval-real-qwen-recheck-2026-10-04.json`。
- 離線篩選結果：`docs/translation-filter-eval-2026-10-04.json`；執行 `npm run eval:translation-filter` 可重跑，沒有API費用。

`npm test` 全套通過，涵蓋私密卡片隔離及新增篩選／handle回歸。沒有部署、啟用翻譯或更改預設模型。Qwen 若要繼續評估，先保留不確定專名原文、補遊戲術語詞表，再以固定真實資料重新評估未翻譯／增添內容；也應讓其他候選模型跑同一批資料，不能直接推論 Luna 或 DeepSeek 已在這批過關。

重跑45篇真實文（會產生少量API費用；新結果寫入 `data/translation-eval.json`，不覆蓋已保存報告）：

```sh
TRANSLATION_EVAL_CASES_FILE=docs/translation-real-tweets-2026-10-04.json TRANSLATION_EVAL_MODELS=alibaba/qwen3.7-flash TRANSLATION_EVAL_ENV_FILE=/path/to/local/.env npm run eval:translation
```

## 2026-10-04：同45篇真實文，GPT-6 Luna 對照

**本批 Luna 比 Qwen 好，但仍不是完整過關。** 使用完全相同45篇正文、相同翻譯 prompt 與既有詞表，GPT-6 Luna 設 reasoning none，未增加人物詞表或為 Luna 調整 prompt。Luna 使用修正後的 ASCII-handle 保護；Qwen原45篇在修正前，受到影響的追蹤步驟已有Qwen重測成功，因此不把該程式修正計為Luna模型優勢。各模型輸入字串中的隨機 token 占位符不同，恢復後帳號、URL、標籤一致。

45次API全部成功，沒有 token 保護失敗，usage中 reasoning／cached input皆為0。Luna本輪共12,323 input、4,614 output token，依[OpenAI Docs 官方標準單價](https://developers.openai.com/api/docs/models/gpt-6-luna)（輸入US$0.10、輸出US$0.50／百萬token）估算US$0.0035393，未核對帳單。平均2.30秒；同類貼文每萬次約US$0.787。Qwen前輪每萬次US$0.197，約為Luna四分之一；兩輪延遲不是同時執行，不能作嚴格速度排名。費用與平均延遲只包含各45篇首輪，不含小批重測。

### Qwen原先八個重大問題的對照

| 原文案例 | Qwen | Luna |
| --- | --- | --- |
| 泳裝Ui結束公告 | Ui變結衣 | 憂，保留截止與不可常駐招募 |
| 四名學生復刻公告 | Himari變日向 | 日鞠，四名學生與期間保留 |
| 玩家抽卡心得 | ナコトコイン變娜可露露幣；漏作品名 | 保留ナコトコイン，作品名TonoFura與保底保留 |
| 競技排名問題 | 漏掉第1名目標 | 保留第6名能否打第1名 |
| NEDO預告 | 整段仍為日文 | 完整翻譯正文與兩個主題 |
| 泳裝Ui招募預告 | Ui變結衣 | 憂，UTC招募時段保留 |
| 維護獎勵 | Pyroxene變紅柱石 | 青輝石720，信箱期限保留 |
| 要樂奈玩偶 | 新增燈 & 樂奈 | 只有要樂奈，23:00左右保留 |

Luna沒有重現這八個重大問題。此表只比較這八個案例，不表示其餘37篇都正確，也不是官方遊戲專名 benchmark。

### Luna自己的問題

逐篇對照標記：30篇主體可接受、8篇細節偏差、3篇專名需複核、2篇影響人物身份的錯譯、2篇換行格式問題。沿用首輪來源對照的主觀評審方法，非獨立人工翻譯評審或統計品質分數。即使API返回成功，也不視作翻譯通過。

- [漫畫第129話](https://x.com/Blue_ArchiveJP/status/1692385866575237209)：シズコ／Shizuko寫成「志織」（Shiori），人物名稱資訊改變。
- [漫畫第115話](https://x.com/Blue_ArchiveJP/status/1656871852705452032)：カズサ／Kazusa寫成「梓」（Azusa）；同角色韓文活動文則寫「佳澄」，沒有一致的專名策略。
- ミネ寫成「峰」、トキ寫成「托奇」等自由譯名未查證官方名稱；標為專名需複核，不能單憑中文可讀就當作準確。
- 英文玩家商店心得、Subaru直播請假文有字面的 `\n`，不是真正換行；商店文artifacts寫成「聖遺物」，仍需遊戲術語詞表。
- 「先行抽選／預購」仍有「優先」用詞；韓文好眠被寫成午睡，添加原文未指明的時段。這些另記細節偏差。

未改prompt重測上述兩篇人物文與兩篇格式文：Kazusa改成和紗、Shizuko變紫子，Mimori重測變美彌；專名生成不穩定。商店文的字面反斜線n仍出現，Subaru文則恢復正常換行。保留首輪失敗，不能用一次補測較好覆蓋它。

### 採用判斷與保存

若在兩者之間選下一個翻譯候選，本批支持優先Luna。正式採用前，應先決定人物／貨幣名稱使用可信詞表或原文保留，再驗證專名與字面換行問題。不能直接宣稱Luna所有遊戲文章過關；本次沒有更動prompt、預設模型或正式環境，也沒有部署。翻譯按鈕的篩選為本機規則，不依賴Luna，既有50篇分類結果不受這次模型測試影響。

保存檔案：

- 45篇首輪原始譯文及usage：`docs/translation-eval-real-luna-2026-10-04.json`。
- 每篇註記與四篇重測解讀：`docs/translation-real-review-luna-2026-10-04.json`。
- 四篇重測API結果：`docs/translation-eval-real-luna-recheck-2026-10-04.json`。
- 同資料成本與原Qwen重大案例對照：`docs/translation-real-model-comparison-2026-10-04.json`。

本輪僅新增評測結果與文件，未改執行程式；核對兩輪45篇來源ID／URL一致，Luna保存原文快照與未修改的語料一致、45筆API均成功、各保存JSON可讀取。`text`欄位是譯文，Luna另存`originalText`與語料SHA-256，避免把譯文誤認成原文。上一輪已通過全套`npm test`，此輪未重複跑與文件無關的回歸套件。

重跑同一批（會產生少量API費用）：

```sh
TRANSLATION_EVAL_CASES_FILE=docs/translation-real-tweets-2026-10-04.json TRANSLATION_EVAL_MODELS=gpt-6-luna TRANSLATION_EVAL_ENV_FILE=/path/to/local/.env npm run eval:translation
```

## 2026-10-04：專名策略、DeepSeek補測與公會配額路由（初版歷史，額度已由末節更新）

### Kazusa名稱更正

前文與先前對話的「Kazusa＝和紗」混用了不同地區用名。此應用採台版：**カズサ／Kazusa／카즈사＝千紗**；**アズサ／Azusa＝梓**，兩人不可混用。陽葵／日鞠、季／時、英美／愛咪、日步美／日富美等也有地區譯名差异，不能只按模型常見譯法宣稱台版準確。

本輪從[SchaleDB遊戲資料](https://github.com/SchaleDB/SchaleDB)按student ID對齐日文、英文、韓文、台版資料。20個已核對學生名字與青輝石列入`src/ai/translation-glossary.json`，包含千紗、憂、陽葵、美禰、靜子、三森、愛麗絲、月夜、野乃美等。此repo在2025年封存，**不是官方即時更新接口**；新角色不能憑舊資料猜名字。台版公告中的千紗也見[2026/7/21更新日誌](https://forum.nexon.com/bluearchivetw/board_view?allBoard=1&board=3352&thread=3502589)。

已核對名字先以占位符保護，模型輸出後由程式還原台版名字，效果是程式輔助，不宣稱模型自行學會了名稱。只有辨識到蔚藍檔案語境才套遊戲詞表，避免普通英文Mine等誤換成角色名；英文別名大小寫敏感且需完整詞，不匹配Unique／Buildings等單字内部。URL／帳號／hashtag保護優先，詞表不改寫它們。

Kei／Hikari無法從該快照核對，列為原名保留；ナコトコイン、ミルヴァ、MyGO的要 楽奈也保留原文，不由模型添加譯名或第二個角色。其他未知專名由prompt要求保留原文，**目前沒有一般化、必定正確的所有專名偵測器**，仍可能有猜名、品牌變字或翻譯偏差。

### 換行與驗證

有真正換行的來源，模型若輸出字面反斜線n，會在token還原前轉為真正換行，保護中的URL等不受影響；來源本來含程式碼字面`\n`時保留。驗證每個保護標記均完整回傳一次；長日韓文若整段照抄原始或被遮罩的輸入，拒絕當成成功翻譯。這只能抓整段原樣照抄，不能保證抓到所有部分漏翻、新增內容或語意反轉。

驗證失敗最多用同模型再試一次；不重試HTTP429等流量限制，也不將超額公會從Qwen升回Luna。重試後仍失敗，就回報暫時無法翻譯並刪除失敗快取，避免展示未翻全文或損壞標記。

### 同45篇DeepSeek原策略與三模型新策略

先讓DeepSeek Flash使用與前輪Luna相同45篇、相同舊prompt，完成45次實際API呼叫。平均0.90秒，依當天離峰價及usage估算US$0.004023534；同類貼文每萬次約US$0.894。原Luna同批US$0.787。這輪有四筆明顯問題：Ui被改優香、Kazusa被改佳世子且來電方向變動、Alice被改亞瑠，以及「晚上較早開始」被翻「晚一點開始」。**速度較快不表示品質較好，這批不能支持DeepSeek優於Luna。**

加入人物保護／prompt／換行策略後，三個模型各重跑全部45篇，共135次；最後再以新增要樂奈與未知Kei／Hikari保護，重跑9個受影響或問題案例，共27次。全批結果與最後小批結果分開保存，不能把最後9篇說成再次完整測45篇。

| 新策略完整45篇 | 通過API與輸出驗證 | 被拒絕 |
| --- | ---: | --- |
| DeepSeek Flash | 45 | 0；但仍把較早直播翻成較晚，最後小批也再次出錯 |
| GPT-6 Luna | 44 | 1篇Kei漫畫保護標記遺失；最後小批該篇正常回傳 |
| Qwen 3.7 Flash | 43 | 1篇漫畫標記遺失、NEDO整段原文未翻 |

數字是驗證通過次數，**不是語意正確率**。程序保護大幅减少學生錯名，所有成功且保護標記完整的已知角色都還原到詞表。Luna仍有日文敬稱／英語衣裝詞殘留、對午睡的額外推論；Qwen仍有未翻正文、名稱／品牌變字、內容省略，且曾把要樂奈分成兩個名字，促使最後加整個原名保護。DeepSeek／Qwen的Kei衣裝漫畫語序也不清楚。不能宣稱任何模型已在全文章類型無誤。

另以最終runtime重試實測Qwen三個問題案例：漫畫第45話兩次都遺失標記，NEDO兩次都未翻，均拒絕展示；模型化商品公告這次第一筆成功翻譯。所有嘗試仍只用Qwen；在更強的「與遮罩輸入比較」檢查下，不會因角色名被程式還原中文而把其他全文照抄放行。

新策略全批已記錄成功呼叫的費用合計：DeepSeek US$0.004124106、Luna US$0.0040258、Qwen US$0.00099899。Luna／Qwen驗證失败後沒有保存usage，失敗API也可能計費，因此後兩值是**可記錄費用的下限**，不能拿它當完整帳單或精確每萬次比較。補測與runtime重試另外有費用。觀測延遲受API負載影響，非嚴格速度排名。

### 現行路由與配額

`src/ai/translation-policy.js`已接入按鈕處理；`TRANSLATION_PROVIDER=auto`時：

- 一般公會額度內用GPT-6 Luna；`TRANSLATION_DEEPSEEK_OFFPEAK_ENABLED=false`，因補測不支持DeepSeek更好。
- 一般公會超額的新翻譯用Gateway的Qwen 3.7 Flash，不因時段或手動provider設定升回高階模型。
- 沿用既有聊天配額`AI_FREE_DAILY_LIMIT`（預設每天20次）及台北午夜重置；**聊天與翻譯共用同一公會計數，不是另加每月1000次**。額度已滿則翻譯改走Qwen，聊天原有限制行為不變。
- `DEEPSEEK_PREMIUM_GUILD_IDS`既有白名單不受公會20次限制；所有owner付費的新翻譯仍受既有`AI_OWNER_DAILY_LIMIT`（預設1500次）總量限制，包括Qwen。
- 只在快取未命中且即將發出API時同步預留一次配額，失敗不退額度，最多一次驗證重試包含在這個邏輯請求中；每人冷卻與同時請求上限檢查先於計數。聊天和翻譯的計數保存在既有`data/ai-daily-usage.json`，沿用原本跨重啟持久化機制。
- 公會內相同文章／策略的快取與原文切換不計次；同公會已快取的Luna譯文，即使後來用滿額度仍可免費重看。不同公會不共用這個快取，以免超額公會借到其他公會的高階生成。
- 手動provider可指定額度內模型，但超額仍Qwen。翻譯使用owner既有金鑰，不擅自取得或轉用公會聊天BYOK金鑰。

離峰分流功能已提供開關，預設不啟用；若之後接受DeepSeek品質，再設`TRANSLATION_DEEPSEEK_OFFPEAK_ENABLED=true`。採[DeepSeek官方UTC時段](https://api-docs.deepseek.com/quick_start/pricing/)：週一至五01:00–04:00、06:00–10:00是尖峰，週末離峰。中國公眾假日全天離峰，可在`TRANSLATION_DEEPSEEK_OFFPEAK_DATES`填日期；範例包含當前2026年10/1–7，日期依[國務院2026放假通知](https://big5.www.gov.cn/gate/big5/www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm)。這份日期清單需維護，不會自動下載未來年份假日；未列出的假日按平日尖峰規則選Luna，保守避免誤用DeepSeek。翻譯分流不更改既有聊天的時段程式。

`auto`額度內需`OPENAI_API_KEY`，超額需`AI_GATEWAY_API_KEY`；選擇離峰DeepSeek另需`DEEPSEEK_API_KEY`。`X_TRANSLATION_ENABLED`仍預設false。沒有部署、修改正式.env或啟用正式bot。

### 驗證與檔案

全套`npm test`通過，新增檢查詞表語境與字詞邊界、千紗與梓分離、未知名保留、字面換行／程式碼保留、來源照抄拒絕、同模型最多兩次嘗試、尖峰起迄、週末／假日、公會最後額度、不同公會、台北午夜、白名單、owner總量、快取不計次与公會隔離。既有兩人私密回覆、不修改公開訊息驗證仍通過。50篇真實文篩選結果維持45篇應顯示全顯示、1篇多顯示；另外12個合成篩選案例均符合預期。

評測來源相同，新增報告保留`originalText`與語料SHA-256，對照用`text`為譯文；評審仍由Codex主代理對照原文，不是獨立雙語人工認證。

- 舊策略DeepSeek45篇：`docs/translation-eval-real-deepseek-2026-10-04.json`與`docs/translation-real-review-deepseek-2026-10-04.json`。
- 新策略三模型各45篇：`docs/translation-eval-strategy-v2-2026-10-04.json`。
- 最後新增專名保護後，各9篇：`docs/translation-eval-strategy-v3-targeted-2026-10-04.json`。
- 最終Qwen實際重試：`docs/translation-eval-qwen-runtime-retry-2026-10-04.json`。
- 名稱資料：`src/ai/translation-glossary.json`；路由：`src/ai/translation-policy.js`；啟用範例：`.env.example`。


## 2026-10-04：翻譯獨立每日五次 Luna 額度

每個公會每天前5次未命中快取的新翻譯使用Luna，第6次起使用Qwen；依台北午夜重置。翻譯與聊天額度分開，不受聊天額度是否用完影響，也不消耗聊天額度。聊天付費／白名單公會同樣適用5次翻譯限制。

翻譯計數使用既有持久化檔案 `data/ai-daily-usage.json` 的 `__translation__:<guildId>` 獨立列，重啟不重置；舊聊天列不遷移到新翻譯額度。所有新翻譯（含Qwen）仍受既有owner每日總量上限限制。失敗的API嘗試仍計次，同模型驗證重試最多一次並包含在同一次計數中。公會內10分鐘快取、切回原文不計次；翻譯仍僅點擊者可見，不覆蓋公開訊息。

驗證涵蓋五次Luna／第六次Qwen、聊天耗盡仍有翻譯額度、翻譯不更改聊天列、白名單不能繞過、不同公會與台北午夜重置；既有快取與私人回覆測試保留。
