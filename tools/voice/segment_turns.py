#!/usr/bin/env python3
"""Split local episode audio into speaking turns and rank them against the review bank.

The unit is one continuous run of voiced speech bounded by real silence, capped
at a few seconds — the previous batch was quarantined for gluing several turns
together, so the segmenter is driven by VAD pauses rather than by ASR segment
text, and any run longer than ``--max-duration`` is split at its deepest
internal pause instead of being kept whole.

Intra-clip speaker-change detection by embedding drift was tried and dropped:
on this material ECAPA sub-window similarity does not separate a genuine single
speaker from a spliced two-speaker clip (the two distributions overlap almost
completely), so ``half_similarity`` is reported as weak evidence only and gates
nothing.  Median F0 is reported alongside it because this episode is a two-hander
with one female and one male voice, where pitch is the more honest signal.

Speaker identity here is *retrieval evidence only*.  The bank centroids give a
rank score and a cluster assignment; neither is a verdict, and nothing in the
output sets a training or review gate.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any

MODEL_ID = "speechbrain/spkrec-ecapa-voxceleb"
SAMPLE_RATE = 16000
SCORER_VERSION = "pilotfish.turn_segment.v1"


def load_words(asr_path: Path, *, max_no_speech: float) -> list[dict[str, Any]]:
    document = json.loads(asr_path.read_text(encoding="utf-8"))
    words = []
    for segment in document.get("segments", []):
        if segment.get("no_speech_prob", 0.0) > max_no_speech:
            continue
        for word in segment.get("words", []):
            text = str(word.get("w", "")).strip()
            if text and isinstance(word.get("s"), (int, float)) and isinstance(word.get("e"), (int, float)):
                words.append({"text": text, "start": float(word["s"]), "end": float(word["e"]),
                              "probability": float(word.get("p", 0.0))})
    words.sort(key=lambda item: item["start"])
    return words


def speech_mask(samples, *, aggressiveness: int, frame_ms: int = 20):
    """Per-frame webrtcvad decision, smoothed so short blips do not split a turn."""
    import numpy as np
    import webrtcvad

    vad = webrtcvad.Vad(aggressiveness)
    frame_len = SAMPLE_RATE * frame_ms // 1000
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    frame_count = len(samples) // frame_len
    mask = np.zeros(frame_count, dtype=bool)
    for index in range(frame_count):
        chunk = pcm[index * frame_len * 2:(index + 1) * frame_len * 2]
        mask[index] = vad.is_speech(chunk, SAMPLE_RATE)
    return mask


def smooth_mask(mask, *, frame_ms: int, min_speech_ms: int, min_silence_ms: int):
    import numpy as np

    result = mask.copy()
    for target, minimum in ((False, min_silence_ms), (True, min_speech_ms)):
        frames = max(1, minimum // frame_ms)
        index = 0
        while index < len(result):
            if result[index] != target:
                index += 1
                continue
            end = index
            while end < len(result) and result[end] == target:
                end += 1
            if end - index < frames:
                result[index:end] = not target
            index = end
    return np.asarray(result)


def mask_runs(mask, frame_ms: int, *, value: bool) -> list[tuple[float, float]]:
    runs = []
    index = 0
    while index < len(mask):
        if mask[index] != value:
            index += 1
            continue
        end = index
        while end < len(mask) and mask[end] == value:
            end += 1
        runs.append((index * frame_ms / 1000, end * frame_ms / 1000))
        index = end
    return runs


def merge_runs(runs: list[tuple[float, float]], *, merge_gap_s: float) -> list[tuple[float, float]]:
    """Rejoin runs split by a pause too short to be a hand-over."""
    merged: list[list[float]] = []
    for start, end in runs:
        if merged and start - merged[-1][1] < merge_gap_s:
            merged[-1][1] = end
        else:
            merged.append([start, end])
    return [(start, end) for start, end in merged]


def split_long_run(start: float, end: float, silences: list[tuple[float, float]], *,
                   max_duration: float, min_duration: float) -> list[tuple[float, float]]:
    """Cut an over-long run at its deepest internal pause, recursively."""
    if end - start <= max_duration:
        return [(start, end)]
    inside = [run for run in silences
              if run[0] > start + min_duration and run[1] < end - min_duration]
    if not inside:
        return []
    pivot_start, pivot_end = max(inside, key=lambda run: run[1] - run[0])
    midpoint = (pivot_start + pivot_end) / 2
    return (split_long_run(start, midpoint, silences,
                           max_duration=max_duration, min_duration=min_duration) +
            split_long_run(midpoint, end, silences,
                           max_duration=max_duration, min_duration=min_duration))


def pad_into_silence(start: float, end: float, silences: list[tuple[float, float]], *,
                     pad_s: float, duration_s: float) -> tuple[float, float]:
    """Breathe a little room onto each edge without eating the neighbouring turn."""
    before = [run for run in silences if run[1] <= start + 0.02]
    after = [run for run in silences if run[0] >= end - 0.02]
    if before:
        start -= min(pad_s, (before[-1][1] - before[-1][0]) / 2)
    if after:
        end += min(pad_s, (after[0][1] - after[0][0]) / 2)
    return round(max(0.0, start), 3), round(min(duration_s, end), 3)


def words_in_span(words: list[dict[str, Any]], start: float, end: float) -> str:
    """ASR text overlapping the span — positioning aid, never a verified transcript."""
    return "".join(word["text"] for word in words
                   if word["end"] > start + 0.05 and word["start"] < end - 0.05).strip()


def merge_same_speaker(records: list[dict[str, Any]], samples, words, *, score,
                       gap_s: float, max_duration: float,
                       similarity_delta: float) -> list[dict[str, Any]]:
    """Rejoin neighbouring spans that a breath pause split mid-sentence.

    Two spans merge only when both already look like the *same* voice — their
    similarity to the bank centroid agrees within ``similarity_delta`` — so a
    pause that was actually a hand-over between the two characters is never
    bridged.  Merging is repeated until nothing else qualifies.
    """
    changed = True
    while changed:
        changed = False
        merged: list[dict[str, Any]] = []
        index = 0
        while index < len(records):
            current = records[index]
            following = records[index + 1] if index + 1 < len(records) else None
            joinable = (
                following is not None and
                not current["exclusions"] and not following["exclusions"] and
                "positive_similarity" in current and "positive_similarity" in following and
                following["start_s"] - current["end_s"] < gap_s and
                following["end_s"] - current["start_s"] <= max_duration and
                abs(current["positive_similarity"] - following["positive_similarity"]) <= similarity_delta
            )
            if joinable:
                merged.append(score(current["start_s"], following["end_s"]))
                index += 2
                changed = True
            else:
                merged.append(current)
                index += 1
        records = merged
    return records


def bank_embeddings(directory: Path, embed) -> list:
    import soundfile as sf

    vectors = []
    for path in sorted(directory.glob("*.wav")):
        samples, rate = sf.read(path, dtype="float32", always_2d=False)
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        if rate != SAMPLE_RATE:
            from scipy.signal import resample_poly
            samples = resample_poly(samples, SAMPLE_RATE, rate).astype("float32")
        vectors.append(embed(samples))
    return vectors


def median_f0(samples, *, floor: float = 60.0, ceiling: float = 500.0) -> float | None:
    """Median voiced pitch — a cheap, model-free check on the male/female split."""
    import numpy as np

    frame = int(0.04 * SAMPLE_RATE)
    hop = int(0.02 * SAMPLE_RATE)
    min_lag = int(SAMPLE_RATE / ceiling)
    max_lag = int(SAMPLE_RATE / floor)
    values = []
    for start in range(0, max(0, len(samples) - frame), hop):
        window = samples[start:start + frame]
        window = window - window.mean()
        energy = float(np.sqrt((window ** 2).mean()))
        if energy < 0.01:
            continue
        correlation = np.correlate(window, window, mode="full")[frame - 1:]
        if correlation[0] <= 0:
            continue
        search = correlation[min_lag:max_lag]
        if not len(search):
            continue
        lag = int(np.argmax(search)) + min_lag
        if correlation[lag] / correlation[0] < 0.3:
            continue
        values.append(SAMPLE_RATE / lag)
    return round(float(np.median(values)), 1) if values else None


def analyse(args: argparse.Namespace) -> dict[str, Any]:
    import numpy as np
    import soundfile as sf
    import torch
    import torch.nn.functional as functional
    from sklearn.cluster import KMeans
    from speechbrain.inference.speaker import EncoderClassifier

    audio_path = Path(args.audio).resolve()
    asr_path = Path(args.asr).resolve()
    bank_dir = Path(args.bank_dir).resolve()
    samples, rate = sf.read(audio_path, dtype="float32", always_2d=False)
    if samples.ndim > 1:
        samples = samples.mean(axis=1)
    if rate != SAMPLE_RATE:
        raise ValueError(f"expected {SAMPLE_RATE} Hz mono input, got {rate}")
    duration_s = len(samples) / SAMPLE_RATE

    device = "cuda" if torch.cuda.is_available() else "cpu"
    classifier = EncoderClassifier.from_hparams(
        source=MODEL_ID, savedir=args.model_dir, run_opts={"device": device},
    )

    def embed(chunk):
        tensor = torch.from_numpy(np.ascontiguousarray(chunk)).float().unsqueeze(0).to(device)
        with torch.no_grad():
            vector = classifier.encode_batch(tensor).squeeze()
        return functional.normalize(vector, dim=0).cpu()

    positive = bank_embeddings(bank_dir / "positive", embed)
    negative = bank_embeddings(bank_dir / "negative", embed)
    if len(positive) < 8 or len(negative) < 20:
        raise ValueError(f"review bank too small: {len(positive)} positive / {len(negative)} negative")
    positive_centroid = functional.normalize(torch.stack(positive).mean(dim=0), dim=0)
    negative_centroid = functional.normalize(torch.stack(negative).mean(dim=0), dim=0)

    frame_ms = 20
    mask = smooth_mask(speech_mask(samples, aggressiveness=args.vad_aggressiveness, frame_ms=frame_ms),
                       frame_ms=frame_ms, min_speech_ms=args.min_speech_ms,
                       min_silence_ms=args.min_silence_ms)
    silences = mask_runs(mask, frame_ms, value=False)
    speech = merge_runs(mask_runs(mask, frame_ms, value=True), merge_gap_s=args.merge_gap_s)
    words = load_words(asr_path, max_no_speech=args.max_no_speech)

    spans: list[tuple[float, float]] = []
    for start, end in speech:
        if start >= args.analysis_end_s:
            continue
        end = min(end, args.analysis_end_s)
        spans.extend(split_long_run(start, end, silences,
                                    max_duration=args.max_duration,
                                    min_duration=args.min_duration))

    def score_span(start_s: float, end_s: float) -> dict[str, Any]:
        record: dict[str, Any] = {
            "start_s": round(start_s, 3),
            "end_s": round(end_s, 3),
            "duration_s": round(end_s - start_s, 3),
            "transcript_ja_asr": words_in_span(words, start_s, end_s),
            "within_visual_coverage": end_s <= args.visual_coverage_s,
            "exclusions": [],
        }
        chunk = samples[int(start_s * SAMPLE_RATE):int(end_s * SAMPLE_RATE)]
        vector = embed(chunk)
        midpoint = len(chunk) // 2
        half_similarity = None
        if midpoint >= int(0.8 * SAMPLE_RATE):
            half_similarity = round(float(embed(chunk[:midpoint]) @ embed(chunk[midpoint:])), 4)
        record.update({
            "embedding": vector.tolist(),
            "half_similarity": half_similarity,
            "positive_similarity": round(float(vector @ positive_centroid), 4),
            "negative_similarity": round(float(vector @ negative_centroid), 4),
            "median_f0_hz": median_f0(chunk),
            "peak_dbfs": round(float(20 * np.log10(max(1e-6, np.abs(chunk).max()))), 1),
        })
        record["rank_score"] = round(record["positive_similarity"] - record["negative_similarity"], 4)
        return record

    records = []
    for start, end in spans:
        start_s, end_s = pad_into_silence(start, end, silences, pad_s=args.pad_s, duration_s=duration_s)
        if end_s - start_s < args.min_duration or end_s - start_s > args.max_duration:
            records.append({
                "start_s": round(start_s, 3), "end_s": round(end_s, 3),
                "duration_s": round(end_s - start_s, 3),
                "transcript_ja_asr": words_in_span(words, start_s, end_s),
                "within_visual_coverage": end_s <= args.visual_coverage_s,
                "exclusions": ["duration_out_of_range"],
            })
            continue
        records.append(score_span(start_s, end_s))

    if args.sentence_gap_s > 0:
        records = merge_same_speaker(records, samples, words, score=score_span,
                                     gap_s=args.sentence_gap_s,
                                     max_duration=args.max_merged_duration,
                                     similarity_delta=args.merge_similarity_delta)

    scorable = [record for record in records if "embedding" in record and not record["exclusions"]]
    if len(scorable) >= args.clusters:
        matrix = np.stack([np.asarray(record["embedding"]) for record in scorable])
        labels = KMeans(n_clusters=args.clusters, n_init=20, random_state=0).fit_predict(matrix)
        centroids = {}
        for cluster in range(args.clusters):
            members = matrix[labels == cluster]
            centroid = members.mean(axis=0)
            centroid = centroid / (np.linalg.norm(centroid) + 1e-9)
            centroids[cluster] = {
                "size": int(members.shape[0]),
                "positive_similarity": round(float(centroid @ positive_centroid.numpy()), 4),
                "negative_similarity": round(float(centroid @ negative_centroid.numpy()), 4),
            }
        best = max(centroids, key=lambda cluster: centroids[cluster]["positive_similarity"])
        for record, label in zip(scorable, labels):
            record["cluster"] = int(label)
            record["cluster_matches_bank"] = bool(label == best)
        cluster_report = {str(cluster): value for cluster, value in centroids.items()}
        cluster_report["bank_aligned_cluster"] = str(best)
    else:
        cluster_report = {"note": "too few scorable turns to cluster"}

    for record in records:
        record.pop("embedding", None)
    records.sort(key=lambda record: record["start_s"])
    return {
        "schema_version": SCORER_VERSION,
        "audio_path": str(audio_path),
        "asr_path": str(asr_path),
        "duration_s": round(duration_s, 3),
        "parameters": {
            "merge_gap_s": args.merge_gap_s, "pad_s": args.pad_s,
            "min_duration": args.min_duration, "max_duration": args.max_duration,
            "sentence_gap_s": args.sentence_gap_s,
            "max_merged_duration": args.max_merged_duration,
            "merge_similarity_delta": args.merge_similarity_delta,
            "vad_aggressiveness": args.vad_aggressiveness,
            "min_speech_ms": args.min_speech_ms, "min_silence_ms": args.min_silence_ms,
            "analysis_end_s": args.analysis_end_s, "visual_coverage_s": args.visual_coverage_s,
        },
        "bank": {"positive_clips": len(positive), "negative_clips": len(negative), "model": MODEL_ID},
        "clusters": cluster_report,
        "turns": records,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", required=True, help="16 kHz mono WAV on the container timeline")
    parser.add_argument("--asr", required=True, help="ASR JSON with word timestamps")
    parser.add_argument("--bank-dir", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--merge-gap-s", type=float, default=0.16,
                        help="Rejoin speech runs closer than this; above it, treat as a hand-over")
    parser.add_argument("--pad-s", type=float, default=0.08)
    parser.add_argument("--min-duration", type=float, default=1.8)
    parser.add_argument("--max-duration", type=float, default=5.0)
    parser.add_argument("--sentence-gap-s", type=float, default=0.45,
                        help="Rejoin same-voice neighbours closer than this; 0 disables the pass")
    parser.add_argument("--max-merged-duration", type=float, default=7.0)
    parser.add_argument("--merge-similarity-delta", type=float, default=0.18,
                        help="Max gap in bank similarity for two spans to count as one voice")
    parser.add_argument("--vad-aggressiveness", type=int, default=2)
    parser.add_argument("--min-speech-ms", type=int, default=200)
    parser.add_argument("--min-silence-ms", type=int, default=180)
    parser.add_argument("--max-no-speech", type=float, default=0.8)
    parser.add_argument("--clusters", type=int, default=2)
    parser.add_argument("--analysis-end-s", type=float, default=float("inf"))
    parser.add_argument("--visual-coverage-s", type=float, default=0.0)
    args = parser.parse_args(argv)
    report = analyse(args)
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    kept = [turn for turn in report["turns"] if not turn["exclusions"]]
    print(f"{out_path}: {len(report['turns'])} turns, {len(kept)} scorable")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
