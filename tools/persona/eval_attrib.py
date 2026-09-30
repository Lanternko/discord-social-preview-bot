#!/usr/bin/env python3
"""eval_attrib.py — 用 pilotfish 人工審過的 review bank 驗 attribute.py 對「西」的歸屬。

bank 的每段有 source_id(s1-epNN)與 start_s/end_s,時間軸實測和動畫瘋源對齊(差 <0.3s)。
每段找時間重疊最多的字幕行,看 LLM 有沒有標成西:
    positive 段被標西 = TP,沒標 = FN;negative 段被標西 = FP。
s2-ep17-local-b 是另一個來源的切片,時間軸不保證對齊,不算。
2026-08-09 那批「新測評前五段皆完全不像西」是整批回饋、不是逐段聽審:其中 ep06 65.2 和
08-11 逐段審過的 positive(63.3)同一句卻相反,ep05 83.0/97.4 在上下文裡明顯是西對本田解釋自己怕生。
所以這批不算(BULK_NOTE)。

跑法:python3 tools/persona/eval_attrib.py [--min-conf mid]
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(os.environ.get("XIBAO_ROOT", "/mnt/seagate/xibao-persona"))
BANK = Path(os.environ.get(
    "XIBAO_VOICE_BANK",
    Path.home() / "side_projects/apps/dspb-pilotfish/data/voice/xibao/calibration/review-bank"))
BULK_NOTE = "新測評前五段皆完全不像西"
RANK = {"low": 0, "mid": 1, "high": 2}


def best_line(lines, a, b):
    best, best_ov = None, 0.0
    for l in lines:
        ov = min(b, l["end"]) - max(a, l["start"])
        if ov > best_ov:
            best, best_ov = l, ov
    return best


def main():
    min_conf = sys.argv[sys.argv.index("--min-conf") + 1] if "--min-conf" in sys.argv else "low"
    stats = {"TP": 0, "FN": 0, "FP": 0, "TN": 0, "nomatch": 0}
    misses = []
    for side in ("positive", "negative"):
        for js in sorted((BANK / side).glob("s1-ep*.json")):
            clip = json.load(js.open(encoding="utf-8"))
            if BULK_NOTE in clip["review"]["answers"].get("notes", ""):
                continue
            ep = "ep" + clip["source_id"].split("-ep")[1]
            ap = ROOT / "attrib" / f"{ep}.attrib.json"
            if not ap.exists():
                continue
            l = best_line(json.load(ap.open(encoding="utf-8")), clip["start_s"], clip["end_s"])
            if l is None:
                stats["nomatch"] += 1
                continue
            said_xi = l["speaker"] == "西" and RANK[l["conf"]] >= RANK[min_conf]
            key = ("TP" if said_xi else "FN") if side == "positive" else ("FP" if said_xi else "TN")
            stats[key] += 1
            if key in ("FN", "FP"):
                misses.append(f'{key} {ep} {clip["start_s"]:.1f} got={l["speaker"]}/{l["conf"]} '
                              f'zh={l["zh"]} ja_verified={clip.get("transcript_ja_verified", "")}')
    tp, fn, fp = stats["TP"], stats["FN"], stats["FP"]
    print(f"[eval] min_conf={min_conf} {stats} "
          f"precision={tp/max(tp+fp,1):.2f} recall={tp/max(tp+fn,1):.2f}")
    for m in misses:
        print("  " + m)


if __name__ == "__main__":
    main()
