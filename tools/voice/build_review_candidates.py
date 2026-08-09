#!/usr/bin/env python3
"""Rank subtitle-aligned local audio spans against a gold speaker reference."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any


MODEL_ID = "speechbrain/spkrec-ecapa-voxceleb"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def subtitle_spans(document: dict[str, Any], *, min_duration: float = 1.2,
                   max_duration: float = 7.0) -> list[dict[str, Any]]:
    events = document.get("events")
    if not isinstance(events, list):
        raise ValueError("subtitle JSON3 must contain an events array")
    spans = []
    for event_index, event in enumerate(events):
        if not isinstance(event, dict) or not isinstance(event.get("segs"), list):
            continue
        text = "".join(str(segment.get("utf8", "")) for segment in event["segs"]
                       if isinstance(segment, dict)).strip()
        if not text or "\n" in text or text.startswith("-"):
            continue
        start_ms = event.get("tStartMs")
        duration_ms = event.get("dDurationMs")
        if not isinstance(start_ms, (int, float)) or not isinstance(duration_ms, (int, float)):
            continue
        start_s = float(start_ms) / 1000
        duration_s = float(duration_ms) / 1000
        if not math.isfinite(start_s + duration_s) or not min_duration <= duration_s <= max_duration:
            continue
        spans.append({
            "event_index": event_index,
            "start_s": round(start_s, 3),
            "end_s": round(start_s + duration_s, 3),
            "duration_s": round(duration_s, 3),
            "transcript_zh_subtitle": text,
        })
    return spans


def overlaps(span: dict[str, Any], start_s: float, end_s: float) -> bool:
    return span["start_s"] < end_s and span["end_s"] > start_s


def _rights_allow(inventory: dict[str, Any], source_id: str) -> None:
    sources = inventory.get("sources")
    if not isinstance(sources, list):
        raise ValueError("inventory.sources must be an array")
    source = next((item for item in sources
                   if isinstance(item, dict) and item.get("source_id") == source_id), None)
    if source is None:
        raise ValueError(f"unknown source_id: {source_id}")
    rights = source.get("rights")
    if not isinstance(rights, dict) or rights.get("research_extraction") != "allow":
        raise ValueError(f"source {source_id} does not allow research_extraction")


def _atomic_json(path: Path, document: dict[str, Any]) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(document, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def bank_span_keys(*directories: Path) -> set[tuple[str, float, float]]:
    keys = set()
    for directory in directories:
        if not directory.is_dir():
            continue
        for path in directory.glob("*.json"):
            document = json.loads(path.read_text(encoding="utf-8"))
            candidate = document.get("candidate") if isinstance(document.get("candidate"), dict) else document
            source_id = document.get("source_id") or candidate.get("source_id")
            start_s = document.get("start_s") if document.get("start_s") is not None else candidate.get("start_s")
            end_s = document.get("end_s") if document.get("end_s") is not None else candidate.get("end_s")
            if isinstance(source_id, str) and isinstance(start_s, (int, float)) and isinstance(end_s, (int, float)):
                keys.add((source_id, round(float(start_s), 3), round(float(end_s), 3)))
    return keys


def bank_source_ids(directory: Path | None) -> set[str]:
    """Return provenance source ids from reviewed-bank sidecars."""
    source_ids = set()
    if directory is None or not directory.is_dir():
        return source_ids
    for path in directory.glob("*.json"):
        document = json.loads(path.read_text(encoding="utf-8"))
        candidate = document.get("candidate")
        source_id = document.get("source_id")
        if not isinstance(source_id, str) and isinstance(candidate, dict):
            source_id = candidate.get("source_id") or candidate.get("source")
        if isinstance(source_id, str) and source_id:
            source_ids.add(source_id)
    return source_ids


def bank_audio_records(directory: Path | None) -> list[tuple[Path, str]]:
    if directory is None or not directory.is_dir():
        return []
    records = []
    for audio_path in sorted(directory.glob("*.wav")):
        sidecar_path = audio_path.with_suffix(".json")
        source_id = f"unknown:{audio_path.stem}"
        if sidecar_path.is_file():
            document = json.loads(sidecar_path.read_text(encoding="utf-8"))
            candidate = document.get("candidate")
            value = document.get("source_id")
            if not isinstance(value, str) and isinstance(candidate, dict):
                value = candidate.get("source_id") or candidate.get("source")
            if isinstance(value, str) and value:
                source_id = value
        records.append((audio_path, source_id))
    return records


def review_gate_readiness(positive_sources: set[str], *, minimum_episodes: int) -> dict[str, Any]:
    episode_count = len(positive_sources)
    reasons = []
    if episode_count < minimum_episodes:
        reasons.append(
            f"positive bank covers {episode_count} episode(s); at least {minimum_episodes} required"
        )
    return {
        "review_ready": False,
        "positive_episode_count": episode_count,
        "minimum_positive_episodes": minimum_episodes,
        "episode_disjoint": False,
        "reasons": reasons,
    }


def finalize_review_gate(readiness: dict[str, Any], validation: dict[str, Any] | None) -> dict[str, Any]:
    result = {**readiness, "reasons": list(readiness["reasons"])}
    if validation is None:
        result["reasons"].append("speaker validation report is missing")
    else:
        result["episode_disjoint"] = validation.get("episode_disjoint") is True
        if not result["episode_disjoint"]:
            result["reasons"].append("speaker validation is not episode-disjoint")
        if validation.get("auc", 0.0) < 0.85:
            result["reasons"].append("speaker validation AUC is below 0.85")
        if validation.get("fpr", 1.0) > 0.05:
            result["reasons"].append("speaker validation FPR exceeds 0.05")
    result["reasons"] = list(dict.fromkeys(result["reasons"]))
    result["review_ready"] = not result["reasons"]
    return result


def binary_metrics(labels, probabilities, threshold: float) -> dict[str, float]:
    import numpy as np

    labels = np.asarray(labels)
    probabilities = np.asarray(probabilities)
    predicted = probabilities >= threshold
    positives = labels == 1
    negatives = labels == 0
    true_positives = int((predicted & positives).sum())
    false_positives = int((predicted & negatives).sum())
    positive_scores = probabilities[positives]
    negative_scores = probabilities[negatives]
    comparisons = positive_scores[:, None] - negative_scores[None, :]
    auc = float((comparisons > 0).mean() + 0.5 * (comparisons == 0).mean())
    return {
        "auc": round(auc, 6),
        "threshold": threshold,
        "fpr": round(false_positives / max(1, int(negatives.sum())), 6),
        "recall": round(true_positives / max(1, int(positives.sum())), 6),
        "positives": int(positives.sum()),
        "negatives": int(negatives.sum()),
    }


def build(args: argparse.Namespace) -> dict[str, Any]:
    import soundfile as sf
    import torch
    import torch.nn.functional as functional
    from scipy.signal import resample_poly
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import LeaveOneOut, StratifiedGroupKFold, cross_val_predict
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from speechbrain.inference.speaker import EncoderClassifier

    inventory_path = Path(args.inventory).resolve()
    audio_path = Path(args.audio).resolve()
    subtitle_path = Path(args.subtitles).resolve()
    reference_path = Path(args.reference).resolve()
    positive_dir = Path(args.positive_dir).resolve() if args.positive_dir else None
    negative_dir = Path(args.negative_dir).resolve() if args.negative_dir else None
    out_dir = Path(args.out_dir).resolve()
    for path in (inventory_path, audio_path, subtitle_path, reference_path):
        if not path.is_file():
            raise ValueError(f"missing input file: {path}")
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    _rights_allow(inventory, args.source_id)
    subtitle_document = json.loads(subtitle_path.read_text(encoding="utf-8"))
    spans = [span for span in subtitle_spans(
        subtitle_document, min_duration=args.min_duration, max_duration=args.max_duration,
    ) if not overlaps(span, args.exclude_start, args.exclude_end)]
    reviewed_dir = Path(args.reviewed_dir).resolve() if args.reviewed_dir else None
    reviewed_keys = bank_span_keys(*(
        path for path in (positive_dir, negative_dir, reviewed_dir) if path
    ))
    readiness = review_gate_readiness(
        bank_source_ids(positive_dir), minimum_episodes=args.min_positive_episodes,
    )
    spans = [span for span in spans if (
        args.source_id, span["start_s"], span["end_s"],
    ) not in reviewed_keys]
    if not spans:
        raise ValueError("no eligible subtitle spans")

    audio_samples, sample_rate = sf.read(audio_path, dtype="float32", always_2d=True)
    audio_samples = audio_samples.mean(axis=1)
    if sample_rate != 16000:
        audio_samples = resample_poly(audio_samples, 16000, sample_rate).astype("float32")
    waveform = torch.from_numpy(audio_samples).unsqueeze(0)
    reference_samples, reference_rate = sf.read(
        reference_path, dtype="float32", always_2d=True,
    )
    reference_samples = reference_samples.mean(axis=1)
    if reference_rate != 16000:
        reference_samples = resample_poly(reference_samples, 16000, reference_rate).astype("float32")
    reference = torch.from_numpy(reference_samples).unsqueeze(0)

    device = "cuda:0" if torch.cuda.is_available() else "cpu"
    classifier = EncoderClassifier.from_hparams(
        source=MODEL_ID, savedir=args.model_dir, run_opts={"device": device},
    )

    def encode_file(path: Path):
        samples, rate = sf.read(path, dtype="float32", always_2d=True)
        samples = samples.mean(axis=1)
        if rate != 16000:
            samples = resample_poly(samples, 16000, rate).astype("float32")
        tensor = torch.from_numpy(samples).unsqueeze(0).to(device)
        return functional.normalize(classifier.encode_batch(tensor).squeeze(), dim=0)

    with torch.inference_mode():
        reference_embedding = classifier.encode_batch(reference.to(device)).squeeze()
        reference_embedding = functional.normalize(reference_embedding, dim=0)
        positive_records = bank_audio_records(positive_dir)
        negative_records = bank_audio_records(negative_dir)
        human_positive_embeddings = [encode_file(path) for path, _ in positive_records]
        negative_embeddings = [encode_file(path) for path, _ in negative_records]
        positive_embeddings = [reference_embedding, *human_positive_embeddings]
        positive_bank = torch.stack(positive_embeddings)
        negative_bank = torch.stack(negative_embeddings) if negative_embeddings else None
        supervised_gate = None
        gate_report = None
        if human_positive_embeddings and negative_embeddings:
            cv_features = torch.stack([
                *human_positive_embeddings, *negative_embeddings,
            ]).cpu().numpy()
            cv_labels = [1] * len(human_positive_embeddings) + [0] * len(negative_embeddings)

            def new_gate():
                return make_pipeline(
                    StandardScaler(),
                    LogisticRegression(C=0.1, class_weight="balanced", max_iter=5000),
                )

            cv_groups = [source for _, source in positive_records + negative_records]
            if len(bank_source_ids(positive_dir)) >= args.min_positive_episodes:
                cv = StratifiedGroupKFold(
                    n_splits=min(3, len(set(cv_groups))), shuffle=True, random_state=17,
                )
                cv_probabilities = cross_val_predict(
                    new_gate(), cv_features, cv_labels, cv=cv, groups=cv_groups,
                    method="predict_proba",
                )[:, 1]
                episode_disjoint = True
            else:
                cv_probabilities = cross_val_predict(
                    new_gate(), cv_features, cv_labels, cv=LeaveOneOut(), method="predict_proba",
                )[:, 1]
                episode_disjoint = False
            gate_report = binary_metrics(cv_labels, cv_probabilities, args.min_probability)
            gate_report["episode_disjoint"] = episode_disjoint
            readiness = finalize_review_gate(readiness, gate_report)
            fit_features = torch.stack([
                reference_embedding, *human_positive_embeddings, *negative_embeddings,
            ]).cpu().numpy()
            fit_labels = ([1] * (1 + len(human_positive_embeddings)) +
                          [0] * len(negative_embeddings))
            supervised_gate = new_gate().fit(fit_features, fit_labels)
        for offset in range(0, len(spans), args.batch_size):
            batch_spans = spans[offset:offset + args.batch_size]
            clips = []
            for span in batch_spans:
                start = max(0, round(span["start_s"] * 16000))
                end = min(waveform.shape[-1], round(span["end_s"] * 16000))
                clips.append(waveform[0, start:end])
            maximum = max(clip.numel() for clip in clips)
            padded = torch.zeros((len(clips), maximum), dtype=waveform.dtype)
            lengths = torch.tensor([clip.numel() / maximum for clip in clips])
            for index, clip in enumerate(clips):
                padded[index, :clip.numel()] = clip
            embeddings = classifier.encode_batch(padded.to(device), lengths.to(device)).squeeze(1)
            embeddings = functional.normalize(embeddings, dim=1)
            scores = functional.cosine_similarity(embeddings, reference_embedding.unsqueeze(0), dim=1)
            positive_scores = embeddings @ positive_bank.T
            positive_mean = positive_scores.topk(min(3, positive_bank.shape[0]), dim=1).values.mean(dim=1)
            negative_mean = None
            if negative_bank is not None:
                negative_scores = embeddings @ negative_bank.T
                negative_mean = negative_scores.topk(min(3, negative_bank.shape[0]), dim=1).values.mean(dim=1)
            supervised_probabilities = None
            if supervised_gate is not None:
                supervised_probabilities = supervised_gate.predict_proba(
                    embeddings.cpu().numpy(),
                )[:, 1]
            for index, (span, clip, score) in enumerate(zip(
                batch_spans, clips, scores.cpu().tolist(),
            )):
                peak = float(clip.abs().max()) if clip.numel() else 0.0
                rms = float(torch.sqrt(torch.mean(clip.square()))) if clip.numel() else 0.0
                span["rank_score"] = round(float(score), 6)
                span["positive_bank_score"] = round(float(positive_mean[index].cpu()), 6)
                if negative_mean is not None:
                    span["negative_bank_score"] = round(float(negative_mean[index].cpu()), 6)
                    span["identity_margin"] = round(
                        span["positive_bank_score"] - span["negative_bank_score"], 6,
                    )
                if supervised_probabilities is not None:
                    span["speaker_probability"] = round(
                        float(supervised_probabilities[index]), 6,
                    )
                span["peak"] = round(peak, 6)
                span["rms_dbfs"] = round(20 * math.log10(max(rms, 1e-9)), 3)

    if supervised_gate is not None:
        eligible = [span for span in spans
                    if span["speaker_probability"] >= args.min_probability and
                    span.get("identity_margin", -math.inf) >= args.min_review_margin]
        ranked = sorted(eligible, key=lambda item: item["speaker_probability"], reverse=True)[:args.top_k]
    elif negative_embeddings:
        eligible = [span for span in spans
                    if args.min_margin <= span["identity_margin"] <= args.max_margin]
        ranked = sorted(eligible, key=lambda item: (abs(item["identity_margin"]),
                                                    -item["positive_bank_score"]))[:args.top_k]
    else:
        ranked = sorted(spans, key=lambda item: item["rank_score"], reverse=True)[:args.top_k]
    staging = Path(tempfile.mkdtemp(prefix=".candidates.", dir=out_dir.parent))
    try:
        source_hash = sha256_file(audio_path)
        reference_hash = sha256_file(reference_path)
        for rank, span in enumerate(ranked, 1):
            slug = f"{args.source_id}__{round(span['start_s'] * 1000):09d}-{round(span['end_s'] * 1000):09d}"
            wav_path = staging / f"{slug}.wav"
            start = round(span["start_s"] * 16000)
            end = round(span["end_s"] * 16000)
            clip = waveform[0, start:end].cpu().numpy()
            sf.write(wav_path, clip, 16000, subtype="PCM_16")
            sidecar = {
                "schema_version": "pilotfish.review_candidate.v1",
                "candidate_id": slug,
                "source_id": args.source_id,
                "start_s": span["start_s"],
                "end_s": span["end_s"],
                "duration_s": span["duration_s"],
                "speaker": "pending_human_review",
                "verdict": "pending",
                "uncertain": True,
                "overlap": "unknown",
                "transcript_zh_subtitle": span["transcript_zh_subtitle"],
                "rank": rank,
                "rank_score": span["rank_score"],
                "rank_score_calibrated": False,
                "positive_bank_score": span["positive_bank_score"],
                "negative_bank_score": span.get("negative_bank_score"),
                "identity_margin": span.get("identity_margin"),
                "identity_margin_policy": {
                    "min": args.min_margin, "max": args.max_margin,
                    "purpose": "ambiguous_review_only",
                },
                "speaker_probability": span.get("speaker_probability"),
                "speaker_gate": {
                    "kind": "standardized_logistic_regression",
                    "minimum_probability": args.min_probability,
                    "validation": gate_report,
                    **readiness,
                } if gate_report else None,
                "review_ready": bool(gate_report and readiness["review_ready"]),
                "quality": {"peak": span["peak"], "rms_dbfs": span["rms_dbfs"]},
                "model": MODEL_ID,
                "audio_sha256": sha256_file(wav_path),
                "source_sha256": source_hash,
                "reference_sha256": reference_hash,
                "training_eligible": False,
                "training_gate_required": True,
            }
            _atomic_json(staging / f"{slug}.json", sidecar)
        if out_dir.exists():
            shutil.rmtree(out_dir)
        os.replace(staging, out_dir)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return {"source_id": args.source_id, "considered": len(spans),
            "candidates": len(ranked), "out_dir": str(out_dir),
            "review_ready_candidates": len(ranked) if readiness["review_ready"] else 0,
            "review_gate": readiness,
            "max_rank_score": max((item["rank_score"] for item in ranked), default=None),
            "margin_gate": [args.min_margin, args.max_margin] if negative_embeddings else None,
            "speaker_gate": gate_report}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--inventory", required=True)
    result.add_argument("--source-id", required=True)
    result.add_argument("--audio", required=True)
    result.add_argument("--subtitles", required=True)
    result.add_argument("--reference", required=True)
    result.add_argument("--positive-dir")
    result.add_argument("--negative-dir")
    result.add_argument("--reviewed-dir")
    result.add_argument("--out-dir", required=True)
    result.add_argument("--model-dir", default="data/voice/models/spkrec-ecapa-voxceleb")
    result.add_argument("--top-k", type=int, default=30)
    result.add_argument("--batch-size", type=int, default=32)
    result.add_argument("--min-duration", type=float, default=1.2)
    result.add_argument("--max-duration", type=float, default=7.0)
    result.add_argument("--exclude-start", type=float, default=3.0)
    result.add_argument("--exclude-end", type=float, default=5.829)
    result.add_argument("--min-margin", type=float, default=0.0)
    result.add_argument("--max-margin", type=float, default=0.12)
    result.add_argument("--min-probability", type=float, default=0.70)
    result.add_argument("--min-review-margin", type=float, default=0.03)
    result.add_argument("--min-positive-episodes", type=int, default=3)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.top_k <= 0 or args.batch_size <= 0 or args.min_positive_episodes <= 0:
        raise SystemExit("top-k, batch-size and min-positive-episodes must be positive")
    print(json.dumps(build(args), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
