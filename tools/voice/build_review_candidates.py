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
    with torch.inference_mode():
        reference_embedding = classifier.encode_batch(reference.to(device)).squeeze()
        reference_embedding = functional.normalize(reference_embedding, dim=0)
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
            for span, clip, score in zip(batch_spans, clips, scores.cpu().tolist()):
                peak = float(clip.abs().max()) if clip.numel() else 0.0
                rms = float(torch.sqrt(torch.mean(clip.square()))) if clip.numel() else 0.0
                span["rank_score"] = round(float(score), 6)
                span["peak"] = round(peak, 6)
                span["rms_dbfs"] = round(20 * math.log10(max(rms, 1e-9)), 3)

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
            "max_rank_score": ranked[0]["rank_score"]}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--inventory", required=True)
    result.add_argument("--source-id", required=True)
    result.add_argument("--audio", required=True)
    result.add_argument("--subtitles", required=True)
    result.add_argument("--reference", required=True)
    result.add_argument("--out-dir", required=True)
    result.add_argument("--model-dir", default="data/voice/models/spkrec-ecapa-voxceleb")
    result.add_argument("--top-k", type=int, default=30)
    result.add_argument("--batch-size", type=int, default=32)
    result.add_argument("--min-duration", type=float, default=1.2)
    result.add_argument("--max-duration", type=float, default=7.0)
    result.add_argument("--exclude-start", type=float, default=3.0)
    result.add_argument("--exclude-end", type=float, default=5.829)
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if args.top_k <= 0 or args.batch_size <= 0:
        raise SystemExit("top-k and batch-size must be positive")
    print(json.dumps(build(args), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
