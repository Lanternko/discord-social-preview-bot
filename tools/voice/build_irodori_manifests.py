#!/usr/bin/env python3
"""Export a readiness-approved reviewed bank for Irodori preprocessing."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path

from training_readiness import assess, read_positive_bank


class ReadinessError(ValueError):
    pass


def _atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(value)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def export(bank_dir: Path, inventory_path: Path, out_dir: Path, **thresholds) -> dict:
    report = assess(bank_dir, inventory_path, **thresholds)
    if not report["ready_for_training"]:
        raise ReadinessError(
            "training readiness failed: " + ", ".join(report["failed_gates"])
        )
    records, issues = read_positive_bank(bank_dir)
    if issues:
        raise ReadinessError("positive bank changed after readiness assessment")
    holdout_source = report["gates"]["episode_disjoint_holdout"]["holdout_source"]
    train_rows = []
    holdout_rows = []
    provenance = []
    for record in records:
        if not record["valid"]:
            continue
        row = {
            "audio": record["audio"],
            "text": record["transcript_ja_verified"],
        }
        destination = holdout_rows if record["source_id"] == holdout_source else train_rows
        destination.append(row)
        provenance.append({
            "audio": record["audio"],
            "audio_sha256": record["audio_sha256"],
            "duration_s": record["duration_s"],
            "source_id": record["source_id"],
            "split": "holdout" if record["source_id"] == holdout_source else "train",
            "transcript_ja_verified": record["transcript_ja_verified"],
        })
    generation_id = _generation_id(provenance)
    train_text = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in train_rows)
    holdout_text = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in holdout_rows)
    manifest = {
        "schema_version": "pilotfish.irodori_dataset.v1",
        "generation_id": generation_id,
        "engine": report["engine_plan"],
        "readiness": report,
        "records": provenance,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    generation_dir = out_dir / generation_id
    if not generation_dir.exists():
        staging = Path(tempfile.mkdtemp(prefix=".generation.", dir=out_dir))
        try:
            (staging / "train.input.jsonl").write_text(train_text, encoding="utf-8")
            (staging / "holdout.jsonl").write_text(holdout_text, encoding="utf-8")
            (staging / "dataset.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            os.replace(staging, generation_dir)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
    _atomic_text(
        out_dir / "current.json",
        json.dumps({"generation_id": generation_id}, sort_keys=True) + "\n",
    )
    return {
        "generation_id": generation_id,
        "train": len(train_rows),
        "holdout": len(holdout_rows),
        "out_dir": str(generation_dir.resolve()),
    }


def _generation_id(records: list[dict]) -> str:
    import hashlib

    portable = [{key: value for key, value in record.items() if key != "audio"}
                for record in records]
    payload = json.dumps(portable, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bank-dir", required=True)
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--min-train-clips", type=int, default=20)
    parser.add_argument("--min-holdout-clips", type=int, default=8)
    parser.add_argument("--min-train-episodes", type=int, default=2)
    parser.add_argument("--min-train-seconds", type=float, default=60.0)
    args = parser.parse_args(argv)
    try:
        result = export(
            Path(args.bank_dir).resolve(), Path(args.inventory).resolve(),
            Path(args.out_dir).resolve(), min_train_clips=args.min_train_clips,
            min_holdout_clips=args.min_holdout_clips,
            min_train_episodes=args.min_train_episodes,
            min_train_seconds=args.min_train_seconds,
        )
    except ReadinessError as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False))
        return 2
    print(json.dumps({"ok": True, **result}, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
