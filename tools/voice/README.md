# 西寶 Voice Segment Manifest

版本庫只追蹤 metadata、manifest 與本機切段工具；不追蹤影片／音檔，也不提供下載器、OCR、voice embedding 或任何付費／會員限制繞過。

另外提供本機媒體的 anchor cutter。它只負責可追溯切檔，永遠不自行批准訓練；每份 sidecar 都會標示 `training_gate_required=true`。

建立本機工具環境：

```bash
python3 -m venv data/voice/.venv
data/voice/.venv/bin/pip install -r tools/voice/requirements.txt
```

## 使用方式

```bash
python3 tools/voice/build_segment_manifest.py \
  --inventory configs/voice/xibao.sources.json \
  --anchors configs/voice/xibao.anchors.json \
  --candidates-out /tmp/xibao.candidates.json \
  --manifest-out /tmp/xibao.train.manifest.json \
  --dry-run
```

輸入 inventory 可以是陣列，也可以是 `{ "sources": [...] }`；anchors 使用 `{ "anchors": [...] }`。輸出會保留輸入檔案 SHA-256、source URL／media path、source index、anchor id 與 rights snapshot。兩份輸出共享由 inventory hash、anchors hash 與 policy 決定的 `generation_id`，可用來確認它們是同一輪產物。

`training manifest` 只接受同時滿足以下條件的片段：

- 人工 `verdict` 是 `accept`
- `confidence >= --min-confidence`（預設 `0.85`）
- speaker 與 target 相同
- `uncertain` 與 `seed_only` 都是 `false`
- 至少兩位不同人工審核者確認是 target，且都確認沒有其他角色串音
- inventory source 的 `rights.training` 是 `allow`
- source 有非空 `media_path`
- source 有格式正確的 `source_sha256`（64 位 hex）
- anchor 有非空 `reviewer` 與 `reviewed_at`
- anchor 有非空 canonical `transcript_ja_verified`
- anchor 有明確 emotion，且不是 `unknown`

機器 voice score、OCR 或 LLM 結果只能留在 `evidence`，不會自動變成人工 verdict。`text` 只供展示，不能代替 `transcript_ja_verified`。Candidates 會保留所有缺漏／排除原因；正式 training manifest 只輸出完整且不含 `null` 的片段。`dry-run` 不建立輸出目錄或檔案。

兩份正式輸出會先各自寫入暫存檔，兩份 staging 都成功後才 replace final；第二份 staging 失敗時不會更新任何既有 final（replace 階段仍可能有極小非交易窗口）。

## 本機金標切段

先建立不進 Git 的 local overlay，只放本機媒體路徑與實際 SHA-256：

```json
{"sources":[{"source_id":"s1-ep05","media_path":"raw/s1-ep05.wav","source_sha256":"<64-hex>"}]}
```

正式 inventory 必須對該來源明確設定 `rights.research_extraction=allow`。預設只列計畫；加 `--execute` 才會寫 16 kHz mono PCM WAV 與 JSON sidecar：

```bash
python3 tools/voice/cut_anchors.py \
  --inventory configs/voice/xibao.sources.json \
  --local-overlay data/voice/xibao/local-seed.inventory.json \
  --anchors configs/voice/xibao.anchors.json \
  --out-dir data/voice/xibao/reference

# 人工確認計畫後再執行
python3 tools/voice/cut_anchors.py \
  --inventory configs/voice/xibao.sources.json \
  --local-overlay data/voice/xibao/local-seed.inventory.json \
  --anchors configs/voice/xibao.anchors.json \
  --out-dir data/voice/xibao/reference --execute
```

Overlay 只能補 `media_path` 與 `source_sha256`，不能放寬 rights。輸入 hash 不符、anchor 不確定、speaker 衝突或未明確允許 research extraction 都會 fail closed。

