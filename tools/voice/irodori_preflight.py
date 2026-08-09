#!/usr/bin/env python3
"""Run a pinned Irodori zero-shot smoke test and emit structural audio QC."""

from __future__ import annotations

import argparse
import array
import hashlib
import json
import math
import os
import subprocess
import tempfile
import wave
from pathlib import Path


APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = APP_ROOT / "configs" / "voice" / "xibao.irodori.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inspect_pcm16(path: Path, policy: dict) -> dict:
    with wave.open(str(path), "rb") as handle:
        channels = handle.getnchannels()
        sample_width = handle.getsampwidth()
        sample_rate = handle.getframerate()
        frames = handle.getnframes()
        payload = handle.readframes(frames)
    if sample_width != 2:
        raise ValueError("preflight output must be PCM16 WAV")
    samples = array.array("h")
    samples.frombytes(payload)
    peak_linear = max((abs(value) for value in samples), default=0) / 32768.0
    rms_linear = math.sqrt(sum(value * value for value in samples) / max(1, len(samples))) / 32768.0
    clip_fraction = sum(abs(value) >= 32735 for value in samples) / max(1, len(samples))
    near_silence = sum(abs(value) < 4 for value in samples) / max(1, len(samples))
    metrics = {
        "sample_rate": sample_rate,
        "channels": channels,
        "duration_s": round(frames / sample_rate, 6),
        "peak_dbfs": round(20 * math.log10(max(peak_linear, 1e-12)), 3),
        "rms_dbfs": round(20 * math.log10(max(rms_linear, 1e-12)), 3),
        "clip_fraction": round(clip_fraction, 8),
        "near_silence_fraction": round(near_silence, 8),
    }
    reasons = []
    if sample_rate != policy["sample_rate"]:
        reasons.append("sample_rate_mismatch")
    if channels != policy["channels"]:
        reasons.append("channel_count_mismatch")
    if metrics["peak_dbfs"] > policy["max_peak_dbfs"]:
        reasons.append("peak_too_high")
    if clip_fraction > policy["max_clip_fraction"]:
        reasons.append("clipping_detected")
    if not policy["min_rms_dbfs"] <= metrics["rms_dbfs"] <= policy["max_rms_dbfs"]:
        reasons.append("rms_out_of_range")
    if near_silence > policy["max_near_silence_fraction"]:
        reasons.append("too_much_near_silence")
    return {"passed": not reasons, "reasons": reasons, "metrics": metrics}


def atomic_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
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
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--irodori-repo", required=True)
    parser.add_argument("--python", required=True)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--codec-weights", required=True)
    parser.add_argument("--reference", required=True)
    parser.add_argument("--text", required=True)
    parser.add_argument("--output-wav", required=True)
    parser.add_argument("--report-out", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)

    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    repo = Path(args.irodori_repo).resolve()
    python = Path(args.python).resolve()
    checkpoint = Path(args.checkpoint).resolve()
    codec = Path(args.codec_weights).resolve()
    reference = Path(args.reference).resolve()
    output = Path(args.output_wav).resolve()
    for label, path in (("python", python), ("checkpoint", checkpoint),
                        ("codec", codec), ("reference", reference)):
        if not path.is_file():
            raise ValueError(f"{label} is not a regular file: {path}")
    revision = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo, check=True, text=True,
        stdout=subprocess.PIPE,
    ).stdout.strip()
    checkpoint_sha256 = sha256(checkpoint)
    codec_sha256 = sha256(codec)
    integrity = {
        "engine_commit": revision,
        "engine_commit_matches": revision == config["engine"]["tested_commit"],
        "checkpoint_sha256": checkpoint_sha256,
        "checkpoint_matches": checkpoint_sha256 == config["checkpoint"]["sha256"],
        "codec_sha256": codec_sha256,
        "codec_matches": codec_sha256 == config["codec"]["sha256"],
        "reference_sha256": sha256(reference),
    }
    if not all(integrity[key] for key in
               ("engine_commit_matches", "checkpoint_matches", "codec_matches")):
        raise ValueError("pinned Irodori runtime integrity check failed")

    inference = config["inference"]
    command = [
        str(python), str(repo / "infer.py"), "--checkpoint", str(checkpoint),
        "--codec-repo", config["codec"]["repository"], "--ref-wav", str(reference),
        "--text", args.text, "--output-wav", str(output), "--model-device", "cuda",
        "--model-precision", inference["model_precision"], "--codec-device", "cuda",
        "--codec-precision", inference["codec_precision"], "--num-steps",
        str(inference["num_steps"]), "--num-candidates", "1", "--seed",
        str(inference["seed"]), "--no-compile-model",
    ]
    if args.execute:
        output.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(command, cwd=repo, check=True)
    if not output.is_file():
        raise ValueError("output WAV does not exist; pass --execute to generate it")
    structural = inspect_pcm16(output, config["structural_quality"])
    report = {
        "schema_version": "pilotfish.irodori_preflight.v1",
        "purpose": "runtime_and_structural_qc_only",
        "identity_verified": False,
        "naturalness_verified": False,
        "output_wav": str(output),
        "output_sha256": sha256(output),
        "integrity": integrity,
        "structural_quality": structural,
        "ready_as_final_voice_model": False,
    }
    atomic_json(Path(args.report_out).resolve(), report)
    print(json.dumps(report, ensure_ascii=False, sort_keys=True))
    return 0 if structural["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
