#!/usr/bin/env python3
"""join_lines.py — 每集把 OCR 繁中字幕 × Whisper 日語 × 聲紋分數併成一份逐句表。

日語 join 的演算法沿用 arale-persona-bot/tools/persona/join_ja.py v2(競爭式分配):
每個 whisper word 歸給「窗中心最近、且中點落在 padded 窗內」的字幕行,
鄰行的話被鄰行吸走;每集先掃 ±2s 的系統性偏移。
差別:阿拉蕾是先歸屬再 join(只 join 她的行),這裡歸屬還沒做,所以全部行都 join,
日語原文同時也是下一步 LLM 歸屬的線索(語尾、自稱比中文字幕更能分辨誰在講)。

輸入:subs/epNN.json、whisper/epNN.whisper.jsonl、voice/epNN.voice.json(缺了就不帶分數)
輸出:lines/epNN.lines.json — [{id,start,end,zh,ja,ja_conf,voice_margin}]
跑法:python3 tools/persona/join_lines.py [ep01 ...](純 CPU、冪等、每次重寫)
"""

import json
import os
import sys
from pathlib import Path

ROOT = Path(os.environ.get("XIBAO_ROOT", "/mnt/seagate/xibao-persona"))
PAD = 0.30
OFFSET_RANGE = 2.0
OFFSET_STEP = 0.1


def load_words(path):
    words = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            if line.strip():
                words.extend(json.loads(line).get("words", []))
    return sorted(words, key=lambda w: w["start"])


def scan_offset(words, lines):
    mids = [(w["start"] + w["end"]) / 2 for w in words]
    best_off, best_hits = 0.0, -1
    n = int(OFFSET_RANGE / OFFSET_STEP)
    for i in range(-n, n + 1):
        off = round(i * OFFSET_STEP, 2)
        hits = sum(any(l["start"] - PAD <= m - off <= l["end"] + PAD for l in lines) for m in mids)
        if hits > best_hits:
            best_off, best_hits = off, hits
    return best_off, best_hits


def assign_words(words, lines, offset):
    assigned = {}
    for w in words:
        mid = (w["start"] + w["end"]) / 2 - offset
        best, best_d = None, None
        for l in lines:
            if l["start"] - PAD <= mid <= l["end"] + PAD:
                d = abs(mid - (l["start"] + l["end"]) / 2)
                if best_d is None or d < best_d:
                    best, best_d = l["id"], d
        if best is not None:
            assigned.setdefault(best, []).append(w)
    return assigned


def join_episode(ep):
    subs = json.load((ROOT / "subs" / f"{ep}.json").open(encoding="utf-8"))
    wpath = ROOT / "whisper" / f"{ep}.whisper.jsonl"
    vpath = ROOT / "voice" / f"{ep}.voice.json"
    voice = json.load(vpath.open(encoding="utf-8")) if vpath.exists() else {}

    assigned, offset = {}, 0.0
    if wpath.exists():
        words = load_words(wpath)
        offset, hits = scan_offset(words, subs)
        assigned = assign_words(words, subs, offset)
        print(f"[{ep}] offset={offset:+.1f}s words_in_windows={hits}/{len(words)}")

    out = []
    for l in subs:
        ws = sorted(assigned.get(l["id"], []), key=lambda w: w["start"])
        ja = "".join(w["word"] for w in ws).replace(" ", "").strip()
        conf = round(sum(w["prob"] for w in ws) / len(ws), 2) if ws else 0.0
        v = voice.get(str(l["id"]), {})
        out.append({
            "id": l["id"], "start": l["start"], "end": l["end"],
            "zh": l["text"], "ja": ja, "ja_conf": conf,
            "voice_margin": v.get("margin"),
        })
    (ROOT / "lines").mkdir(exist_ok=True)
    json.dump(out, (ROOT / "lines" / f"{ep}.lines.json").open("w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    with_ja = sum(1 for r in out if r["ja"])
    print(f"[{ep}] {len(out)} lines, ja={with_ja}, voice={len(voice)}")


if __name__ == "__main__":
    eps = sys.argv[1:] or sorted(p.stem for p in (ROOT / "subs").glob("ep*.json"))
    for ep in eps:
        join_episode(ep)