連續畫面勘查的 metadata 保存在 `configs/voice/xibao.visual-candidate-ledger.json`。它只記錄時間、畫面／聲學狀態與缺漏原因；每筆固定 `training_eligible=false`，不能代替本機媒體、speaker review、逐字稿或 rights gate。重建候選池時應先讀 ledger 的 rejection 與 pending spans，避免重複送出已知錯角。

目前 [xibao.anchors.json](../../configs/voice/xibao.anchors.json) 只有第一季第 5 話 `3.000..5.829` 的人工 seed，標為 `seed_only=true`，所以即使 verdict 是 accept 也不會進 training manifest。使用者已明確授權 S1 YouTube 條目下載、研究擷取與本機訓練；S1 仍禁止再散布，S2 AniGamer 受保護串流仍禁止下載，新來源維持 default-deny。授權紀錄在 inventory 的 `policy.download_authorization`。

## 下一階段校準條件

1. 先由人工確認來源的觀看／下載／訓練權利；沒有明確允許前維持 deny。即使訓練已獲明確允許，也不等於可以擷取受保護串流或再散布音檔。
2. 取得合法的本地媒體與 checksum，補入 inventory 的 `media_path`、`duration_s`、`source_sha256`。
3. 補齊人工 anchor：speaker、時間範圍、verdict、reviewer、`reviewed_at`、confidence、canonical `transcript_ja_verified`、`uncertain` 與明確情緒標籤。
4. 用 seed 建立 voice reference 後，對第二季各集做 voice score；機器分數只作 evidence，仍需人工覆核。
5. 以 held-out 的人工正／負樣本校準 threshold，確認 false-positive、短片段與串音風險，再將特定 source 的 `rights.training` 明確改成 allow。

本工具不負責媒體擷取、字幕 OCR、聲音分離或訓練執行。

## 合成音發布 QC

訓練完成不代表輸出可以使用。每個合成候選都必須先由外部評測器產生 JSON report，再交給 `validate_generation.py`。它會同時檢查：

- 聲紋模型已用 episode-disjoint 正／負例校準，AUC >= 0.85、FPR <= 5%，且候選分數達校準 threshold
- peak <= -1 dBFS、clip fraction <= 0.001、RMS 在 -35..-12 dBFS、silence ratio <= 0.35
- DNSMOS OVRL >= 2.5、SIG >= 3.0、BAK >= 3.0
- 至少兩位不同人工審核者都確認像西、自然、無爆音／金屬音／斷字等 artifact

任一數值缺漏、非 finite、評測未校準、審核衝突或音檔 hash 不符都會 fail closed。通過結果只代表本地 QC 合格，不會自動賦予發布或冒充真人的權利。

```bash
python3 tools/voice/validate_generation.py \
  --report data/voice/xibao/evaluations/sample.json \
  --decision-out data/voice/xibao/evaluations/sample.decision.json
```

## 人工測評台

候選素材放在 `data/voice/xibao/candidates/`，生成結果放在 `data/voice/xibao/generations/`。啟動本機介面：

```bash
python3 tools/voice/review_server.py --reviewer <固定審核者名稱> --open
```

伺服器只允許綁定 localhost，預設網址為 `http://127.0.0.1:8765`。身份與生成品質分開審核；結果會原子 upsert 至被 Git 忽略的 `data/voice/xibao/review/reviews.json`。第二位審核者應使用不同的 `--reviewer` 名稱，以符合雙人獨立確認門檻。

透過 SSH 使用時，先在遠端啟動測評台，再於自己的電腦另開終端建立 tunnel：

```bash
# 遠端 SSH shell
python3 tools/voice/review_server.py --reviewer <固定審核者名稱>

# 自己的電腦（不要在遠端執行）
ssh -N -L 8765:127.0.0.1:8765 <user>@<remote-host>
```

本機瀏覽器開啟 `http://127.0.0.1:8765`。不建議將 `--host` 改為 `0.0.0.0`；工具也會拒絕非 localhost 綁定。

