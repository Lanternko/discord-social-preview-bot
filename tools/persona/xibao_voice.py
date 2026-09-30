#!/usr/bin/env python3
"""xibao_voice.py — 每句字幕的「像不像西」聲紋分數(歸屬的佐證,不是判決)。

參考聲 = pilotfish 人工審過的 review bank(positive 62 句西 / negative 68 句別人,
多為同性別配角)。ECAPA 分不出西和同性別配角(教訓見 memory xibao-voice-ecapa-limits),
所以輸出的是 margin = 像西的程度 − 像「被誤認成西的那群人」的程度,
LLM 歸屬時只當輔助訊號。

子指令:
    calibrate            bank 內 leave-one-out,印 AUC 與各門檻的精確率/召回率
    score [ep01 ...]     對 subs/epNN.json 每個事件算分 → voice/epNN.voice.json

venv:~/venvs/arale-voice(speechbrain)。ECAPA 權重借用 arale 已下載的那份。
機器滿載時務必 OMP_NUM_THREADS=2:預設 20 執行緒互搶,bank 130 句從 95 秒拖到 40 分鐘以上。
voice_common.py 原封複製自 arale-persona-bot/tools/voice/。
"""

import json
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import voice_common as vc  # noqa: E402

ROOT = Path(os.environ.get("XIBAO_ROOT", "/mnt/seagate/xibao-persona"))
BANK = Path(os.environ.get(
    "XIBAO_VOICE_BANK",
    Path.home() / "side_projects/apps/dspb-pilotfish/data/voice/xibao/calibration/review-bank"))
ECAPA_DIR = Path.home() / "side_projects/apps/arale-persona-bot/tools/voice/pretrained/ecapa"
CACHE = ROOT / "voice" / "bank_emb.npz"
TOPK = 5


def encoder():
    return vc.get_encoder(device="cpu", savedir=str(ECAPA_DIR))


def bank_embeddings():
    if CACHE.exists():
        z = np.load(CACHE)
        return z["pos"], z["neg"]
    enc = encoder()
    out = {}
    for side in ("positive", "negative"):
        embs = []
        for wav in sorted((BANK / side).glob("*.wav")):
            w, _ = vc.load_wav_16k_mono(str(wav))
            embs.append(vc.embed_slice(enc, w))
        out[side] = np.stack(embs)
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    np.savez(CACHE, pos=out["positive"], neg=out["negative"])
    return out["positive"], out["negative"]


def topk_mean(emb, bank, k=TOPK):
    sims = bank @ emb
    k = min(k, len(sims))
    return float(np.sort(sims)[-k:].mean())


def margin(emb, pos, neg):
    p, n = topk_mean(emb, pos), topk_mean(emb, neg)
    return p, n, p - n


def calibrate():
    pos, neg = bank_embeddings()
    scores = []  # (margin, is_xi)
    for i in range(len(pos)):
        scores.append((margin(pos[i], np.delete(pos, i, 0), neg)[2], 1))
    for i in range(len(neg)):
        scores.append((margin(neg[i], pos, np.delete(neg, i, 0))[2], 0))
    s = np.array([m for m, _ in scores])
    y = np.array([l for _, l in scores])
    # AUC = P(隨機一句西的分數 > 隨機一句別人)
    auc = float(np.mean([a > b for a in s[y == 1] for b in s[y == 0]]))
    print(f"[calibrate] pos={len(pos)} neg={len(neg)} LOO AUC={auc:.3f}")
    for thr in np.arange(-0.10, 0.16, 0.02):
        pred = s >= thr
        tp = int(np.sum(pred & (y == 1)))
        fp = int(np.sum(pred & (y == 0)))
        prec = tp / max(tp + fp, 1)
        rec = tp / int(np.sum(y == 1))
        print(f"  thr={thr:+.2f} precision={prec:.2f} recall={rec:.2f}")


def score(eps):
    pos, neg = bank_embeddings()
    enc = encoder()
    (ROOT / "voice").mkdir(exist_ok=True)
    for ep in eps:
        out = ROOT / "voice" / f"{ep}.voice.json"
        subs = ROOT / "subs" / f"{ep}.json"
        if out.exists():
            print(f"[skip] {out.name}")
            continue
        events = json.load(subs.open(encoding="utf-8"))
        wav, _ = vc.load_wav_16k_mono(str(ROOT / "episodes" / f"{ep}.wav"))
        spans = [{"id": e["id"], "start": e["start"], "end": e["end"]} for e in events]
        res = {}
        for sid, emb, note in vc.embed_segments(enc, wav, vc.SAMPLE_RATE, spans):
            if emb is None:
                res[sid] = {"note": note}
            else:
                p, n, m = margin(emb, pos, neg)
                res[sid] = {"pos": round(p, 3), "neg": round(n, 3), "margin": round(m, 3)}
        json.dump(res, out.open("w", encoding="utf-8"), ensure_ascii=False)
        print(f"[done] {ep}: {len(res)} lines", flush=True)


if __name__ == "__main__":
    cmd, *rest = sys.argv[1:] or ["calibrate"]
    if cmd == "calibrate":
        calibrate()
    elif cmd == "score":
        score(rest or sorted(p.stem for p in (ROOT / "subs").glob("ep*.json")))
    else:
        sys.exit(__doc__)
