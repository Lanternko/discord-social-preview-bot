#!/usr/bin/env python3
"""Export high-confidence human reviews into local positive and hard-negative banks."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path


def classify(answers: dict) -> str | None:
    confidence = answers.get("confidence")
    if confidence not in {3, 4, 5}:
        return None
    if answers.get("verdict") == "target" and answers.get("overlap") is False:
        return "positive"
    if answers.get("verdict") == "other" and answers.get("overlap") is False:
        return "negative"
    return None


def build(reviews_path: Path, out_dir: Path) -> dict:
    document = json.loads(reviews_path.read_text(encoding="utf-8"))
    reviews = document.get("reviews")
    if not isinstance(reviews, dict):
        raise ValueError("reviews document must contain a reviews object")
    staging = Path(tempfile.mkdtemp(prefix=".review-bank.", dir=out_dir.parent))
    counts = {"positive": 0, "negative": 0, "ignored": 0}
    try:
        for review in reviews.values():
            if not isinstance(review, dict) or review.get("kind") != "identity":
                counts["ignored"] += 1
                continue
            label = classify(review.get("answers", {}))
            media_value = review.get("media_path")
            media_path = Path(media_value) if isinstance(media_value, str) else None
            if label is None or media_path is None or not media_path.is_file():
                counts["ignored"] += 1
                continue
            sidecar_path = media_path.with_suffix(".json")
            sidecar = {}
            if sidecar_path.is_file():
                sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
            destination = staging / label
            destination.mkdir(parents=True, exist_ok=True)
            slug = media_path.stem
            shutil.copy2(media_path, destination / f"{slug}.wav")
            exported = {
                "schema_version": "pilotfish.review_bank.v1",
                "label": label,
                "source_id": sidecar.get("source_id") or sidecar.get("source"),
                "start_s": sidecar.get("start_s"),
                "end_s": sidecar.get("end_s"),
                "audio_sha256": sidecar.get("audio_sha256") or sidecar.get("output_hash"),
                "review": review,
                "candidate": sidecar,
            }
            (destination / f"{slug}.json").write_text(
                json.dumps(exported, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            counts[label] += 1
        (staging / "manifest.json").write_text(
            json.dumps({"schema_version": "pilotfish.review_bank_manifest.v1", **counts},
                       ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        if out_dir.exists():
            shutil.rmtree(out_dir)
        os.replace(staging, out_dir)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reviews", required=True)
    parser.add_argument("--out-dir", required=True)
    args = parser.parse_args(argv)
    out_dir = Path(args.out_dir).resolve()
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    print(json.dumps(build(Path(args.reviews).resolve(), out_dir), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