候選不是手工固定切幾段。對合法取得的本機整集音訊，可用官方字幕單句時間軸加 ECAPA 金標相似度建立人工佇列：

```bash
data/voice/.venv/bin/python tools/voice/build_review_candidates.py \
  --inventory configs/voice/xibao.sources.json --source-id s1-ep05 \
  --audio data/voice/xibao/_tmp/s1-ep05/source.wav \
  --subtitles data/voice/xibao/_tmp/s1-ep05/source.zh-Hant.json3 \
  --reference data/voice/xibao/reference/s1-ep05__s1-ep05-seed-001.wav \
  --positive-dir data/voice/xibao/calibration/review-bank/positive \
  --negative-dir data/voice/xibao/calibration/review-bank/negative \
  --reviewed-dir data/voice/xibao/calibration/review-bank/reviewed \
  --out-dir data/voice/xibao/candidates/s1-ep05 --top-k 8 \
  --min-probability 0.70
```

工具會排除雙行字幕、過短／過長事件、金標本身及所有已人工審核的片段。ECAPA embedding 會由正例 bank 與同作品 hard-negative bank 訓練標準化 Logistic Regression；機率門檻預設為 `P(target) >= 0.70`，且正例相似度必須至少比 hard-negative 高 `0.03`。正例 bank 未涵蓋至少三集或跨集校準未達 AUC/FPR 門檻時，候選只能寫成 `uncalibrated_retrieval` 排序題；它必須另附連續口型證據才會進測評台，且不提供 `speaker_probability`，不得當成西的預測。

後端不單獨信任 `review_ready` 布林值。校準題還必須附有達標的 episode-disjoint 驗證報告，或同時具備連續口型預審 provenance 與目前人工正負例銀行產生的 `acoustic_precheck`。未校準排序題使用 `retrieval_human_review`，只保存 `rank_score`/批次順位，不保存聲學身份機率；連續畫面必須確認西的嘴部有變化、單一可見說話者、無切鏡且至少 8 fps。單張畫面看到角色、明顯負例、缺少或過期的聲學預審都會直接隔離，也不能代替 speaker verdict、串音檢查或訓練 rights gate。

若跨集校準失敗，先把候選輸出放在 ignored 的暫存目錄，再以人工建立的視覺證據清單逐段晉升到測評台：

```bash
python3 tools/voice/prepare_retrieval_review.py \
  --source-root data/voice/xibao/_tmp/retrieval-ranked \
  --output-root data/voice/xibao/candidates \
  --evidence configs/voice/xibao.retrieval-review.batch1.json \
  --bank-manifest data/voice/xibao/calibration/review-bank/manifest.json \
  --batch-id s1-retrieval-20260810-01 \
  --checked-at 2026-08-10T08:00:00Z
```

`prepare_retrieval_review.py` 只接受清單中明確列出的時間段，檢查候選的 source/span/hash，並以 `retrieval_human_review` 及 rank-only acoustic provenance 寫入新批次；它拒絕覆寫既有人工紀錄，也不會寫入 speaker prediction 或 training eligibility。

畫面預審候選可用整數 `review_batch` 固定小批次順序。測評台先依 batch、再依 speaker probability 排序，避免後續新候選插入目前正在審核的十段 canary。

## 訓練 readiness 與 Irodori manifest

正式訓練採 fail-closed readiness：至少 20 段、跨兩集且 60 秒的訓練資料，另留整集至少 8 段作 episode-disjoint holdout；每段必須有人工確認、唯一且 hash 相符的 2–7 秒音檔與人工校正日文逐字稿，所有訓練來源也必須明確允許 research extraction 與 training。

```bash
python3 tools/voice/training_readiness.py \
  --bank-dir data/voice/xibao/calibration/review-bank \
  --inventory configs/voice/xibao.sources.json \
  --report-out data/voice/xibao/reports/training-readiness.json
```

