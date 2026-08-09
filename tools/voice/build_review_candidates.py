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


def build(args: argparse.Namespace) -> dict[str, Any]:
    import soundfile as sf
    import torch
    import torch.nn.functional as functional
    from scipy.signal import resample_poly
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
    reviewed_keys = bank_span_keys(*(path for path in (positive_dir, negative_dir) if path))
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
        positive_embeddings = [reference_embedding]
        if positive_dir and positive_dir.is_dir():
            positive_embeddings.extend(encode_file(path) for path in sorted(positive_dir.glob("*.wav")))
        negative_embeddings = []
        if negative_dir and negative_dir.is_dir():
            negative_embeddings.extend(encode_file(path) for path in sorted(negative_dir.glob("*.wav")))
        positive_bank = torch.stack(positive_embeddings)
        negative_bank = torch.stack(negative_embeddings) if negative_embeddings else None
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
                span["peak"] = round(peak, 6)
                span["rms_dbfs"] = round(20 * math.log10(max(rms, 1e-9)), 3)

    if negative_embeddings:
        eligible = [span for span in spans
                    if args.min_margin <= span["identity_margin"] <= args.max_margin]
        ranked = sorted(eligible, key=lambda item: (abs(item["identity_margin"]),
                                                    -item["positive_bank_score"]))[:args.top_k]
    else:
        ranked = sorted(spans, key=lambda item: item["rank_score"], reverse=True)[:args.top_k]
    if not ranked:
        raise ValueError("no candidates survived the identity margin gate")
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
            "max_rank_score": max(item["rank_score"] for item in ranked),
            "margin_gate": [args.min_margin, args.max_margin] if negative_embeddings else None}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--inventory", required=True)
    result.add_argument("--source-id", required=True)
    result.add_argument("--audio", required=True)
    result.add_argument("--subtitles", required=True)
    result.add_argument("--reference", required=True)
    result.add_argument("--positive-dir")
    result.add_argument("--negative-dir")
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
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.top_k <= 0 or args.batch_size <= 0:
        raise SystemExit("top-k and batch-size must be positive")
    print(json.dumps(build(args), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
