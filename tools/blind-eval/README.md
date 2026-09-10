# 喜寶雙供應商盲測（Slice A）

這個目錄實作第一階段、完全離線的 fixture 驅動盲測工具。它目前量測：

- persona 聲線與限制的貼合度；
- 單一、獨立問題的理解程度；
- fixture 所呈現的延遲、token 用量與依固定價目公式計算的成本。

它**不**量測多輪對話、Discord guild 上下文或實際供應商端行為。供應商資料保留狀況未知；本工具的 purge 只會刪除本機產物，不能清除供應商端資料。

## Slice A 安全邊界

目前沒有網路 transport 或金鑰讀取程式碼。`runner.js` 只接受明確的 `mode: 'fixture'` 與測試注入的 `invokeFixture`；不得拿它進行真實 extraction 或 API 呼叫。未來若要加入來源目錄，只能使用明確的 `--source-dir`，且需另行核准。

`extractCases()` 只會選取呼叫者提供的**完全相符 guild ID**、`role=user`、最新且去重的實質問題，最多 20 題。清理器移除 Discord snowflake、mention、時間戳、display name、電子郵件、電話、網址、邀請與常見秘密；空白、命令、網址主導、超過 1000 字、敏感或仍有識別碼的項目會拒絕。原始內容不會寫入檔案，private mapping 只包含 salted source hash。

供應商 request builder 固定為：

- OpenAI：`POST https://api.openai.com/v1/responses`、`gpt-5.6-luna`、`store:false`、reasoning effort `low`、無 tools、`max_output_tokens:500`、redirect `error`。
- DeepSeek：`POST https://api.deepseek.com/chat/completions`、`deepseek-v4-pro`、temperature `0.9`、top_p `0.95`、`max_tokens:2548`、無 tools、redirect `error`。

persona 與 question 在兩邊需為位元組完全相同。alias、redirect、fallback、retry 一律拒絕。每次 attempt 記錄 config ID、persona/question SHA-256、status、延遲、uncached/cached/cache-write/output/reasoning token 用量與成本。

Runner 硬上限為 20 cases、40 attempts、每一 attempt 估算輸入不超過 6000 tokens、整次預算 USD 0.25。它會在呼叫前保守預留最大輸出與 reasoning 成本，超限即停止；遇到非 200、redirect、transport、30 秒 timeout、invalid JSON、缺 answer 或 malformed usage 時中止所有剩餘工作。已完成 attempt 的成本保留，但 UI 品質聚合只納入完整 pair。case 順序以 AB/BA 交替。

價目放在 `pricing.js`，版本為 `xibe-pricing-2026-08-13-v1`，以每百萬 token 的 uncached input、cached input、cache write、output、reasoning 五項可重現公式計價。進入真實執行階段前，必須人工重新核對並核准固定價目，不能自動更新。

## 產物與盲化

預設設計將產物放在本目錄的 `data/evals/<run>/`；該路徑已由本目錄 `.gitignore` 忽略。run/public/private 目錄權限皆為 `0700`，檔案為 `0600`。公開 `cases.json` 與 `answers.json` 和 private mapping/config/usage 分開。`hashFiles()` 與 `assertHashesUnchanged()` 用於執行前後驗證 production files 未變。保留期限不得超過七天；`purgeExpired()` 或 `purgeRun()` 只刪本機。

`server.js` 只 bind `127.0.0.1`，以隨機 256-bit、HttpOnly、SameSite session cookie 驗證投票，所有 POST 都檢查完全相符的 Origin。投票前 HTML、JavaScript 與 case payload 不含 mapping、config、cost、token 用量、latency 或模型識別；投票鎖定後才回傳 mapping。前端只用 `textContent` 建立動態文字，不用 `innerHTML` 或遠端資產。

UI 提供進度、問題、A/B 回答、A/B/平手偏好、1–5 分錨定評分（聲線、一致性、自然繁中、直接度、情緒契合、硬限制、獨立理解）、歸因、捏造、揭曉、聚合與匯出，並明示外部保留未知。Persona 權重依序是 30/20/20/15/10/5；persona ≥4、理解 ≥4 且無 hard violation 才算通過。

## 離線測試

在 repository root 執行：

```sh
node --test tools/blind-eval/test/*.test.js
```

測試不使用網路、secret 或真實 `data/`，所有訊息與 provider 回應都是程式內 fixture。

## Slice C live CLI（不得在未核准時執行）

CLI 固定從 production `src/config.js` 載入 `DEFAULT_AI_PERSONA`，從 mode `0600` 的 production `.env` 逐行只解析 `DEEPSEEK_API_KEY`，並從 `/run/user/1005/xibao-openai-key` 讀取 owner UID 1005、mode `0600` 的 ephemeral OpenAI key。OpenAI key 在任何成功、preflight 或錯誤結束時都會 unlink；DeepSeek `.env` 不會被改寫。兩種模式都會消耗並刪除 OpenAI ephemeral key。

零呼叫 preflight：

```sh
node tools/blind-eval/cli.js --preflight --run <safe-run-id>
```

Live mode 除非另行核准不得執行；它需要全部三個明確 gate：

```sh
node tools/blind-eval/cli.js --execute --run <safe-run-id> --ack-provider-retention-unknown
```

Transport 使用 Node `fetch`、`redirect:error`、30 秒 `AbortController`、序列 AB/BA 呼叫，沒有 retry 或 fallback。A/B mapping 每題獨立使用密碼學安全隨機位元決定，不依呼叫順序。stdout 只包含計數、估計/實際成本與完成狀態，不包含 key、persona、問題、回答、request body 或 header。
