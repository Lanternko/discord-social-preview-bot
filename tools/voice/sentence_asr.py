#!/usr/bin/env python3
"""Recover sentence boundaries that VAD cannot see, by walking overlapping ASR windows.

Turn segmentation by silence has a hard floor: consecutive sentences in this
material are often delivered with *no* pause between them.  In EP17,
「今じゃなかった」 ends at 436.42 s and 「言わない方がよかった」 starts at 436.42 s,
so every VAD setting keeps them in one run, and the resulting clip glues two
different deliveries together.  Only the ASR's own sentence boundaries see the
split.

Whisper's segment boundaries over a whole episode are not trustworthy — they
drift by seconds, and its VAD filter makes it worse — but over an isolated ~30 s
window they land on the sentence.  So the episode is walked in overlapping
windows, each window is transcribed with `vad_filter=False`, and only sentences
that fall inside the trusted core of a window (away from both seams) are kept.

Needs faster-whisper, which lives in ~/venvs/whisper rather than the tools venv:

    ~/venvs/whisper/bin/python tools/voice/sentence_asr.py <in.wav> <out.json>
"""

from __future__ import annotations

import argparse
import json
import wave
from pathlib import Path
from typing import Any


def transcribe(wav: Path, *, window_s: float, overlap_s: float, model_size: str,
               language: str) -> list[dict[str, Any]]:
    from faster_whisper import WhisperModel

    with wave.open(str(wav), "rb") as handle:
        duration = handle.getnframes() / handle.getframerate()
    model = WhisperModel(model_size, device="cuda", compute_type="float16")

    sentences: list[dict[str, Any]] = []
    offset = 0.0
    while offset < duration:
        length = min(window_s, duration - offset)
        if length < 1.0:
            break
        segments, _ = model.transcribe(
            str(wav), language=language, word_timestamps=True, vad_filter=False,
            beam_size=5, condition_on_previous_text=False,
            clip_timestamps=[offset, offset + length],
        )
        # a sentence straddling a seam is only half-heard, so keep the window's core
        core_lo = offset if offset == 0 else offset + overlap_s / 2
        core_hi = (offset + length if offset + length >= duration
                   else offset + length - overlap_s / 2)
        for segment in segments:
            text = segment.text.strip()
            if not text:
                continue
            words = segment.words or []
            start = float(words[0].start if words else segment.start)
            end = float(words[-1].end if words else segment.end)
            if start < core_lo - 0.05 or end > core_hi + 0.05:
                continue
            sentences.append({
                "start": round(start, 3), "end": round(end, 3), "text": text,
                "words": [{"w": word.word, "s": round(word.start, 3), "e": round(word.end, 3)}
                          for word in words],
            })
        offset += window_s - overlap_s

    sentences.sort(key=lambda item: item["start"])
    deduped: list[dict[str, Any]] = []
    for sentence in sentences:
        if deduped and sentence["start"] < deduped[-1]["end"] - 0.10:
            continue
        deduped.append(sentence)
    return deduped


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", help="16 kHz mono WAV on the container timeline")
    parser.add_argument("out", help="where to write the sentence list")
    parser.add_argument("--window-s", type=float, default=30.0)
    parser.add_argument("--overlap-s", type=float, default=6.0)
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--language", default="ja")
    args = parser.parse_args(argv)

    wav = Path(args.wav).resolve()
    sentences = transcribe(wav, window_s=args.window_s, overlap_s=args.overlap_s,
                           model_size=args.model, language=args.language)
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "schema_version": "pilotfish.sentence_asr.v1",
        "audio": str(wav), "model": args.model, "language": args.language,
        "window_s": args.window_s, "overlap_s": args.overlap_s,
        "sentences": sentences,
    }, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{out}: {len(sentences)} sentences")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
