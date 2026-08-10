# 西寶聲線 Pilotfish 交接文件

日期：2026-08-10  
分支：`feat/xibao-voice-pipeline`  
目標角色：西奈津美

## 交接結論

目前**不可開始訓練**。最近建立的第二季第 17 話候選批次裁切過長、對話輪界線不可靠，使用者已指出其中出現聲線判斷幻覺與裁切不佳。該批次只能保留作為失敗案例，**不得進入正例銀行、逐字稿、訓練 manifest 或 speaker calibration**。

後續工作應先重做短句與說話輪切分，再產生一批新的人工測評題。不要沿用目前 EP17 批次的 `selection_evidence` 作為事實。

## 使用者驗收要求

- 只保留西的聲音；高亢、快速、音色明顯不同或其他角色一律先排除。
- 對話要切成單一說話輪，通常 2–4 秒；不能把兩個人的來回、旁白或下一句一起包進去。
- 切邊要避開換鏡、插話、笑聲、群體反應與下一位說話者。
- 畫面看到角色不等於她正在說話；必須有口型、聲音與時間邊界三者一致。
- 字幕只能輔助定位；`transcript_ja_verified` 必須由日文 ASR 草稿再人工校正，不能把中文字幕當日文稿。
- 使用者希望一次收到一批可測評片段，但品質優先於數量。

## 目前訓練 readiness

檔案：`data/voice/xibao/reports/training-readiness.json`

- `ready_for_training: false`
- reviewed positive：22
- QC 後有效 unique：20
- 來源集數：5
- 尚未建立 holdout；EP5 的 8 段不能同時當 train 與 holdout
- train 秒數目前 59.479（尚未扣除 episode-disjoint holdout）
- 日文 verified transcript：12 / 20
- 失敗 gates：`artifact_integrity`、`episode_disjoint_holdout`、`training_duration`、`verified_japanese_transcripts`
- 另有兩段低於 2 秒：EP7 `918.804–920.650`、EP12 `711.915–713.651`，不得進正式訓練

保守目標：EP5 保留至少 8 段 holdout；另外至少 20 段、60 秒以上、跨至少 2 集作 train，並補齊 20 段日文人工校正版。

## EP17 本機素材

來源資料夾：

`data/voice/xibao/_tmp/local-s2-ep17/`

已去重的兩個檔案：

- `part-a.webm`：容器約 146.478 秒；影像約 146 秒，音訊約 127 秒
- `part-b.webm`：容器約 720.124 秒；**影像只有約 294.286 秒，音訊約 720 秒**

`part-b` 後半段是 audio-only，沒有畫面口型證據；在取得完整畫面前，294.286 秒之後全部隔離，不得送人工身份測評或訓練。

本機 WAV 已轉為 16 kHz mono，inventory 位於：

`data/voice/xibao/_tmp/local-s2-ep17/inventory.json`

該 inventory 只描述使用者上傳的本機檔案，不能被解讀成 AniGamer 下載許可或串流擷取許可。

## 必須作廢的最近批次

資料夾：

`data/voice/xibao/candidates/s2-ep17-local-b/`

批次：`2`，來源：EP17 `part-b`，共 6 段。

使用者已驗收指出：

- 對話長度太長，沒有乾淨切成單輪
- 片段邊界不佳，已開始出現聲線／說話者幻覺
- 不能把這些 sidecar 的 `selection_evidence` 當成真值

因此接手者應將這 6 段標記為 rejected/quarantine，或至少在任何 downstream loader 中排除。不要把它們拷貝到 `calibration/review-bank`，不要跑 transcript promote、RoFormer promote 或 training manifest。

這批 sidecar 內的 `[manual visual span; transcript pending]` 只是定位佔位文字，**不是逐字稿**。

## 目前測評台

遠端伺服器：`127.0.0.1:8765`  
使用者 Mac SSH tunnel：

```bash
ssh -N -L 18765:127.0.0.1:8765 kojiek@140.122.184.29
```

本機 Chrome：<http://localhost:18765/>

目前 review server 可繼續用來查看既有紀錄，但不要把作廢的 EP17 批次當成新一輪驗收結果。若要重建佇列，應使用新的 `review_batch`，並先清楚排除批次 2。

## 既有程式與限制

- `tools/voice/build_review_candidates.py` 的 ECAPA 分數目前只作 rank/retrieval evidence，不是 speaker prediction。
- `tools/voice/prepare_retrieval_review.py` 只應接受已完成連續畫面檢查的明確清單；不要用它替粗糙的固定窗口背書。
- `tools/voice/review_server.py` 的身份、逐字稿、RoFormer 與生成品質是不同 queue；身份通過不等於可訓練。
- 正式訓練 gate 仍 fail closed；不要手動改 readiness JSON 來放行。
- 程式碼變更與測試歷史：102 個 voice tests 曾全數通過；最近新增的 EP17 媒體與候選都在被 Git 忽略的 `data/`，沒有應提交的音檔或影片。

## 接手後第一輪工作

1. 將 `s2-ep17-local-b` 批次 2 quarantine，並在新 ledger 留下「裁切過長／說話輪混入」原因。
2. 只使用 `part-b` 有畫面的前 294.286 秒；audio-only 尾段暫停。
3. 以鏡頭邊界、嘴部活動與字幕事件重做短句切分；單段預設 2–4 秒，必要時在句中停頓處硬切。
4. 對雙人畫面新增明確的 turn evidence；若不能證明西正在說話，就標 `uncertain`，不要假設奇偶輪或固定窗口屬於西。
5. 一次產生約 8–12 個新候選，先做連續畫面與音訊人工預審，再放入 review server。
6. 使用者身份測評完成後，才跑每段 RoFormer A/B；背景殘留、金屬音、斷字、爆音或音文不一致都退回。
7. readiness 全綠前不要開始任何 TTS/speaker inversion 訓練。

## Git 狀態

最近相關 commit：

- `ed0c615 feat: add auditable retrieval review batches`
- `1415c2a feat: allow audited retrieval review queue`
- `0d4cee6 policy: record user training authorization`

目前沒有需要為這次失敗候選建立的新 code commit；交接重點是資料隔離與重新切分，不是繼續擴大候選數量。
