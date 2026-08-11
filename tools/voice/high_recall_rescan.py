#!/usr/bin/env python3
"""Rescan every subtitle turn without a per-episode top-k cutoff.

This tool is deliberately a retrieval pass, not a speaker gate.  It scores every
subtitle-derived turn with the reviewed positive/negative ECAPA bank, retains a
low-threshold spoken lane, and retains every short turn in a separate lane even
when ECAPA dislikes it.  The short lane exists because ECAPA is unreliable for
laughs and sub-two-second reactions.

Nothing emitted here is training eligible.  Existing reviewed spans are removed
from the new queue, but remain part of the classifier bank.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any, Iterable

MODEL_ID = "speechbrain/spkrec-ecapa-voxceleb"
SAMPLE_RATE = 16000
SCHEMA_VERSION = "pilotfish.high_recall_rescan.v1"
SPAN_RE = re.compile(r"^(s1-ep\d+)__(\d{9})-(\d{9})$")


def group_sentences(sentences: list[dict[str, Any]], *, break_gap: float,
                    max_duration: float) -> list[list[dict[str, Any]]]:
    """Keep contiguous lines together, matching the accepted turn policy."""
    valid = [row for row in sentences
             if isinstance(row.get("start"), (int, float))
             and isinstance(row.get("end"), (int, float))
             and row["end"] > row["start"]]
    if not valid:
        return []
    groups = [[valid[0]]]
    for previous, sentence in zip(valid, valid[1:]):
        combined_duration = float(sentence["end"]) - float(groups[-1][0]["start"])
        gap = float(sentence["start"]) - float(previous["end"])
        if gap >= break_gap or combined_duration > max_duration:
            groups.append([sentence])
        else:
            groups[-1].append(sentence)
    return groups


def candidate_spans(document: dict[str, Any], *, source_id: str,
                    min_duration: float, max_duration: float,
                    break_gap: float, head_pad: float,
                    tail_pad: float) -> list[dict[str, Any]]:
    groups = group_sentences(document.get("sentences", []),
                             break_gap=break_gap, max_duration=max_duration)
    starts = [float(group[0]["start"]) for group in groups]
    ends = [float(group[-1]["end"]) for group in groups]
    rows = []
    for index, group in enumerate(groups):
        previous_end = ends[index - 1] if index else 0.0
        next_start = starts[index + 1] if index + 1 < len(groups) else float("inf")
        start = max(previous_end, starts[index] - head_pad)
        end = min(next_start, ends[index] + tail_pad)
        duration = end - start
        if duration < min_duration or duration > max_duration:
            continue
        rows.append({
            "source_id": source_id,
            "start_s": round(start, 3),
            "end_s": round(end, 3),
            "duration_s": round(duration, 3),
            "subtitle_zh": " ".join(str(item.get("text", "")).strip()
                                      for item in group).strip(),
        })
    return rows


def reviewed_spans(document: dict[str, Any]) -> dict[str, list[tuple[float, float]]]:
    spans: dict[str, list[tuple[float, float]]] = {}
    for review in document.get("reviews", {}).values():
        if review.get("kind") != "identity":
            continue
        stem = Path(str(review.get("media_path", ""))).stem
        match = SPAN_RE.match(stem)
        if not match:
            continue
        source_id, start_ms, end_ms = match.groups()
        spans.setdefault(source_id, []).append((int(start_ms) / 1000, int(end_ms) / 1000))
    return spans


def overlaps_reviewed(candidate: dict[str, Any], known: dict[str, list[tuple[float, float]]],
                      *, minimum_fraction: float = 0.5) -> bool:
    start, end = candidate["start_s"], candidate["end_s"]
    duration = max(end - start, 1e-9)
    for old_start, old_end in known.get(candidate["source_id"], []):
        overlap = max(0.0, min(end, old_end) - max(start, old_start))
        if overlap / min(duration, max(old_end - old_start, 1e-9)) >= minimum_fraction:
            return True
    return False


def select_lanes(rows: Iterable[dict[str, Any]], *, spoken_score: float,
                 short_max_duration: float) -> list[dict[str, Any]]:
    selected = []
    for row in rows:
        lane = None
        if row["duration_s"] < short_max_duration:
            lane = "short_reaction_unfiltered"
        elif row["retrieval_score"] >= spoken_score:
            lane = "spoken_low_threshold"
        if lane:
            selected.append({**row, "lane": lane, "training_eligible": False,
                             "speaker_verdict": "pending_human_review"})
    return selected


def encode_chunks(classifier, chunks: list, *, batch_size: int):
    import numpy as np
    import torch
    import torch.nn.functional as functional

    output = []
    for offset in range(0, len(chunks), batch_size):
        batch = chunks[offset:offset + batch_size]
        maximum = max(len(chunk) for chunk in batch)
        padded = torch.zeros((len(batch), maximum), dtype=torch.float32)
        lengths = torch.tensor([len(chunk) / maximum for chunk in batch])
        for index, chunk in enumerate(batch):
            padded[index, :len(chunk)] = torch.from_numpy(np.ascontiguousarray(chunk))
        with torch.no_grad():
            encoded = classifier.encode_batch(padded, lengths).squeeze(1)
        output.extend(functional.normalize(encoded, dim=1).cpu().numpy())
    return output


def load_bank(bank_dir: Path, classifier, *, batch_size: int):
    import soundfile as sf
    from scipy.signal import resample_poly

    chunks, labels, groups, durations = [], [], [], []
    for label, name in ((1, "positive"), (0, "negative")):
        for path in sorted((bank_dir / name).glob("*.wav")):
            samples, rate = sf.read(path, dtype="float32", always_2d=False)
            if samples.ndim > 1:
                samples = samples.mean(axis=1)
            if rate != SAMPLE_RATE:
                samples = resample_poly(samples, SAMPLE_RATE, rate).astype("float32")
            sidecar = path.with_suffix(".json")
            source_id = "unknown"
            if sidecar.is_file():
                source_id = json.loads(sidecar.read_text(encoding="utf-8")).get(
                    "source_id", "unknown")
            chunks.append(samples)
            labels.append(label)
            groups.append(source_id)
            durations.append(len(samples) / SAMPLE_RATE)
    return (encode_chunks(classifier, chunks, batch_size=batch_size), labels,
            groups, durations)


def validation_report(vectors, labels, groups, durations, *, spoken_score: float,
                      short_max_duration: float) -> dict[str, Any]:
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedGroupKFold, cross_val_predict
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    matrix = np.stack(vectors)
    labels_array = np.asarray(labels)
    groups_array = np.asarray(groups)
    durations_array = np.asarray(durations)
    folds = min(len(set(groups)), 5)
    model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0))
    probabilities = cross_val_predict(
        model, matrix, labels_array,
        cv=StratifiedGroupKFold(n_splits=folds, shuffle=True, random_state=0),
        groups=groups_array, method="predict_proba")[:, 1]
    positive = probabilities[labels_array == 1]
    negative = probabilities[labels_array == 0]
    comparisons = positive[:, None] - negative[None, :]
    report = {
        "auc": round(float((comparisons > 0).mean()
                           + 0.5 * (comparisons == 0).mean()), 4),
        "folds": folds,
        "positives": int((labels_array == 1).sum()),
        "negatives": int((labels_array == 0).sum()),
        "score_calibrated": False,
        "usage": "retrieval_ranking_only",
        "operating_points": [],
    }
    for threshold in (0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9):
        report["operating_points"].append({
            "threshold": threshold,
            "recall": round(float((positive >= threshold).mean()), 4),
            "false_positive_rate": round(float((negative >= threshold).mean()), 4),
        })
    selected = ((durations_array < short_max_duration) |
                (probabilities >= spoken_score))
    positive_mask = labels_array == 1
    negative_mask = labels_array == 0
    report["two_lane_policy"] = {
        "spoken_score_threshold": spoken_score,
        "short_max_duration_s": short_max_duration,
        "recall": round(float(selected[positive_mask].mean()), 4),
        "false_positive_rate": round(float(selected[negative_mask].mean()), 4),
        "short_positive_count": int((positive_mask &
                                     (durations_array < short_max_duration)).sum()),
        "short_negative_count": int((negative_mask &
                                     (durations_array < short_max_duration)).sum()),
    }
    return report


def main(argv: list[str] | None = None) -> int:
    import numpy as np
    import soundfile as sf
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from speechbrain.inference.speaker import EncoderClassifier

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio-root", required=True)
    parser.add_argument("--sentences-root", required=True)
    parser.add_argument("--bank-dir", required=True)
    parser.add_argument("--reviews", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--spoken-score", type=float, default=0.2)
    parser.add_argument("--short-max-duration", type=float, default=1.8)
    parser.add_argument("--min-duration", type=float, default=0.35)
    parser.add_argument("--max-duration", type=float, default=7.0)
    parser.add_argument("--break-gap", type=float, default=0.35)
    parser.add_argument("--head-pad", type=float, default=0.08)
    parser.add_argument("--tail-pad", type=float, default=0.16)
    parser.add_argument("--batch-size", type=int, default=48)
    args = parser.parse_args(argv)

    classifier = EncoderClassifier.from_hparams(
        source=MODEL_ID, savedir=args.model_dir, run_opts={"device": "cpu"})
    bank_vectors, labels, groups, bank_durations = load_bank(
        Path(args.bank_dir), classifier, batch_size=args.batch_size)
    validation = validation_report(
        bank_vectors, labels, groups, bank_durations,
        spoken_score=args.spoken_score, short_max_duration=args.short_max_duration)
    model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0))
    model.fit(np.stack(bank_vectors), np.asarray(labels))
    known = reviewed_spans(json.loads(Path(args.reviews).read_text(encoding="utf-8")))

    all_rows = []
    per_episode = {}
    for episode in range(1, 13):
        source_id = f"s1-ep{episode:02d}"
        audio_path = Path(args.audio_root) / f"{source_id}.wav"
        sentence_path = Path(args.sentences_root) / f"{source_id}.sentences.json"
        samples, rate = sf.read(audio_path, dtype="float32", always_2d=False)
        if samples.ndim > 1:
            samples = samples.mean(axis=1)
        if rate != SAMPLE_RATE:
            raise ValueError(f"expected {SAMPLE_RATE} Hz in {audio_path}, got {rate}")
        rows = candidate_spans(
            json.loads(sentence_path.read_text(encoding="utf-8")), source_id=source_id,
            min_duration=args.min_duration, max_duration=args.max_duration,
            break_gap=args.break_gap, head_pad=args.head_pad, tail_pad=args.tail_pad)
        fresh = [row for row in rows if not overlaps_reviewed(row, known)]
        chunks = [samples[round(row["start_s"] * SAMPLE_RATE):
                          round(row["end_s"] * SAMPLE_RATE)] for row in fresh]
        vectors = encode_chunks(classifier, chunks, batch_size=args.batch_size) if chunks else []
        for row, vector in zip(fresh, vectors):
            row["audio_path"] = str(audio_path.resolve())
            row["retrieval_score"] = round(
                float(model.predict_proba(vector[None, :])[0, 1]), 4)
            row["acoustic_score_calibrated"] = False
        selected = select_lanes(fresh, spoken_score=args.spoken_score,
                                short_max_duration=args.short_max_duration)
        all_rows.extend(selected)
        per_episode[source_id] = {
            "subtitle_turns": len(rows),
            "already_reviewed": len(rows) - len(fresh),
            "fresh_scored": len(fresh),
            "selected": len(selected),
            "short_lane": sum(row["lane"] == "short_reaction_unfiltered" for row in selected),
            "spoken_lane": sum(row["lane"] == "spoken_low_threshold" for row in selected),
        }
        print(f"{source_id}: {len(fresh)} fresh -> {len(selected)} selected", flush=True)

    all_rows.sort(key=lambda row: (row["lane"] != "spoken_low_threshold",
                                   -row["retrieval_score"], row["source_id"], row["start_s"]))
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "schema_version": SCHEMA_VERSION,
        "policy": {
            "no_top_k": True,
            "spoken_score_threshold": args.spoken_score,
            "acoustic_score_calibrated": False,
            "acoustic_score_usage": "retrieval_ranking_only",
            "short_max_duration": args.short_max_duration,
            "short_lane_uses_ecapa_as_gate": False,
            "training_eligible": False,
        },
        "bank_validation": validation,
        "per_episode": per_episode,
        "candidate_count": len(all_rows),
        "candidates": all_rows,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{out}: {len(all_rows)} candidates", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
