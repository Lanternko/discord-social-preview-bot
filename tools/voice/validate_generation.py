#!/usr/bin/env python3
"""Fail-closed identity and audio-quality gate for synthesized voice candidates."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import tempfile
from pathlib import Path
from typing import Any


POLICY = {
    "min_auc": 0.85,
    "max_fpr": 0.05,
    "max_peak_dbfs": -1.0,
    "max_clip_fraction": 0.001,
    "min_rms_dbfs": -35.0,
    "max_rms_dbfs": -12.0,
    "max_silence_ratio": 0.35,
    "min_dnsmos_ovrl": 2.5,
    "min_dnsmos_sig": 3.0,
    "min_dnsmos_bak": 3.0,
    "min_human_reviewers": 2,
}


class QualityGateError(ValueError):
    pass


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise QualityGateError(f"{label} must be an object")
    return value


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise QualityGateError(f"{label} must be a finite number")
    value = float(value)
    if not math.isfinite(value):
        raise QualityGateError(f"{label} must be a finite number")
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def evaluate(report: dict[str, Any]) -> dict[str, Any]:
    report = _object(report, "report")
    reasons: list[str] = []
    audio_path_value = report.get("audio_path")
    expected_hash = report.get("audio_sha256")
    actual_hash = None
    if not isinstance(audio_path_value, str) or not audio_path_value.strip():
        reasons.append("audio_path_missing")
    else:
        path = Path(audio_path_value).expanduser()
        if not path.is_absolute():
            reasons.append("audio_path_not_absolute")
        elif not path.is_file():
            reasons.append("audio_path_not_regular_file")
        else:
            actual_hash = _sha256(path)
    if not isinstance(expected_hash, str) or len(expected_hash) != 64:
        reasons.append("audio_sha256_invalid")
    elif actual_hash is not None and actual_hash != expected_hash.lower():
        reasons.append("audio_sha256_mismatch")

    identity = _object(report.get("identity"), "identity")
    calibrated = identity.get("calibrated")
    if calibrated is not True:
        reasons.append("identity_model_not_calibrated")
    if identity.get("episode_disjoint") is not True:
        reasons.append("identity_calibration_not_episode_disjoint")
    auc = _number(identity.get("auc"), "identity.auc")
    fpr = _number(identity.get("fpr"), "identity.fpr")
    score = _number(identity.get("score"), "identity.score")
    threshold = _number(identity.get("threshold"), "identity.threshold")
    if auc < POLICY["min_auc"]:
        reasons.append("identity_auc_below_minimum")
    if fpr > POLICY["max_fpr"]:
        reasons.append("identity_fpr_above_maximum")
    if score < threshold:
        reasons.append("identity_score_below_threshold")

    audio = _object(report.get("audio_quality"), "audio_quality")
    peak = _number(audio.get("peak_dbfs"), "audio_quality.peak_dbfs")
    clip = _number(audio.get("clip_fraction"), "audio_quality.clip_fraction")
    rms = _number(audio.get("rms_dbfs"), "audio_quality.rms_dbfs")
    silence = _number(audio.get("silence_ratio"), "audio_quality.silence_ratio")
    if peak > POLICY["max_peak_dbfs"]:
        reasons.append("peak_too_high")
    if clip > POLICY["max_clip_fraction"]:
        reasons.append("clipping_detected")
    if not POLICY["min_rms_dbfs"] <= rms <= POLICY["max_rms_dbfs"]:
        reasons.append("rms_out_of_range")
    if silence > POLICY["max_silence_ratio"]:
        reasons.append("silence_ratio_too_high")

    dnsmos = _object(report.get("dnsmos"), "dnsmos")
    for key, minimum in (("ovrl", POLICY["min_dnsmos_ovrl"]),
                         ("sig", POLICY["min_dnsmos_sig"]),
                         ("bak", POLICY["min_dnsmos_bak"])):
        if _number(dnsmos.get(key), f"dnsmos.{key}") < minimum:
            reasons.append(f"dnsmos_{key}_below_minimum")

    reviews = report.get("human_reviews")
    if not isinstance(reviews, list):
        raise QualityGateError("human_reviews must be an array")
    accepted_reviewers: set[str] = set()
    for index, review_value in enumerate(reviews):
        review = _object(review_value, f"human_reviews[{index}]")
        reviewer = review.get("reviewer")
        if not isinstance(reviewer, str) or not reviewer.strip():
            raise QualityGateError(f"human_reviews[{index}].reviewer must be non-empty")
        fields = (review.get("identity") == "target", review.get("natural") is True,
                  review.get("artifacts") is False)
        if all(fields):
            accepted_reviewers.add(reviewer.strip())
        else:
            reasons.append("human_review_rejected")
    if len(accepted_reviewers) < POLICY["min_human_reviewers"]:
        reasons.append("human_reviews_insufficient")

    reasons = list(dict.fromkeys(reasons))
    return {
        "schema_version": "pilotfish.generation_qc.v1",
        "approved_for_use": not reasons,
        "reasons": reasons,
        "audio_path": audio_path_value,
        "audio_sha256": actual_hash,
        "policy": POLICY,
        "disclaimer": "QC approval does not grant publication, redistribution, or impersonation rights.",
    }


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", required=True)
    parser.add_argument("--decision-out", required=True)
    args = parser.parse_args(argv)
    with open(args.report, encoding="utf-8") as handle:
        report = json.load(handle)
    decision = evaluate(report)
    _write_json(Path(args.decision_out), decision)
    print(json.dumps(decision, ensure_ascii=False, sort_keys=True))
    return 0 if decision["approved_for_use"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
