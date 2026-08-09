#!/usr/bin/env python3
"""Cut approved local audio anchors into deterministic 16 kHz mono WAVs.

This tool is deliberately a local-only boundary: it never resolves URLs or
downloads media.  An anchor may refer to a file only through an inventory
entry with an existing ``media_path``.  Planning is the default; ``--execute``
is required before any output is written.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse


ALLOWED_LABELS = {"seed", "accept"}
_CANONICAL_RIGHTS = {"download", "training", "research_extraction", "redistribution"}
_VERDICTS = {"accept", "reject", "review", "pending"}


class CutError(ValueError):
    """Raised when an inventory or anchor violates the cut contract."""


@dataclass(frozen=True)
class Source:
    source_id: str
    media_path: Path | None
    training_allowed: bool
    research_extraction_allowed: bool
    record: dict[str, Any]


@dataclass(frozen=True)
class Anchor:
    anchor_id: str
    source_id: str
    label: str
    start_s: float
    end_s: float
    verdict: str
    seed_only: bool
    uncertain: bool
    speaker: str
    confidence: float
    record: dict[str, Any]


def _records(value: Any, keys: tuple[str, ...], what: str) -> list[dict[str, Any]]:
    if isinstance(value, list):
        rows = value
    elif isinstance(value, dict):
        rows = None
        for key in keys:
            if isinstance(value.get(key), list):
                rows = value[key]
                break
        if rows is None:
            # A single record is useful for tiny manifests and unambiguous.
            rows = [value]
    else:
        raise CutError(f"{what} must be a JSON list or object containing records")
    if not all(isinstance(row, dict) for row in rows):
        raise CutError(f"{what} records must be JSON objects")
    return rows


def _required_string(row: dict[str, Any], key: str, what: str) -> str:
    value = row.get(key)
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise CutError(f"{what} is missing a non-empty {key}")


def _is_local_path(raw: str) -> bool:
    parsed = urlparse(raw)
    return not parsed.scheme and not raw.startswith("//")


def load_inventory(path: str | Path, local_overlay: str | Path | None = None) -> dict[str, Source]:
    path = Path(path).expanduser().resolve()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise CutError(f"cannot read inventory: {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise CutError(f"invalid inventory JSON: {path}: {exc}") from exc

    rows = _records(data, ("items", "inventory", "sources", "media"), "inventory")
    if local_overlay is not None:
        overlay_path = Path(local_overlay).expanduser().resolve()
        try:
            overlay_data = json.loads(overlay_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise CutError(f"invalid local overlay: {overlay_path}: {exc}") from exc
        overlay_rows = _records(overlay_data, ("sources", "items", "media"), "local overlay")
        overlay: dict[str, dict[str, str]] = {}
        for item in overlay_rows:
            source_id = _required_string(item, "source_id", "local overlay source")
            raw_media = item.get("media_path")
            if not isinstance(raw_media, str) or not raw_media.strip() or not _is_local_path(raw_media.strip()):
                raise CutError(f"local overlay source {source_id!r} media_path must be local")
            if source_id in overlay:
                raise CutError(f"duplicate local overlay source: {source_id}")
            media = Path(raw_media.strip()).expanduser()
            if not media.is_absolute():
                media = overlay_path.parent / media
            source_sha256 = item.get("source_sha256")
            if source_sha256 is not None and (
                not isinstance(source_sha256, str)
                or not re.fullmatch(r"[0-9a-fA-F]{64}", source_sha256)
            ):
                raise CutError(
                    f"local overlay source {source_id!r} source_sha256 must be a 64-character hex digest"
                )
            overlay[source_id] = {
                "media_path": str(media.resolve()),
                **({"source_sha256": source_sha256} if source_sha256 is not None else {}),
            }
        known_ids = {_required_string(row, "source_id", "inventory source") for row in rows}
        unknown = set(overlay) - known_ids
        if unknown:
            raise CutError(f"local overlay references unknown source: {', '.join(sorted(unknown))}")
        merged_rows = []
        for row in rows:
            source_id = _required_string(row, "source_id", "inventory source")
            patch = overlay.get(source_id)
            if patch is None:
                merged_rows.append(row)
                continue
            canonical_hash = row.get("source_sha256")
            overlay_hash = patch.get("source_sha256")
            if canonical_hash is not None and (
                not isinstance(canonical_hash, str)
                or not re.fullmatch(r"[0-9a-fA-F]{64}", canonical_hash)
            ):
                raise CutError(
                    f"inventory source {source_id!r} source_sha256 must be a 64-character hex digest"
                )
            if canonical_hash is not None and overlay_hash is not None:
                if canonical_hash.lower() != overlay_hash.lower():
                    raise CutError(
                        f"local overlay source {source_id!r} source_sha256 conflicts with canonical inventory"
                    )
            merged = {**row, "media_path": patch["media_path"]}
            # An overlay can complete a metadata-only source, but cannot
            # replace an already declared canonical provenance hash.
            if canonical_hash is None and overlay_hash is not None:
                merged["source_sha256"] = overlay_hash
            merged_rows.append(merged)
        rows = merged_rows

    root_rights = data.get("policy", {}).get("rights", {}) if isinstance(data, dict) else {}
    if not isinstance(root_rights, dict):
        raise CutError("inventory policy.rights must be an object")
    _validate_rights(root_rights, "inventory.policy.rights")
    sources: dict[str, Source] = {}
    for row in rows:
        source_id = _required_string(row, "source_id", "inventory source")
        raw_media = row.get("media_path")
        media_path = None
        if raw_media is not None:
            if not isinstance(raw_media, str) or not raw_media.strip():
                raise CutError(f"inventory source {source_id!r} media_path must be a string")
            raw_media = raw_media.strip()
            if _is_local_path(raw_media):
                media_path = Path(raw_media).expanduser()
                if not media_path.is_absolute():
                    media_path = path.parent / media_path
                media_path = media_path.resolve()
            else:
                # Metadata-only sources may be incomplete.  A referenced
                # remote path is rejected later by plan_cuts.
                media_path = None
        rights = dict(root_rights)
        row_rights = row.get("rights")
        if row_rights is not None:
            if not isinstance(row_rights, dict):
                raise CutError(f"inventory source {source_id!r} rights must be an object")
            rights.update(row_rights)
        _validate_rights(rights, f"inventory source {source_id!r} rights")
        training_allowed = rights["training"] == "allow"
        research_allowed = rights["research_extraction"] == "allow"
        if source_id in sources:
            raise CutError(f"duplicate inventory source: {source_id}")
        if "training_allowed" in row:
            raise CutError("training_allowed is not canonical; use rights.training allow|deny")
        sources[source_id] = Source(source_id, media_path, training_allowed, research_allowed, row)
    if not sources:
        raise CutError("inventory contains no sources")
    return sources


def _number(row: dict[str, Any], keys: tuple[str, ...], what: str) -> float:
    for key in keys:
        if key in row:
            try:
                value = float(row[key])
            except (TypeError, ValueError) as exc:
                raise CutError(f"{what} must be numeric") from exc
            if not math.isfinite(value):
                raise CutError(f"{what} must be finite")
            return value
    raise CutError(f"anchor is missing {what}")


def _validate_rights(rights: dict[str, Any], what: str) -> None:
    unknown = set(rights) - _CANONICAL_RIGHTS
    if unknown:
        raise CutError(f"{what} has non-canonical rights: {', '.join(sorted(unknown))}")
    for key in _CANONICAL_RIGHTS:
        value = rights.get(key, "deny")
        if not isinstance(value, str) or value not in {"allow", "deny"}:
            raise CutError(f"{what}.{key} must be canonical allow or deny")
        rights.setdefault(key, value)


def load_anchors(path: str | Path) -> list[Anchor]:
    path = Path(path).expanduser().resolve()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise CutError(f"cannot read anchors: {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise CutError(f"invalid anchors JSON: {path}: {exc}") from exc

    target_speaker = data.get("target_speaker") if isinstance(data, dict) else None
    if target_speaker is not None and (not isinstance(target_speaker, str) or not target_speaker.strip()):
        raise CutError("anchors target_speaker must be a non-empty string")
    raw_rows = _records(data, ("anchors", "items"), "anchors")
    try:
        try:
            from tools.voice.build_segment_manifest import normalize_anchors
        except ImportError:
            sys.path.insert(0, str(Path(__file__).resolve().parent))
            from build_segment_manifest import normalize_anchors
        normalize_anchors({"anchors": raw_rows})
    except Exception as exc:
        if isinstance(exc, CutError):
            raise
        raise CutError(f"canonical anchor validation failed: {exc}") from exc

    anchors: list[Anchor] = []
    seen: set[tuple[str, str]] = set()
    for row in raw_rows:
        noncanonical = {"status", "kind", "type", "decision", "start", "end", "from", "to"} & set(row)
        if noncanonical:
            raise CutError(f"anchor contains non-canonical fields: {', '.join(sorted(noncanonical))}")
        anchor_id = _required_string(row, "anchor_id", "anchor")
        source_id = _required_string(row, "source_id", f"anchor {anchor_id}")
        verdict = _required_string(row, "verdict", f"anchor {anchor_id}").lower()
        if verdict not in _VERDICTS:
            raise CutError(f"anchor {anchor_id!r} has unsupported verdict {verdict!r}")
        seed_only = row.get("seed_only", False)
        uncertain = row.get("uncertain", False)
        if not isinstance(seed_only, bool) or not isinstance(uncertain, bool):
            raise CutError(f"anchor {anchor_id!r} seed_only/uncertain must be boolean")
        speaker = _required_string(row, "speaker", f"anchor {anchor_id}")
        if target_speaker is not None and speaker != target_speaker.strip():
            raise CutError(f"anchor {anchor_id!r} speaker conflicts with target_speaker")
        confidence_value = row.get("confidence")
        if isinstance(confidence_value, bool) or not isinstance(confidence_value, (int, float)):
            raise CutError(f"anchor {anchor_id!r} confidence must be a finite number")
        confidence = float(confidence_value)
        if not math.isfinite(confidence) or not 0 <= confidence <= 1:
            raise CutError(f"anchor {anchor_id!r} confidence must be between 0 and 1")
        start_s = _number(row, ("start_s",), f"anchor {anchor_id} start")
        end_s = _number(row, ("end_s",), f"anchor {anchor_id} end")
        if "label" in row:
            label_value = row["label"]
            expected = "seed" if seed_only else "accept" if verdict == "accept" else None
            if label_value not in ALLOWED_LABELS or expected != label_value:
                raise CutError(f"anchor {anchor_id!r} label conflicts with canonical verdict/seed_only")
        if verdict != "accept":
            raise CutError(f"anchor {anchor_id!r} verdict must be accept for a cut")
        if uncertain:
            raise CutError(f"anchor {anchor_id!r} is uncertain and cannot be cut")
        label = "seed" if seed_only else "accept"
        if start_s < 0 or end_s <= start_s:
            raise CutError(f"anchor {anchor_id!r} has invalid time range: {start_s}..{end_s}")
        key = (source_id, anchor_id)
        if key in seen:
            raise CutError(f"duplicate anchor: {source_id}/{anchor_id}")
        seen.add(key)
        anchors.append(Anchor(anchor_id, source_id, label, start_s, end_s, verdict,
                              seed_only, uncertain, speaker, confidence, row))
    if not anchors:
        raise CutError("anchors contains no anchors")
    return anchors


def _probe_duration(path: Path) -> float:
    command = [
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path),
    ]
    try:
        result = subprocess.run(command, check=True, capture_output=True, text=True)
        return float(result.stdout.strip())
    except (OSError, subprocess.CalledProcessError, ValueError) as exc:
        raise CutError(f"cannot probe local media duration: {path}") from exc


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _slug(value: str) -> str:
    result = re.sub(r"[^A-Za-z0-9._-]+", "_", value).strip("._")
    return result or hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def stable_stem(source_id: str, anchor_id: str) -> str:
    return f"{_slug(source_id)}__{_slug(anchor_id)}"


def plan_cuts(inventory: dict[str, Source], anchors: list[Anchor], out_dir: str | Path) -> list[dict[str, Any]]:
    out_dir = Path(out_dir).expanduser().resolve()
    plans: list[dict[str, Any]] = []
    output_names: set[str] = set()
    durations: dict[Path, float] = {}
    for anchor in anchors:
        source = inventory.get(anchor.source_id)
        if source is None:
            raise CutError(f"anchor {anchor.anchor_id!r} references unknown source {anchor.source_id!r}")
        if source.media_path is None or not source.media_path.is_file():
            raise CutError(
                f"anchor {anchor.anchor_id!r} source {source.source_id!r} has no existing local media_path"
            )
        if not source.research_extraction_allowed:
            raise CutError(
                f"anchor {anchor.anchor_id!r} cannot be cut: source {source.source_id!r} "
                "has rights.research_extraction=deny"
            )
        expected_hash = source.record.get("source_sha256")
        if expected_hash is not None:
            if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", expected_hash):
                raise CutError(f"source {source.source_id!r} source_sha256 must be a 64-character hex digest")
            actual_hash = _sha256(source.media_path)
            if actual_hash.lower() != expected_hash.lower():
                raise CutError(f"source {source.source_id!r} source_sha256 does not match local media")
        if source.media_path not in durations:
            durations[source.media_path] = _probe_duration(source.media_path)
        duration = durations[source.media_path]
        if anchor.end_s > duration + 1e-6:
            raise CutError(
                f"anchor {anchor.anchor_id!r} is out of bounds ({anchor.end_s:.3f}s > "
                f"media duration {duration:.3f}s)"
            )
        stem = stable_stem(anchor.source_id, anchor.anchor_id)
        if stem in output_names:
            raise CutError(f"output filename collision for {anchor.source_id}/{anchor.anchor_id}")
        output_names.add(stem)
        output = out_dir / f"{stem}.wav"
        sidecar = out_dir / f"{stem}.json"
        ffmpeg = [
            "ffmpeg", "-nostdin", "-y", "-v", "error", "-ss", f"{anchor.start_s:.3f}",
            "-t", f"{anchor.end_s - anchor.start_s:.3f}", "-i", str(source.media_path),
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", str(output),
        ]
        plans.append({
            "source": anchor.source_id,
            "anchor": anchor.anchor_id,
            "label": anchor.label,
            "verdict": anchor.verdict,
            "seed_only": anchor.seed_only,
            "uncertain": anchor.uncertain,
            "speaker": anchor.speaker,
            "confidence": anchor.confidence,
            "start_s": anchor.start_s,
            "end_s": anchor.end_s,
            "duration_s": anchor.end_s - anchor.start_s,
            "input": source.media_path,
            "output": output,
            "sidecar": sidecar,
            "ffmpeg": ffmpeg,
            # Extraction and training approval are deliberately separate.  Only
            # build_segment_manifest may promote a clip into a training manifest.
            "training_eligible": False,
            "training_gate_required": True,
            "source_training_allowed": source.training_allowed,
            "source_research_extraction_allowed": source.research_extraction_allowed,
            "input_hash": _sha256(source.media_path),
        })
    return plans


def _canonical_training_flags(plan: dict[str, Any]) -> tuple[bool, bool]:
    """Validate the generated plan's non-promoted training contract.

    Cutting an extraction never grants training approval.  The values are
    nevertheless carried in the plan and sidecar so a caller cannot mutate a
    plan between planning and execution to smuggle in a training grant.
    """
    for key in ("source_training_allowed", "source_research_extraction_allowed"):
        if not isinstance(plan.get(key), bool):
            raise CutError(f"invalid training flags for {plan.get('source')}/{plan.get('anchor')}")
    expected = (False, True)
    actual = (plan.get("training_eligible"), plan.get("training_gate_required"))
    if actual != expected:
        raise CutError(f"mutated training flags for {plan.get('source')}/{plan.get('anchor')}")
    return expected


def _replace_pair(
    wav_tmp: str,
    sidecar_tmp: str,
    output: Path,
    sidecar: Path,
) -> None:
    """Install the WAV and sidecar, restoring the previous pair on failure."""
    backups: dict[Path, Path | None] = {}
    try:
        for final in (output, sidecar):
            if not final.exists():
                backups[final] = None
                continue
            fd, backup_name = tempfile.mkstemp(
                prefix=f".{final.stem}.", suffix=".rollback", dir=final.parent
            )
            os.close(fd)
            backup = Path(backup_name)
            try:
                backup.unlink()
                os.replace(final, backup)
            except OSError:
                backup.unlink(missing_ok=True)
                raise
            backups[final] = backup

        os.replace(wav_tmp, output)
        os.replace(sidecar_tmp, sidecar)
    except OSError as exc:
        # Remove whichever new final was installed, then restore each old
        # member.  This also handles a first-run failure with no old pair.
        for final in (output, sidecar):
            try:
                final.unlink()
            except FileNotFoundError:
                pass
        for final in (output, sidecar):
            backup = backups.get(final)
            if backup is not None and backup.exists():
                os.replace(backup, final)
                backups[final] = None
        raise CutError(f"atomic output pair replace failed: {output.name}") from exc
    finally:
        for backup in backups.values():
            if backup is not None:
                backup.unlink(missing_ok=True)


def _execute_one(plan: dict[str, Any]) -> dict[str, Any]:
    output: Path = plan["output"]
    sidecar: Path = plan["sidecar"]
    output.parent.mkdir(parents=True, exist_ok=True)
    training_eligible, training_gate_required = _canonical_training_flags(plan)
    input_hash = _sha256(plan["input"])
    if plan.get("input_hash") and input_hash != plan["input_hash"]:
        raise CutError(f"input changed after planning for {plan['source']}/{plan['anchor']}")
    wav_tmp = None
    sidecar_tmp = None
    try:
        wav_fd, wav_tmp = tempfile.mkstemp(prefix=f".{output.stem}.", suffix=".tmp.wav", dir=output.parent)
        os.close(wav_fd)
        ffmpeg_command = [*plan["ffmpeg"][:-1], wav_tmp]
        try:
            subprocess.run(ffmpeg_command, check=True, capture_output=True, text=True)
        except (OSError, subprocess.CalledProcessError) as exc:
            raise CutError(f"ffmpeg failed for {plan['source']}/{plan['anchor']}") from exc
        if not Path(wav_tmp).is_file():
            raise CutError(f"ffmpeg produced no output for {plan['source']}/{plan['anchor']}")
        output_hash = _sha256(Path(wav_tmp))
        metadata = {
            "source": plan["source"],
            "anchor": plan["anchor"],
            "label": plan["label"],
            "verdict": plan["verdict"],
            "seed_only": plan["seed_only"],
            "uncertain": plan["uncertain"],
            "speaker": plan["speaker"],
            "confidence": plan["confidence"],
            "times": {
                "start_s": round(plan["start_s"], 6),
                "end_s": round(plan["end_s"], 6),
                "duration_s": round(plan["duration_s"], 6),
            },
            "input": str(plan["input"]),
            "output": str(output),
            "input_hash": input_hash,
            "output_hash": output_hash,
            "ffmpeg_command": plan["ffmpeg"],
            "training_eligible": training_eligible,
            "training_gate_required": training_gate_required,
        }
        sidecar_fd, sidecar_tmp = tempfile.mkstemp(
            prefix=f".{sidecar.stem}.", suffix=".json.tmp", dir=sidecar.parent
        )
        with os.fdopen(sidecar_fd, "w", encoding="utf-8") as handle:
            json.dump(metadata, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        _replace_pair(wav_tmp, sidecar_tmp, output, sidecar)
        wav_tmp = None
        sidecar_tmp = None
        return metadata
    finally:
        for temp_path in (wav_tmp, sidecar_tmp):
            if temp_path:
                try:
                    os.unlink(temp_path)
                except FileNotFoundError:
                    pass


def execute_plan(plans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [_execute_one(plan) for plan in plans]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inventory", required=True, help="JSON inventory with canonical source entries")
    parser.add_argument("--anchors", required=True, help="JSON list/object containing seed or accept anchors")
    parser.add_argument("--local-overlay", help="JSON local-only source_id/media_path overlay")
    parser.add_argument("--out-dir", required=True, help="output directory for WAVs and sidecars")
    parser.add_argument("--execute", action="store_true", help="actually invoke ffmpeg and write outputs")
    args = parser.parse_args(argv)
    try:
        plans = plan_cuts(load_inventory(args.inventory, args.local_overlay), load_anchors(args.anchors), args.out_dir)
        if not args.execute:
            for plan in plans:
                print(json.dumps({
                    "dry_run": True,
                    "source": plan["source"], "anchor": plan["anchor"], "label": plan["label"],
                    "times": {"start_s": plan["start_s"], "end_s": plan["end_s"]},
                    "output": str(plan["output"]), "training_eligible": plan["training_eligible"],
                    "training_gate_required": plan["training_gate_required"],
                    "ffmpeg_command": plan["ffmpeg"],
                }, ensure_ascii=False))
            return 0
        for result in execute_plan(plans):
            print(json.dumps(result, ensure_ascii=False))
        return 0
    except CutError as exc:
        print(f"cut_anchors: error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