只有報告 `ready_for_training=true` 時才能輸出 Irodori-TTS 500M v3 Speaker Inversion 的 preprocessing manifest；否則指令以 exit code 2 拒絕，且不建立輸出資料集。

```bash
python3 tools/voice/build_irodori_manifests.py \
  --bank-dir data/voice/xibao/calibration/review-bank \
  --inventory configs/voice/xibao.sources.json \
  --out-dir data/voice/xibao/dataset/irodori-si
```

每次資料內容對應一個 content-addressed generation 子目錄；三份 manifest 全部 staging 成功後才原子發布，`current.json` 指向目前 generation，重跑相同資料不會覆寫或產生半套 artifacts。

固定生成測試句收在 `configs/voice/xibao.eval.json`，涵蓋短／中／長句與 calm、shy、tender、surprised、excited，供 checkpoint 使用同一批輸入做相似度、自然度、爆音與人工盲測。

Irodori runtime、base checkpoint 與 DACVAE codec 的固定 revision/SHA 收在 `configs/voice/xibao.irodori.json`。在資料集尚未 ready 前，只能執行 zero-shot runtime preflight；工具會驗證三者完整性並檢查輸出取樣率、聲道、peak、RMS、clip 與近靜音比例，但報告固定標記 `identity_verified=false`、`naturalness_verified=false`，不得當成訓練或最終品質通過：

```bash
python3 tools/voice/irodori_preflight.py \
  --irodori-repo /path/to/Irodori-TTS \
  --python /path/to/Irodori-TTS/.venv/bin/python \
  --checkpoint /path/to/model.safetensors \
  --codec-weights /path/to/weights.pth \
  --reference data/voice/xibao/reference/s1-ep05__s1-ep05-seed-001.wav \
  --text 'うん、今日はゆっくり話せそう。' \
  --output-wav data/voice/xibao/_tmp/irodori-preflight/zero-shot.wav \
  --report-out data/voice/xibao/reports/irodori-preflight.json \
  --execute
```

將既有人工標註建成 bank：

```bash
data/voice/.venv/bin/python tools/voice/build_review_bank.py \
  --reviews data/voice/xibao/review/reviews.json \
  --out-dir data/voice/xibao/calibration/review-bank \
  --search-root data/voice/xibao/_tmp
```

只有信心 >= 3、無串音的 `target` 會成為 positive；信心 >= 3、無串音的 `other` 會成為 hard negative。不確定、低信心與串音不參與訓練，但仍寫入 reviewed-span ledger，確保不會再次出題。所有新候選仍是 `pending_human_review`、`training_eligible=false`。

測評台採十段小批 canary。每批完成且品質正常才解鎖下一批；若同批出現三段高信心 `other`，後端立即設定 `quality_hold`，介面停止前進，必須先重建 speaker gate。候選目錄為空時不會用金標假裝成待評片段。

`data/voice/xibao/transcripts/asr/*.json` 的日文 ASR 只能作草稿。測評台的「日文逐字稿」分頁只載入位於資料根目錄內且音檔 SHA 相符的草稿；人工可直接修正文句，再選擇採用或退回。只有 `accept` 且非空的 `transcript_ja_verified` 會連同 reviewer、時間與原始草稿 provenance 合併回 positive bank，並被 training readiness 計數。

ASR runtime 固定在 `configs/voice/xibao.asr.json`，包含 faster-whisper/CTranslate2 版本、模型 revision、權重 SHA 與 decoding 參數。工具先驗 positive bank 與模型完整性；所有草稿在 staging 完成後才整批發布：

```bash
data/voice/.venv/bin/python tools/voice/transcribe_positive_bank.py \
  --model-path /path/to/faster-whisper-large-v3-snapshot \
  --bank-dir data/voice/xibao/calibration/review-bank \
  --out-dir data/voice/xibao/transcripts/asr --dry-run

# dry-run 完整通過後移除 --dry-run 產生草稿
```
