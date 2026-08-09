# 西寶 Voice Segment Manifest

版本庫只追蹤 metadata、manifest 與本機切段工具；不追蹤影片／音檔，也不提供下載器、OCR、voice embedding 或任何付費／會員限制繞過。

另外提供本機媒體的 anchor cutter。它只負責可追溯切檔，永遠不自行批准訓練；每份 sidecar 都會標示 `training_gate_required=true`。

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

目前 [xibao.anchors.json](../../configs/voice/xibao.anchors.json) 只有第一季第 5 話 `3.000..5.829` 的人工 seed，標為 `seed_only=true`，所以即使 verdict 是 accept 也不會進 training manifest。來源 inventory 的下載、訓練、再散布權限預設全部 deny。

## 下一階段校準條件

1. 先由人工確認來源的觀看／下載／訓練權利；沒有明確允許前維持 deny。
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
