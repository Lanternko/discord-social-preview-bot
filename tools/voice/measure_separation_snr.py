#!/usr/bin/env python3
"""Measure raw-mixture SNR after aligning a separated vocal stem in time and gain."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path


def aligned_snr(raw, vocal, sample_rate: int, max_lag_seconds: float = 0.25) -> dict:
    """Fit raw ~= gain * vocal + residual and return the aligned energy ratio."""
    import numpy as np
    from scipy.signal import correlate, correlation_lags

    raw = np.asarray(raw, dtype="float32")
    vocal = np.asarray(vocal, dtype="float32")
    if raw.ndim != 1 or vocal.ndim != 1 or not len(raw) or not len(vocal):
        raise ValueError("raw and vocal must be non-empty mono arrays")
    raw = raw - np.mean(raw)
    vocal = vocal - np.mean(vocal)
    if float(np.dot(raw, raw)) <= 1e-12 or float(np.dot(vocal, vocal)) <= 1e-12:
        raise ValueError("cannot measure silent audio")

    correlation = correlate(raw, vocal, mode="full", method="fft")
    lags = correlation_lags(len(raw), len(vocal), mode="full")
    allowed = np.abs(lags) <= round(sample_rate * max_lag_seconds)
    lag = int(lags[allowed][np.argmax(correlation[allowed])])
    if lag >= 0:
        aligned_raw = raw[lag:]
        aligned_vocal = vocal[:len(aligned_raw)]
    else:
        aligned_vocal = vocal[-lag:]
        aligned_raw = raw[:len(aligned_vocal)]
    length = min(len(aligned_raw), len(aligned_vocal))
    aligned_raw = aligned_raw[:length]
    aligned_vocal = aligned_vocal[:length]

    gain = float(
        np.dot(aligned_raw, aligned_vocal)
        / max(float(np.dot(aligned_vocal, aligned_vocal)), 1e-12)
    )
    fitted_vocal = gain * aligned_vocal
    residual = aligned_raw - fitted_vocal
    vocal_power = max(float(np.mean(fitted_vocal * fitted_vocal)), 1e-15)
    residual_power = max(float(np.mean(residual * residual)), 1e-15)
    return {
        "snr_db": 10.0 * math.log10(vocal_power / residual_power),
        "lag_samples": lag,
        "gain": gain,
        "aligned_samples": length,
    }


def load_mono(path: Path, target_rate: int | None = None):
    import numpy as np
    import soundfile as sf
    from scipy.signal import resample_poly

    samples, rate = sf.read(path, dtype="float32", always_2d=True)
    mono = samples.mean(axis=1)
    if target_rate is not None and rate != target_rate:
        divisor = math.gcd(rate, target_rate)
        mono = resample_poly(mono, target_rate // divisor, rate // divisor).astype("float32")
        rate = target_rate
    return np.asarray(mono, dtype="float32"), int(rate)


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def measure(manifest_path: Path, train_input_path: Path | None = None) -> dict:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    selected_audio = None
    if train_input_path is not None:
        selected_audio = {str(Path(row["audio"]).resolve()) for row in read_jsonl(train_input_path)}

    rows = []
    for clip in manifest["clips"]:
        vocal_path = manifest_path.parent / f"{clip['clip_id']}.wav"
        if selected_audio is not None and str(vocal_path.resolve()) not in selected_audio:
            continue
        raw, raw_rate = load_mono(Path(clip["raw_audio_path"]))
        vocal, _ = load_mono(vocal_path, raw_rate)
        result = aligned_snr(raw, vocal, raw_rate)
        rows.append({
            "clip_id": clip["clip_id"],
            "source_id": clip.get("source_id"),
            "duration_s": round(float(clip["end_s"] - clip["start_s"]), 6),
            "raw_audio_path": clip["raw_audio_path"],
            "vocal_audio_path": str(vocal_path.resolve()),
            "snr_db": round(result["snr_db"], 6),
            "lag_samples": result["lag_samples"],
            "gain": round(result["gain"], 8),
        })
    rows.sort(key=lambda row: (row["snr_db"], row["clip_id"]))
    if not rows:
        raise ValueError("no manifest clips matched the requested training input")

    import numpy as np
    values = np.asarray([row["snr_db"] for row in rows])
    return {
        "schema_version": "pilotfish.separation_snr.v1",
        "method": {
            "model": "raw = gain * time_aligned_vocal + residual",
            "gain_fit": "least_squares",
            "max_lag_seconds": 0.25,
            "dc_removed": True,
        },
        "manifest_path": str(manifest_path.resolve()),
        "train_input_path": str(train_input_path.resolve()) if train_input_path else None,
        "summary": {
            "clips": len(rows),
            "duration_s": round(sum(row["duration_s"] for row in rows), 6),
            "minimum_db": round(float(values.min()), 6),
            "median_db": round(float(np.median(values)), 6),
            "maximum_db": round(float(values.max()), 6),
            "below_5_db": int(np.sum(values < 5)),
            "below_10_db": int(np.sum(values < 10)),
            "below_15_db": int(np.sum(values < 15)),
            "below_20_db": int(np.sum(values < 20)),
        },
        "clips": rows,
    }


def write_filtered_input(source: Path, destination: Path, report: dict, minimum_db: float) -> int:
    accepted = {
        row["vocal_audio_path"] for row in report["clips"] if row["snr_db"] >= minimum_db
    }
    rows = [row for row in read_jsonl(source) if str(Path(row["audio"]).resolve()) in accepted]
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8"
    )
    return len(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--train-input")
    parser.add_argument("--report-out", required=True)
    parser.add_argument("--minimum-db", type=float)
    parser.add_argument("--filtered-input-out")
    args = parser.parse_args(argv)
    if (args.minimum_db is None) != (args.filtered_input_out is None):
        parser.error("--minimum-db and --filtered-input-out must be used together")

    manifest = Path(args.manifest).resolve()
    train_input = Path(args.train_input).resolve() if args.train_input else None
    report = measure(manifest, train_input)
    report_path = Path(args.report_out).resolve()
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    output = {"report": str(report_path), **report["summary"]}
    if args.filtered_input_out:
        if train_input is None:
            parser.error("--train-input is required when writing a filtered input")
        output["filtered_clips"] = write_filtered_input(
            train_input, Path(args.filtered_input_out).resolve(), report, args.minimum_db
        )
        output["filter_minimum_db"] = args.minimum_db
    print(json.dumps(output, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
