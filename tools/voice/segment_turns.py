#!/usr/bin/env python3
"""Cut local episode audio into clips and rank them against the review bank.

Pass ``--sentences`` (from ``sentence_asr.py``) and the segmentation is driven by
transcript sentences, because VAD alone cannot see every boundary: consecutive
lines here are often delivered with no pause at all, so a silence-based splitter
glues them together.  Sentences that *do* run together stay in one clip — the
reviewer only objects to a merge when it spans a change of tone — and a clip ends
at the first pause of ``--sentence-break-gap`` or longer.  Without
``--sentences`` the older VAD-run segmentation is used.

Edge placement is its own problem, and every rule in ``refine_edges`` comes from
a clip that was rejected by ear.  Measured against the batch the reviewer
accepted, a good clip carries ~0.09 s of lead-in and ~0.19 s of run-out and its
edges sit near the noise floor; the rejected clips ended at 5.6x the floor,
i.e. while the voice was still sounding.

Intra-clip speaker-change detection by embedding drift was tried and dropped:
on this material ECAPA sub-window similarity does not separate a genuine single
speaker from a spliced two-speaker clip (the two distributions overlap almost
completely), so ``half_similarity`` is reported as weak evidence only and gates
nothing.  Median F0 is reported alongside it because this episode is a two-hander
with one female and one male voice, where pitch is the more honest signal.

Speaker identity here is *retrieval evidence only*, and ECAPA cannot tell the
target from another female character in the same scene — that has already
produced a wrong-speaker clip that only the picture caught.  The bank centroids
give a rank score and a cluster assignment; neither is a verdict, and nothing in
the output sets a training or review gate.

One check this tool does *not* do, and that is worth running afterwards: cut the
clip, transcribe it on its own, and confirm the text is the sentence you meant
and nothing more.  That round trip has caught head bleed the edge metrics passed.
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


def rms_track(samples, *, frame_s: float = 0.03, hop_s: float = 0.01):
    import numpy as np

    frame, hop = int(frame_s * SAMPLE_RATE), int(hop_s * SAMPLE_RATE)
    count = max(0, (len(samples) - frame) // hop + 1)
    return np.array([np.sqrt((samples[i * hop:i * hop + frame] ** 2).mean() + 1e-12)
                     for i in range(count)]), hop


def refine_edges(track, hop: int, start: float, end: float, *,
                 previous_end: float, next_start: float, duration_s: float,
                 head_pad: float, tail_pad: float, quiet_run_s: float,
                 max_tail_reach: float, floor_span_s: float) -> tuple[float, float, bool, bool]:
    """Walk each edge out to real silence, bounded by the neighbours and by the words.

    Four things this must not do, each of which produced a clip the reviewer rejected:

    * stop at a local energy minimum — that minimum sits inside the final syllable's
      decay, so the tail gets cut while the voice is still sounding;
    * cross into a neighbouring utterance when this one has no silence beside it;
    * judge a scene that has music under it against the whole episode's noise floor,
      which sends the tail running seconds into dead air; or
    * run far past the transcript looking for a silence that is not there.
    """
    import numpy as np

    def frame_at(t):
        return int(np.clip(round(t * SAMPLE_RATE / hop), 0, len(track) - 1))

    middle = frame_at((start + end) / 2)
    span = frame_at(floor_span_s)
    floor = float(np.percentile(track[max(0, middle - span):middle + span + 1], 20))
    threshold = floor * 1.8
    run = max(1, frame_at(quiet_run_s))

    index, limit = frame_at(start), frame_at(max(previous_end, start - 1.2))
    silence = None
    while index > limit:
        if track[max(0, index - run):index].max() < threshold:
            silence = index
            break
        index -= 1
    if silence is None:
        head, head_at_boundary = start, True
    else:
        onset = silence
        while onset < len(track) - 1 and track[onset] < threshold:
            onset += 1
        head, head_at_boundary = max(0.0, onset * hop / SAMPLE_RATE - head_pad), False

    index, limit = frame_at(end), frame_at(min(next_start, end + max_tail_reach))
    silence = None
    while index < limit:
        if track[index:index + run].max() < threshold:
            silence = index
            break
        index += 1
    if silence is None:
        tail, tail_at_boundary = min(end + head_pad, next_start), True
    else:
        offset = silence
        while offset > frame_at(head) and track[offset] < threshold:
            offset -= 1
        tail, tail_at_boundary = (offset + 1) * hop / SAMPLE_RATE + tail_pad, False

    return (round(max(0.0, head), 3), round(min(duration_s, tail), 3),
            head_at_boundary, tail_at_boundary)


def edge_report(track, hop: int, start: float, end: float, floor: float) -> dict[str, Any]:
    """How much silence each edge carries, and how loud it still is there."""
    import numpy as np

    lo = int(np.clip(round(start * SAMPLE_RATE / hop), 0, len(track) - 1))
    hi = int(np.clip(round(end * SAMPLE_RATE / hop), 0, len(track) - 1))
    clip = track[lo:hi]
    loud = clip > floor * 2.5
    if not len(clip) or not loud.any():
        return {}
    head = float(np.argmax(loud) * hop / SAMPLE_RATE)
    tail = len(clip) * hop / SAMPLE_RATE - (len(clip) - 1 - int(np.argmax(loud[::-1]))) * hop / SAMPLE_RATE
    return {"head_silence_s": round(head, 3), "tail_silence_s": round(tail, 3),
            "head_ratio": round(float(clip[:6].mean() / floor), 2),
            "tail_ratio": round(float(clip[-6:].mean() / floor), 2)}


def words_in_span(words: list[dict[str, Any]], start: float, end: float) -> str:
    """ASR text overlapping the span — positioning aid, never a verified transcript."""
    return "".join(word["text"] for word in words
                   if word["end"] > start + 0.05 and word["start"] < end - 0.05).strip()


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
    track, hop = rms_track(samples)
    global_floor = float(np.percentile(track, 20))

    if args.sentences:
        # Sentence boundaries see splits VAD cannot: consecutive lines are often
        # delivered with no pause at all. Lines that *do* run together stay in one
        # clip — the reviewer only objects when a merge spans a change of tone.
        source = json.loads(Path(args.sentences).resolve().read_text(encoding="utf-8"))
        sentences = [item for item in source["sentences"] if item["end"] <= args.analysis_end_s]
        groups: list[list[dict[str, Any]]] = [[sentences[0]]] if sentences else []
        for previous, sentence in zip(sentences, sentences[1:]):
            span = sentence["end"] - groups[-1][0]["start"]
            if sentence["start"] - previous["end"] >= args.sentence_break_gap or span > args.max_duration:
                groups.append([sentence])
            else:
                groups[-1].append(sentence)
        starts = [group[0]["start"] for group in groups]
        ends = [group[-1]["end"] for group in groups]
        spans = []
        for index, group in enumerate(groups):
            previous_end = ends[index - 1] if index else 0.0
            next_start = starts[index + 1] if index + 1 < len(groups) else duration_s
            head, tail, head_boundary, tail_boundary = refine_edges(
                track, hop, group[0]["start"], group[-1]["end"],
                previous_end=previous_end, next_start=next_start, duration_s=duration_s,
                head_pad=args.head_pad_s, tail_pad=args.tail_pad_s,
                quiet_run_s=args.quiet_run_s, max_tail_reach=args.max_tail_reach_s,
                floor_span_s=args.floor_span_s)
            spans.append((head, tail, [item["text"] for item in group],
                          head_boundary, tail_boundary))
    else:
        spans = []
        for start, end in speech:
            if start >= args.analysis_end_s:
                continue
            end = min(end, args.analysis_end_s)
            for piece_start, piece_end in split_long_run(
                    start, end, silences,
                    max_duration=args.max_duration, min_duration=args.min_duration):
                spans.append((piece_start, piece_end, None, False, False))

    def score_span(start_s: float, end_s: float, texts=None) -> dict[str, Any]:
        record: dict[str, Any] = {
            "start_s": round(start_s, 3),
            "end_s": round(end_s, 3),
            "duration_s": round(end_s - start_s, 3),
            "transcript_ja_asr": ("".join(texts) if texts is not None
                                  else words_in_span(words, start_s, end_s)),
            "sentences": texts,
            "within_visual_coverage": end_s <= args.visual_coverage_s,
            "edges": edge_report(track, hop, start_s, end_s, global_floor),
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
    for start_s, end_s, texts, head_boundary, tail_boundary in spans:
        if end_s - start_s < args.min_duration or end_s - start_s > args.max_duration:
            records.append({
                "start_s": round(start_s, 3), "end_s": round(end_s, 3),
                "duration_s": round(end_s - start_s, 3),
                "transcript_ja_asr": ("".join(texts) if texts is not None
                                      else words_in_span(words, start_s, end_s)),
                "within_visual_coverage": end_s <= args.visual_coverage_s,
                "exclusions": ["duration_out_of_range"],
            })
            continue
        record = score_span(start_s, end_s, texts)
        record["head_at_sentence_boundary"] = head_boundary
        record["tail_at_sentence_boundary"] = tail_boundary
        edges = record["edges"]
        if edges:
            # thresholds read off the batch the reviewer accepted: ~0.09 s of lead-in,
            # ~0.19 s of run-out, and edge energy near the noise floor rather than 5x it
            if edges["tail_ratio"] > args.max_edge_ratio or (
                    edges["tail_silence_s"] < args.min_tail_silence_s and not tail_boundary):
                record["exclusions"].append("tail_cut_while_still_sounding")
            if edges["head_ratio"] > args.max_edge_ratio or (
                    edges["head_silence_s"] < args.min_head_silence_s and not head_boundary):
                record["exclusions"].append("head_clipped")
            if edges["head_silence_s"] > args.max_head_silence_s:
                record["exclusions"].append("enters_too_early")
        records.append(record)

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
            "merge_gap_s": args.merge_gap_s,
            "min_duration": args.min_duration, "max_duration": args.max_duration,
            "sentences": args.sentences,
            "sentence_break_gap": args.sentence_break_gap,
            "head_pad_s": args.head_pad_s, "tail_pad_s": args.tail_pad_s,
            "max_tail_reach_s": args.max_tail_reach_s, "floor_span_s": args.floor_span_s,
            "min_head_silence_s": args.min_head_silence_s,
            "max_head_silence_s": args.max_head_silence_s,
            "min_tail_silence_s": args.min_tail_silence_s,
            "max_edge_ratio": args.max_edge_ratio,
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
    parser.add_argument("--min-duration", type=float, default=1.8)
    parser.add_argument("--max-duration", type=float, default=7.0)
    parser.add_argument("--sentences", help="sentence_asr.py output; drives segmentation when given")
    parser.add_argument("--sentence-break-gap", type=float, default=0.35,
                        help="A pause at least this long is a place a clip may end")
    parser.add_argument("--head-pad-s", type=float, default=0.08)
    parser.add_argument("--tail-pad-s", type=float, default=0.16)
    parser.add_argument("--quiet-run-s", type=float, default=0.08)
    parser.add_argument("--max-tail-reach-s", type=float, default=0.45,
                        help="How far past the transcript the tail may hunt for silence")
    parser.add_argument("--floor-span-s", type=float, default=5.0,
                        help="Half-width of the window the local noise floor is taken from")
    parser.add_argument("--min-head-silence-s", type=float, default=0.05)
    parser.add_argument("--max-head-silence-s", type=float, default=0.30)
    parser.add_argument("--min-tail-silence-s", type=float, default=0.12)
    parser.add_argument("--max-edge-ratio", type=float, default=2.2)
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
