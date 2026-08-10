#!/usr/bin/env python3
"""Fail-closed readiness report for a reviewed Xibao voice training corpus."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import wave
from collections import defaultdict
from pathlib import Path
from typing import Any


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as handle:
        return handle.getnframes() / handle.getframerate()


def _candidate(document: dict[str, Any]) -> dict[str, Any]:
    value = document.get("candidate")
    return value if isinstance(value, dict) else document


def _source_id(document: dict[str, Any]) -> str | None:
    candidate = _candidate(document)
    value = document.get("source_id") or candidate.get("source_id") or candidate.get("source")
    return value if isinstance(value, str) and value else None


def _verified_text(document: dict[str, Any]) -> str | None:
    candidate = _candidate(document)
    value = (document.get("transcript_ja_verified") or
             candidate.get("transcript_ja_verified"))
    return value.strip() if isinstance(value, str) and value.strip() else None


def read_positive_bank(bank_dir: Path) -> tuple[list[dict[str, Any]], list[str]]:
    records = []
    issues = []
    positive_dir = bank_dir / "positive"
    if not positive_dir.is_dir():
        return [], ["positive bank directory is missing"]
    seen_hashes: set[str] = set()
    for audio_path in sorted(positive_dir.glob("*.wav")):
        sidecar_path = audio_path.with_suffix(".json")
        if not sidecar_path.is_file():
            issues.append(f"{audio_path.name}: sidecar is missing")
            continue
        try:
            document = json.loads(sidecar_path.read_text(encoding="utf-8"))
            duration = wav_duration(audio_path)
        except (json.JSONDecodeError, OSError, wave.Error) as error:
            issues.append(f"{audio_path.name}: unreadable artifact ({error})")
            continue
        source_id = _source_id(document)
        review = document.get("review") if isinstance(document.get("review"), dict) else {}
        answers = review.get("answers") if isinstance(review.get("answers"), dict) else {}
        actual_hash = sha256_file(audio_path)
        candidate = _candidate(document)
        expected_hash = document.get("audio_sha256") or candidate.get("audio_sha256")
        record_issues = []
        if source_id is None:
            record_issues.append("source provenance is missing")
        if answers.get("verdict") != "target" or answers.get("overlap") is not False:
            record_issues.append("review is not a clean target verdict")
        if answers.get("confidence", 0) < 3:
            record_issues.append("review confidence is below 3")
        if expected_hash != actual_hash:
            record_issues.append("audio hash is missing or mismatched")
        if actual_hash in seen_hashes:
            record_issues.append("audio content is duplicated")
        if not 2.0 <= duration <= 7.0:
            record_issues.append("duration is outside 2..7 seconds")
        seen_hashes.add(actual_hash)
        if record_issues:
            issues.extend(f"{audio_path.name}: {reason}" for reason in record_issues)
        records.append({
            "audio": str(audio_path.resolve()),
            "audio_sha256": actual_hash,
            "duration_s": round(duration, 3),
            "source_id": source_id,
            "transcript_ja_verified": _verified_text(document),
            "valid": not record_issues,
        })
    return records, issues


def inventory_sources(inventory_path: Path) -> dict[str, dict[str, Any]]:
    document = json.loads(inventory_path.read_text(encoding="utf-8"))
    sources = document.get("sources") if isinstance(document, dict) else None
    if not isinstance(sources, list):
        raise ValueError("inventory.sources must be an array")
    return {
        item["source_id"]: item for item in sources
        if isinstance(item, dict) and isinstance(item.get("source_id"), str)
    }


def choose_episode_holdout(records: list[dict[str, Any]], *, min_train_clips: int,
                           min_holdout_clips: int, min_train_episodes: int) -> str | None:
    """Hold out the *smallest* episode that still satisfies the minimum.

    This used to take the largest, which quietly spent the best source on
    validation: once EP17 contributed 30 of the 50 clips it became the holdout,
    and the training set stayed at the 59.5 s it had before that episode was cut
    at all. Holding out the least that qualifies leaves everything else to train
    on, without relaxing either minimum.
    """
    by_source: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for record in records:
        if record["valid"] and record["source_id"]:
            by_source[record["source_id"]].append(record)
    choices = []
    for source_id, holdout in by_source.items():
        train_sources = {record["source_id"] for record in records
                         if record["valid"] and record["source_id"] != source_id}
        train_count = sum(len(items) for key, items in by_source.items() if key != source_id)
        if (len(holdout) >= min_holdout_clips and train_count >= min_train_clips and
                len(train_sources) >= min_train_episodes):
            choices.append((len(holdout), source_id))
    return min(choices)[1] if choices else None


def assess(bank_dir: Path, inventory_path: Path, *, min_train_clips: int = 20,
           min_holdout_clips: int = 8, min_train_episodes: int = 2,
           min_train_seconds: float = 60.0) -> dict[str, Any]:
    records, artifact_issues = read_positive_bank(bank_dir)
    sources = inventory_sources(inventory_path)
    holdout_source = choose_episode_holdout(
        records, min_train_clips=min_train_clips,
        min_holdout_clips=min_holdout_clips, min_train_episodes=min_train_episodes,
    )
    valid = [record for record in records if record["valid"]]
    train = [record for record in valid if record["source_id"] != holdout_source]
    holdout = [record for record in valid if record["source_id"] == holdout_source]
    train_sources = sorted({record["source_id"] for record in train if record["source_id"]})
    all_sources = sorted({record["source_id"] for record in valid if record["source_id"]})
    train_seconds = round(sum(record["duration_s"] for record in train), 3)
    verified_transcripts = sum(record["transcript_ja_verified"] is not None for record in train)
    rights = {}
    for source_id in all_sources:
        source = sources.get(source_id, {})
        value = source.get("rights") if isinstance(source.get("rights"), dict) else {}
        rights[source_id] = {
            "research_extraction": value.get("research_extraction", "deny"),
            "training": value.get("training", "deny"),
        }
    gates = {
        "artifact_integrity": {"passed": not artifact_issues, "issues": artifact_issues},
        "episode_disjoint_holdout": {
            "passed": holdout_source is not None,
            "holdout_source": holdout_source,
            "actual_holdout_clips": len(holdout),
            "minimum_holdout_clips": min_holdout_clips,
        },
        "training_clips": {
            "passed": len(train) >= min_train_clips,
            "actual": len(train), "minimum": min_train_clips,
        },
        "training_episodes": {
            "passed": len(train_sources) >= min_train_episodes,
            "actual": len(train_sources), "minimum": min_train_episodes,
        },
        "training_duration": {
            "passed": train_seconds >= min_train_seconds,
            "actual_seconds": train_seconds, "minimum_seconds": min_train_seconds,
        },
        "verified_japanese_transcripts": {
            "passed": bool(train) and verified_transcripts == len(train),
            "actual": verified_transcripts, "required": len(train),
        },
        "source_rights": {
            "passed": bool(train_sources) and all(
                rights[source_id]["research_extraction"] == "allow" and
                rights[source_id]["training"] == "allow"
                for source_id in train_sources
            ),
            "sources": rights,
        },
    }
    failed = [name for name, gate in gates.items() if not gate["passed"]]
    return {
        "schema_version": "pilotfish.training_readiness.v1",
        "target_speaker": "西奈津美",
        "engine_plan": "Irodori-TTS-500M-v3 Speaker Inversion",
        "ready_for_training": not failed,
        "failed_gates": failed,
        "counts": {
            "reviewed_positive_clips": len(records),
            "valid_unique_clips": len(valid),
            "source_episodes": len(all_sources),
            "train_clips": len(train),
            "holdout_clips": len(holdout),
            "train_seconds": train_seconds,
        },
        "gates": gates,
    }


def atomic_json(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(document, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bank-dir", required=True)
    parser.add_argument("--inventory", required=True)
    parser.add_argument("--report-out")
    parser.add_argument("--min-train-clips", type=int, default=20)
    parser.add_argument("--min-holdout-clips", type=int, default=8)
    parser.add_argument("--min-train-episodes", type=int, default=2)
    parser.add_argument("--min-train-seconds", type=float, default=60.0)
    args = parser.parse_args(argv)
    report = assess(
        Path(args.bank_dir).resolve(), Path(args.inventory).resolve(),
        min_train_clips=args.min_train_clips,
        min_holdout_clips=args.min_holdout_clips,
        min_train_episodes=args.min_train_episodes,
        min_train_seconds=args.min_train_seconds,
    )
    if args.report_out:
        atomic_json(Path(args.report_out).resolve(), report)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if report["ready_for_training"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
