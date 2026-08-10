#!/usr/bin/env python3
"""Promote visually checked, uncalibrated retrieval candidates to human review.

This command never assigns a speaker label.  It copies only explicitly listed
candidate clips and adds continuous visual provenance plus a rank-only acoustic
record, so the review server can show them while keeping the training gate
closed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any


TARGET_SPEAKER = "西奈津美"
SCORER_VERSION = "pilotfish.retrieval_rank.v1"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def _candidate_path(source_dir: Path, source_id: str, start_s: float, end_s: float) -> Path:
    slug = f"{source_id}__{round(start_s * 1000):09d}-{round(end_s * 1000):09d}"
    return source_dir / f"{slug}.json"


def prepare(args: argparse.Namespace) -> dict[str, Any]:
    source_root = Path(args.source_root).resolve()
    output_root = Path(args.output_root).resolve()
    evidence_path = Path(args.evidence).resolve()
    bank_manifest_path = Path(args.bank_manifest).resolve()
    evidence = json.loads(evidence_path.read_text(encoding="utf-8"))
    entries = evidence.get("candidates")
    if not isinstance(entries, list) or not entries:
        raise ValueError("evidence must contain a non-empty candidates array")
    bank_manifest = json.loads(bank_manifest_path.read_text(encoding="utf-8"))
    positive = bank_manifest.get("positive")
    negative = bank_manifest.get("negative")
    if not isinstance(positive, int) or positive < 8 or not isinstance(negative, int) or negative < 20:
        raise ValueError("review bank is too small for retrieval review")
    bank_sha256 = sha256_file(bank_manifest_path)
    prepared = []
    seen = set()
    for selection_rank, item in enumerate(entries, 1):
        if not isinstance(item, dict):
            raise ValueError("each evidence entry must be an object")
        source_id = item.get("source_id")
        start_s = item.get("start_s")
        end_s = item.get("end_s")
        if not isinstance(source_id, str) or not isinstance(start_s, (int, float)) or not isinstance(end_s, (int, float)):
            raise ValueError("evidence entry needs source_id/start_s/end_s")
        key = (source_id, round(float(start_s), 3), round(float(end_s), 3))
        if key in seen:
            raise ValueError(f"duplicate evidence span: {key}")
        seen.add(key)
        candidate_dir = source_root / source_id
        candidate_json = _candidate_path(candidate_dir, source_id, float(start_s), float(end_s))
        candidate_wav = candidate_json.with_suffix(".wav")
        if not candidate_json.is_file() or not candidate_wav.is_file():
            raise ValueError(f"missing ranked candidate for {source_id} {start_s}-{end_s}")
        sidecar = json.loads(candidate_json.read_text(encoding="utf-8"))
        if sidecar.get("source_id") != source_id or sidecar.get("review_ready") is True:
            raise ValueError(f"candidate is not an unreviewed retrieval record: {candidate_json}")
        if (round(float(sidecar.get("start_s")), 3), round(float(sidecar.get("end_s")), 3)) != key[1:]:
            raise ValueError(f"candidate span mismatch: {candidate_json}")
        rank_score = sidecar.get("rank_score")
        if not isinstance(rank_score, (int, float)):
            raise ValueError(f"candidate has no rank_score: {candidate_json}")
        selection = {
            "kind": "retrieval_human_review",
            "character_on_screen": TARGET_SPEAKER,
            "observer": args.observer,
            "checked_at": args.checked_at,
            "mouth_motion_observed": True,
            "single_visible_speaker": True,
            "no_shot_change": True,
            "frames_per_second": 8,
            "evidence_note": item.get("evidence_note", "continuous 8 fps visual check"),
        }
        acoustic = {
            "review_eligible": True,
            "scorer_version": SCORER_VERSION,
            "decision": "uncalibrated_retrieval",
            "scored_at": args.checked_at,
            "bank_sha256": bank_sha256,
            "positive_clips": positive,
            "negative_clips": negative,
            "rank_score": round(float(rank_score), 6),
            "selection_rank": selection_rank,
        }
        sidecar["selection_evidence"] = selection
        sidecar["acoustic_precheck"] = acoustic
        sidecar["review_ready"] = True
        sidecar["review_batch"] = args.batch_id
        sidecar["training_eligible"] = False
        sidecar["training_gate_required"] = True
        sidecar["retrieval_only"] = True
        output_dir = output_root / source_id
        output_dir.mkdir(parents=True, exist_ok=True)
        output_json = output_dir / candidate_json.name
        output_wav = output_dir / candidate_wav.name
        if output_json.exists() or output_wav.exists():
            raise ValueError(f"refusing to overwrite existing review artifact: {output_json}")
        temporary_wav = output_wav.with_name(f".{output_wav.name}.tmp")
        shutil.copy2(candidate_wav, temporary_wav)
        os.replace(temporary_wav, output_wav)
        atomic_json(output_json, sidecar)
        prepared.append({"source_id": source_id, "start_s": start_s, "end_s": end_s,
                         "rank_score": rank_score, "path": str(output_json)})
    return {"batch_id": args.batch_id, "prepared": len(prepared), "bank_sha256": bank_sha256,
            "candidates": prepared}


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument("--source-root", required=True)
    result.add_argument("--output-root", required=True)
    result.add_argument("--evidence", required=True)
    result.add_argument("--bank-manifest", required=True)
    result.add_argument("--batch-id", required=True)
    result.add_argument("--observer", default="pilotfish-retrieval-visual-8fps")
    result.add_argument("--checked-at", required=True)
    return result


if __name__ == "__main__":
    print(json.dumps(prepare(parser().parse_args()), ensure_ascii=False, sort_keys=True))
