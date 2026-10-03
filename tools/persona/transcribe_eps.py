#!/usr/bin/env python3
"""transcribe_eps.py — 動畫音軌 → 16k wav → Whisper 日語逐句稿(word timestamps)。

改寫自 arale-persona-bot/tools/persona/transcribe_eps.py,差異只在路徑:
資料根目錄走 XIBAO_ROOT(預設 /mnt/seagate/xibao-persona),wav 缺了自己用 ffmpeg 抽。

引擎沿用阿拉蕾驗證過的設定:faster-whisper large-v3 / cuda float16 /
word_timestamps=True(OCR 行平均不到 2s,segment 級太粗)/
condition_on_previous_text=False(防漂移)/ 不開 VAD(BGM 讓 silero 不可靠)。

跑法:
    ~/venvs/whisper/bin/python tools/persona/transcribe_eps.py [ep01 ep02 ...]   # 省略 = 全部 mp4
冪等:輸出已存在就跳過(--force 重跑)。
輸出:$XIBAO_ROOT/whisper/epNN.whisper.jsonl,每行 {"start","end","text","words":[...]}
"""

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(os.environ.get("XIBAO_ROOT", "/mnt/seagate/xibao-persona"))
EPISODES = ROOT / "episodes"
OUTDIR = ROOT / "whisper"
MODEL_SIZE = "large-v3"


def ensure_wav(ep: str) -> Path:
    wav = EPISODES / f"{ep}.wav"
    if not wav.exists():
        mp4 = EPISODES / f"{ep}.mp4"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(mp4),
                        "-ac", "1", "-ar", "16000", str(wav)], check=True)
    return wav


def transcribe(model, ep: str, force: bool = False) -> None:
    out = OUTDIR / f"{ep}.whisper.jsonl"
    if out.exists() and not force:
        print(f"[skip] {out.name} 已存在(--force 重跑)")
        return
    wav = ensure_wav(ep)

    t0 = time.time()
    segments, info = model.transcribe(
        str(wav),
        language="ja",
        word_timestamps=True,
        condition_on_previous_text=False,
        vad_filter=False,
    )
    n = 0
    tmp = out.with_suffix(".jsonl.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        for seg in segments:
            rec = {
                "start": round(seg.start, 2),
                "end": round(seg.end, 2),
                "text": seg.text.strip(),
                "words": [
                    {"start": round(w.start, 2), "end": round(w.end, 2),
                     "word": w.word, "prob": round(w.probability, 3)}
                    for w in (seg.words or [])
                ],
            }
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            n += 1
    tmp.rename(out)
    dt = time.time() - t0
    print(f"[done] {ep}: {n} segments, {dt:.0f}s ({info.duration/dt:.1f}x realtime)", flush=True)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    force = "--force" in sys.argv
    eps = args or sorted(p.stem for p in EPISODES.glob("ep*.mp4"))
    OUTDIR.mkdir(parents=True, exist_ok=True)

    from faster_whisper import WhisperModel
    model = WhisperModel(MODEL_SIZE, device="cuda", compute_type="float16")
    for ep in eps:
        transcribe(model, ep, force=force)


if __name__ == "__main__":
    main()
