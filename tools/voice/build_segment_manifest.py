#!/usr/bin/env python3
"""Normalize manually reviewed voice anchors into auditable manifests.

This tool does not download media, run OCR, run a voice model, or infer a
human verdict from machine scores.  It only joins an inventory to anchors and
applies a conservative training gate.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import stat
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


SCHEMA_VERSION = "pilotfish.segment_manifest.v1"
VERDICTS = {"accept", "reject", "review", "pending"}
RIGHTS_VALUES = {"allow", "deny"}
DEFAULT_TARGET_SPEAKER = "西奈津美"
DEFAULT_MIN_CONFIDENCE = 0.85
DEFAULT_RIGHTS = {
    "download": "deny",
    "research_extraction": "deny",
    "training": "deny",
    "redistribution": "deny",
}
SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")


class ValidationError(ValueError):
    """Raised when an input would make provenance or gating ambiguous."""


def _as_mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{label} must be a JSON object")
    return value


def _as_nonempty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{label} must be a non-empty string")
    return value.strip()


def _number(value: Any, label: str, *, minimum: float | None = None) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValidationError(f"{label} must be a finite number")
    value = float(value)
    if not math.isfinite(value) or (minimum is not None and value < minimum):
        raise ValidationError(f"{label} must be a finite number >= {minimum}")
    return value


def _alias(row: dict[str, Any], *names: str) -> Any:
    for name in names:
        if name in row:
            return row[name]
    return None


def _rights(value: Any, label: str) -> dict[str, str]:
    if value is None:
        return dict(DEFAULT_RIGHTS)
    obj = _as_mapping(value, label)
    result = dict(DEFAULT_RIGHTS)
    for key in DEFAULT_RIGHTS:
        if key in obj:
            right = _as_nonempty_string(obj[key], f"{label}.{key}").lower()
            if right not in RIGHTS_VALUES:
                raise ValidationError(f"{label}.{key} must be allow or deny")
            result[key] = right
    return result


def _root_records(raw: Any, key: str, label: str) -> tuple[dict[str, Any], list[Any]]:
    if isinstance(raw, list):
        return {}, raw
    root = _as_mapping(raw, label)
    rows = root.get(key)
    if not isinstance(rows, list):
        raise ValidationError(f"{label}.{key} must be a JSON array")
    return root, rows


def normalize_inventory(raw: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    root, rows = _root_records(raw, "sources", "inventory")
    if not rows:
        raise ValidationError("inventory.sources must not be empty")
    root_rights = _rights(root.get("policy", {}).get("rights") if isinstance(root.get("policy"), dict) else None,
                           "inventory.policy.rights")
    sources = []
    seen: set[str] = set()
    for index, row in enumerate(rows):
        item = _as_mapping(row, f"inventory.sources[{index}]")
        source_id = _as_nonempty_string(_alias(item, "source_id", "video_id", "id"),
                                        f"inventory.sources[{index}].source_id")
        if source_id in seen:
            raise ValidationError(f"duplicate source_id: {source_id}")
        seen.add(source_id)
        duration_value = _alias(item, "duration_s", "duration")
        duration_s = None if duration_value is None else _number(
            duration_value, f"inventory.sources[{index}].duration_s", minimum=0
        )
        media_path = _alias(item, "media_path", "audio_path")
        if isinstance(media_path, str):
            media_path = media_path.strip()
        source_sha256 = item.get("source_sha256")
        if isinstance(source_sha256, str):
            source_sha256 = source_sha256.strip()
        source_rights = (
            dict(root_rights)
            if item.get("rights") is None
            else _rights(item.get("rights"), f"inventory.sources[{index}].rights")
        )
        sources.append({
            "source_id": source_id,
            "season": item.get("season"),
            "episode": item.get("episode"),
            "platform": item.get("platform"),
            "url": _alias(item, "url", "source_url"),
            "media_path": media_path,
            "duration_s": duration_s,
            "title": item.get("title"),
            "locator_status": item.get("locator_status"),
            "source_sha256": source_sha256,
            "rights": source_rights,
            "inventory_index": index,
        })
    return root, sources


def normalize_anchors(raw: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    root, rows = _root_records(raw, "anchors", "anchors")
    if not rows:
        raise ValidationError("anchors.anchors must not be empty")
    anchors = []
    seen_ids: set[str] = set()
    seen_spans: set[tuple[str, float, float, str]] = set()
    for index, row in enumerate(rows):
        item = _as_mapping(row, f"anchors.anchors[{index}]")
        anchor_id = _as_nonempty_string(_alias(item, "anchor_id", "id"),
                                        f"anchors.anchors[{index}].anchor_id")
        if anchor_id in seen_ids:
            raise ValidationError(f"duplicate anchor_id: {anchor_id}")
        seen_ids.add(anchor_id)
        source_id = _as_nonempty_string(_alias(item, "source_id", "video_id"),
                                        f"anchors.anchors[{index}].source_id")
        start_s = _number(_alias(item, "start_s", "start"),
                          f"anchors.anchors[{index}].start_s", minimum=0)
        end_s = _number(_alias(item, "end_s", "end"),
                        f"anchors.anchors[{index}].end_s", minimum=0)
        if end_s <= start_s:
            raise ValidationError(f"anchors.anchors[{index}] end_s must be greater than start_s")
        speaker = _as_nonempty_string(item.get("speaker"), f"anchors.anchors[{index}].speaker")
        verdict = _as_nonempty_string(item.get("verdict"), f"anchors.anchors[{index}].verdict").lower()
        if verdict not in VERDICTS:
            raise ValidationError(f"anchors.anchors[{index}].verdict must be one of {sorted(VERDICTS)}")
        confidence = item.get("confidence")
        if confidence is not None:
            confidence = _number(confidence, f"anchors.anchors[{index}].confidence", minimum=0)
            if confidence > 1:
                raise ValidationError(f"anchors.anchors[{index}].confidence must be <= 1")
        uncertain = item.get("uncertain", False)
        seed_only = item.get("seed_only", False)
        for key, value in (("uncertain", uncertain), ("seed_only", seed_only)):
            if not isinstance(value, bool):
                raise ValidationError(f"anchors.anchors[{index}].{key} must be boolean")
        span_key = (source_id, start_s, end_s, speaker)
        if span_key in seen_spans:
            raise ValidationError(f"duplicate anchor span: {source_id} {start_s}-{end_s}")
        seen_spans.add(span_key)
        evidence = item.get("evidence", {})
        if not isinstance(evidence, dict):
            raise ValidationError(f"anchors.anchors[{index}].evidence must be an object")
        anchors.append({
            "anchor_id": anchor_id,
            "source_id": source_id,
            "start_s": start_s,
            "end_s": end_s,
            "speaker": speaker,
            "text": item.get("text"),
            "emotion": item.get("emotion"),
            "confidence": confidence,
            "verdict": verdict,
            "reviewer": item.get("reviewer"),
            "reviewed_at": item.get("reviewed_at"),
            "transcript_ja_verified": item.get("transcript_ja_verified"),
            "uncertain": uncertain,
            "seed_only": seed_only,
            "evidence": evidence,
            "notes": item.get("notes"),
            "anchor_index": index,
        })
    return root, anchors


def sha256_file(path: str | os.PathLike[str]) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _source_provenance(source: dict[str, Any], inventory_digest: str) -> dict[str, Any]:
    media_path = source.get("_resolved_media_path", source["media_path"])
    return {
        "source_id": source["source_id"],
        "season": source["season"],
        "episode": source["episode"],
        "platform": source["platform"],
        "url": source["url"],
        "media_path": media_path,
        "duration_s": source["duration_s"],
        "source_sha256": source.get("source_sha256"),
        "source_sha256_actual": source.get("_actual_sha256"),
        "inventory_index": source["inventory_index"],
        "inventory_sha256": inventory_digest,
        "rights": source["rights"],
    }


def _drop_nulls(value: Any) -> Any:
    """Remove optional null fields from the formal training manifest."""
    if isinstance(value, dict):
        return {key: _drop_nulls(item) for key, item in value.items() if item is not None}
    if isinstance(value, list):
        return [_drop_nulls(item) for item in value]
    return value


def _generation_id(inventory_digest: str, anchors_digest: str, policy: dict[str, Any]) -> str:
    payload = {
        "schema_version": SCHEMA_VERSION,
        "inventory_sha256": inventory_digest,
        "anchors_sha256": anchors_digest,
        "policy": policy,
    }
    encoded = json.dumps(
        payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _media_probe(
    source: dict[str, Any],
    *,
    inventory_path: str | None,
) -> list[str]:
    """Resolve and inspect one source without changing its original locator."""
    raw = source.get("media_path")
    if not isinstance(raw, str) or not raw.strip():
        return ["source.media_path_missing"]
    raw = raw.strip()
    parsed = urlparse(raw)
    if parsed.scheme or raw.startswith("//"):
        return ["source.media_path_remote"]
    base = Path(inventory_path).expanduser().resolve().parent if inventory_path else Path.cwd()
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = base / path
    path = path.resolve(strict=False)
    source["_resolved_media_path"] = str(path)
    if not path.exists():
        return ["source.media_path_not_found"]
    try:
        mode = path.stat().st_mode
    except OSError:
        return ["source.media_path_unreadable"]
    if not stat.S_ISREG(mode):
        return ["source.media_path_not_regular_file"]
    try:
        actual = sha256_file(path)
    except OSError:
        return ["source.media_path_unreadable"]
    source["_actual_sha256"] = actual
    expected = source.get("source_sha256")
    if isinstance(expected, str) and SHA256_RE.fullmatch(expected.strip()) and actual != expected.strip().lower():
        return ["source.source_sha256_mismatch"]
    return []


def build_manifests(
    sources: list[dict[str, Any]],
    anchors: list[dict[str, Any]],
    *,
    target_speaker: str,
    min_confidence: float,
    inventory_digest: str,
    anchors_digest: str,
    inventory_path: str | None = None,
    anchors_path: str | None = None,
    generated_at: str | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    target_speaker = _as_nonempty_string(target_speaker, "target_speaker")
    min_confidence = _number(min_confidence, "min_confidence", minimum=0)
    if min_confidence > 1:
        raise ValidationError("min_confidence must be <= 1")
    source_by_id = {source["source_id"]: source for source in sources}
    source_gate_reasons = {
        source["source_id"]: _media_probe(source, inventory_path=inventory_path)
        for source in sources
    }
    candidates = []
    for anchor in anchors:
        source = source_by_id.get(anchor["source_id"])
        if source is None:
            raise ValidationError(f"anchor references unknown source_id: {anchor['source_id']}")
        duration_s = source["duration_s"]
        if duration_s is not None and anchor["end_s"] > duration_s:
            raise ValidationError(
                f"anchor {anchor['anchor_id']} ends at {anchor['end_s']} beyond "
                f"source duration {duration_s}"
            )
        reasons = list(source_gate_reasons[anchor["source_id"]])
        source_sha256 = source.get("source_sha256")
        if source_sha256 is None or source_sha256 == "":
            reasons.append("source.source_sha256_missing")
        elif not isinstance(source_sha256, str) or not SHA256_RE.fullmatch(source_sha256.strip()):
            reasons.append("source.source_sha256_invalid")
        if anchor["seed_only"]:
            reasons.append("seed_only")
        if source["rights"]["training"] != "allow":
            reasons.append("rights.training_denied")
        if source["rights"]["research_extraction"] != "allow":
            reasons.append("rights.research_extraction_denied")
        if anchor["verdict"] != "accept":
            reasons.append("verdict_not_accept")
        if anchor["confidence"] is None:
            reasons.append("confidence_missing")
        elif anchor["confidence"] < min_confidence:
            reasons.append("confidence_below_threshold")
        if anchor["speaker"] != target_speaker:
            reasons.append("speaker_mismatch")
        if anchor["uncertain"]:
            reasons.append("uncertain")
        reviewer = anchor.get("reviewer")
        if not isinstance(reviewer, str) or not reviewer.strip():
            reasons.append("reviewer_missing")
        reviewed_at = anchor.get("reviewed_at")
        if not isinstance(reviewed_at, str) or not reviewed_at.strip():
            reasons.append("reviewed_at_missing")
        transcript = anchor.get("transcript_ja_verified")
        if not isinstance(transcript, str) or not transcript.strip():
            reasons.append("transcript_ja_verified_missing")
        emotion = anchor.get("emotion")
        if not isinstance(emotion, str) or not emotion.strip():
            reasons.append("emotion_missing")
        elif emotion.strip().lower() == "unknown":
            reasons.append("emotion_unknown")
        candidate_id = f"{anchor['source_id']}:{anchor['anchor_id']}"
        candidate = {
            "segment_id": candidate_id,
            "source_id": anchor["source_id"],
            "start_s": anchor["start_s"],
            "end_s": anchor["end_s"],
            "duration_s": round(anchor["end_s"] - anchor["start_s"], 6),
            "speaker": anchor["speaker"],
            "text": anchor["text"],
            "transcript_ja_verified": anchor["transcript_ja_verified"],
            "emotion": anchor["emotion"],
            "confidence": anchor["confidence"],
            "human_verdict": anchor["verdict"],
            "reviewer": anchor["reviewer"],
            "reviewed_at": anchor["reviewed_at"],
            "uncertain": anchor["uncertain"],
            "seed_only": anchor["seed_only"],
            "eligible_for_training": not reasons,
            "excluded_reasons": reasons,
            "evidence": anchor["evidence"],
            "notes": anchor["notes"],
            "provenance": {
                "anchor_id": anchor["anchor_id"],
                "anchor_index": anchor["anchor_index"],
                "anchors_sha256": anchors_digest,
                "inventory": _source_provenance(source, inventory_digest),
            },
        }
        candidates.append(candidate)
    stamp = generated_at or datetime.now(timezone.utc).isoformat()
    policy = {
        "min_confidence": min_confidence,
        "training_requires": [
            "human_verdict == accept",
            "confidence >= min_confidence",
            "speaker == target_speaker",
            "uncertain == false",
            "seed_only == false",
            "source.rights.training == allow",
            "source.media_path is non-empty",
            "source.source_sha256 matches 64 hex characters",
            "source actual sha256 matches source_sha256",
            "source.rights.research_extraction == allow",
            "reviewer is non-empty",
            "reviewed_at is non-empty",
            "transcript_ja_verified is non-empty",
            "emotion is non-empty and not unknown",
        ],
    }
    generation_id = _generation_id(inventory_digest, anchors_digest, policy)
    provenance = {
        "inventory_path": inventory_path,
        "inventory_sha256": inventory_digest,
        "anchors_path": anchors_path,
        "anchors_sha256": anchors_digest,
    }
    summary = {
        "total": len(candidates),
        "training_eligible": sum(1 for item in candidates if item["eligible_for_training"]),
        "excluded": sum(1 for item in candidates if not item["eligible_for_training"]),
    }
    candidate_doc = {
        "schema_version": SCHEMA_VERSION,
        "generation_id": generation_id,
        "generated_at": stamp,
        "target_speaker": target_speaker,
        "policy": policy,
        "provenance": provenance,
        "summary": summary,
        "candidates": candidates,
    }
    training_segments = []
    for candidate in candidates:
        if not candidate["eligible_for_training"]:
            continue
        source = source_by_id[candidate["source_id"]]
        training_segments.append(_drop_nulls({
            "segment_id": candidate["segment_id"],
            "source_id": candidate["source_id"],
            "media_path": source["_resolved_media_path"],
            "start_s": candidate["start_s"],
            "end_s": candidate["end_s"],
            "duration_s": candidate["duration_s"],
            "speaker": candidate["speaker"],
            "text": candidate["text"],
            "transcript_ja_verified": candidate["transcript_ja_verified"],
            "emotion": candidate["emotion"],
            "confidence": candidate["confidence"],
            "human_verdict": candidate["human_verdict"],
            "reviewer": candidate["reviewer"],
            "reviewed_at": candidate["reviewed_at"],
            "provenance": candidate["provenance"],
        }))
    manifest = _drop_nulls({
        "schema_version": SCHEMA_VERSION,
        "generation_id": generation_id,
        "manifest_kind": "training",
        "generated_at": stamp,
        "target_speaker": target_speaker,
        "policy": policy,
        "provenance": provenance,
        "summary": {"segments": len(training_segments)},
        "segments": training_segments,
    })
    return candidate_doc, manifest


def _stage_json(path: str | os.PathLike[str], document: dict[str, Any]) -> Path:
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(document, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        return Path(temporary)
    except Exception:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def write_manifests_pair(
    candidates_path: str | os.PathLike[str],
    manifest_path: str | os.PathLike[str],
    candidates: dict[str, Any],
    manifest: dict[str, Any],
) -> None:
    """Stage both documents before replacing either final output."""
    candidates_destination = Path(candidates_path)
    manifest_destination = Path(manifest_path)
    if candidates_destination.resolve() == manifest_destination.resolve():
        raise OSError("candidates and manifest outputs must be different files")
    if candidates.get("generation_id") != manifest.get("generation_id"):
        raise OSError("candidates and manifest generation_id values must match")
    staged: list[tuple[Path, Path]] = []
    try:
        staged.append((_stage_json(candidates_destination, candidates), candidates_destination))
        staged.append((_stage_json(manifest_destination, manifest), manifest_destination))
    except Exception:
        for temporary, _ in staged:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass
        raise
    try:
        for temporary, destination in staged:
            os.replace(temporary, destination)
    finally:
        for temporary, _ in staged:
            try:
                temporary.unlink()
            except FileNotFoundError:
                pass


def _load_file(path: str) -> tuple[Any, str]:
    digest = sha256_file(path)
    with open(path, encoding="utf-8") as handle:
        return json.load(handle), digest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, help="source inventory JSON")
    parser.add_argument("--anchors", required=True, help="human-reviewed anchors JSON")
    parser.add_argument("--candidates-out", required=True, help="normalized candidates JSON")
    parser.add_argument("--manifest-out", required=True, help="training manifest JSON")
    parser.add_argument("--target-speaker", default=DEFAULT_TARGET_SPEAKER)
    parser.add_argument("--min-confidence", type=float, default=DEFAULT_MIN_CONFIDENCE)
    parser.add_argument("--dry-run", action="store_true", help="validate and summarize without writing")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        inventory_raw, inventory_digest = _load_file(args.inventory)
        anchors_raw, anchors_digest = _load_file(args.anchors)
        _, sources = normalize_inventory(inventory_raw)
        _, anchors = normalize_anchors(anchors_raw)
        candidates, manifest = build_manifests(
            sources,
            anchors,
            target_speaker=args.target_speaker,
            min_confidence=args.min_confidence,
            inventory_digest=inventory_digest,
            anchors_digest=anchors_digest,
            inventory_path=os.path.abspath(args.inventory),
            anchors_path=os.path.abspath(args.anchors),
        )
    except (OSError, json.JSONDecodeError, ValidationError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 2
    summary = {
        "dry_run": args.dry_run,
        "generation_id": candidates["generation_id"],
        "sources": len(sources),
        "anchors": len(anchors),
        "candidates": candidates["summary"]["total"],
        "training_eligible": candidates["summary"]["training_eligible"],
        "manifest_segments": manifest["summary"]["segments"],
        "candidates_out": os.path.abspath(args.candidates_out),
        "manifest_out": os.path.abspath(args.manifest_out),
    }
    if not args.dry_run:
        try:
            write_manifests_pair(args.candidates_out, args.manifest_out, candidates, manifest)
        except OSError as exc:
            print(f"[error] could not write output: {exc}", file=sys.stderr)
            return 2
    print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
