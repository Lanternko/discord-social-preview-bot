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


def _resolve_sidecar(media_path: Path, search_roots: list[Path]) -> Path | None:
    direct = media_path.with_suffix(".json")
    if direct.is_file():
        return direct
    name = direct.name
    for root in search_roots:
        matches = list(root.rglob(name)) if root.is_dir() else []
        if matches:
            return matches[0]
    return None


def build(reviews_path: Path, out_dir: Path, search_roots: list[Path] | None = None) -> dict:
    document = json.loads(reviews_path.read_text(encoding="utf-8"))
    reviews = document.get("reviews")
    if not isinstance(reviews, dict):
        raise ValueError("reviews document must contain a reviews object")
    staging = Path(tempfile.mkdtemp(prefix=".review-bank.", dir=out_dir.parent))
    search_roots = search_roots or []
    transcript_reviews = {}
    for review in reviews.values():
        if not isinstance(review, dict):
            continue
        answers = review.get("answers", {})
        media_value = review.get("media_path")
        verified = answers.get("transcript_ja_verified")
        if (review.get("kind") == "transcript" and answers.get("verdict") == "accept" and
                isinstance(media_value, str) and isinstance(verified, str) and verified.strip()):
            transcript_reviews[Path(media_value).stem] = review
    counts = {"positive": 0, "negative": 0, "ignored": 0, "reviewed_spans": 0}
    try:
        for label in ("positive", "negative"):
            existing = out_dir / label
            destination = staging / label
            if existing.is_dir():
                shutil.copytree(existing, destination)
                counts[label] = len(list(destination.glob("*.wav")))
        if (out_dir / "reviewed").is_dir():
            shutil.copytree(out_dir / "reviewed", staging / "reviewed")
        for review in reviews.values():
            if not isinstance(review, dict) or review.get("kind") != "identity":
                counts["ignored"] += 1
                continue
            label = classify(review.get("answers", {}))
            media_value = review.get("media_path")
            media_path = Path(media_value) if isinstance(media_value, str) else None
            if media_path is None:
                counts["ignored"] += 1
                continue
            sidecar_path = _resolve_sidecar(media_path, search_roots)
            sidecar = {}
            if sidecar_path is not None:
                sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
            source_id = sidecar.get("source_id") or sidecar.get("source")
            start_s = sidecar.get("start_s")
            end_s = sidecar.get("end_s")
            if start_s is None and isinstance(sidecar.get("times"), dict):
                start_s = sidecar["times"].get("start_s")
                end_s = sidecar["times"].get("end_s")
            if isinstance(source_id, str) and isinstance(start_s, (int, float)) and isinstance(end_s, (int, float)):
                reviewed_dir = staging / "reviewed"
                reviewed_dir.mkdir(parents=True, exist_ok=True)
                (reviewed_dir / f"{media_path.stem}.json").write_text(
                    json.dumps({
                        "source_id": source_id, "start_s": start_s, "end_s": end_s,
                        "review": review,
                    }, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                    encoding="utf-8",
                )
            if label is None or not media_path.is_file():
                counts["ignored"] += 1
                continue
            destination = staging / label
            destination.mkdir(parents=True, exist_ok=True)
            slug = media_path.stem
            is_new = not (destination / f"{slug}.wav").exists()
            shutil.copy2(media_path, destination / f"{slug}.wav")
            transcript_review = transcript_reviews.get(slug) if label == "positive" else None
            verified = (transcript_review.get("answers", {}).get("transcript_ja_verified", "").strip()
                        if transcript_review else None)
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
            if verified:
                exported["transcript_ja_verified"] = verified
                exported["transcript_review"] = transcript_review
            (destination / f"{slug}.json").write_text(
                json.dumps(exported, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            if is_new:
                counts[label] += 1
        counts["reviewed_spans"] = len(list((staging / "reviewed").glob("*.json"))) if (staging / "reviewed").is_dir() else 0
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
    parser.add_argument("--search-root", action="append", default=[])
    args = parser.parse_args(argv)
    out_dir = Path(args.out_dir).resolve()
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    print(json.dumps(build(
        Path(args.reviews).resolve(), out_dir,
        [Path(path).resolve() for path in args.search_root],
    ), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
