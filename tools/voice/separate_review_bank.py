#!/usr/bin/env python3
"""Create provenance-bound MelBand-RoFormer A/B stems from verified positives."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
from importlib.metadata import version
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verified_inputs(bank_dir: Path) -> list[dict]:
    result = []
    for audio in sorted((bank_dir / "positive").glob("*.wav")):
        sidecar_path = audio.with_suffix(".json")
        if not sidecar_path.is_file():
            continue
        sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        expected = sidecar.get("audio_sha256")
        transcript = sidecar.get("transcript_ja_verified")
        if sidecar.get("label") != "positive" or not isinstance(transcript, str) or not transcript.strip():
            continue
        actual = sha256(audio)
        if expected != actual:
            raise ValueError(f"positive bank hash mismatch: {audio}")
        result.append({"audio": audio, "sidecar": sidecar, "audio_sha256": actual})
    return result


def generation_id(inputs: list[dict], config: dict) -> str:
    payload = {
        "inputs": [{"clip_id": item["audio"].stem, "sha256": item["audio_sha256"]}
                   for item in inputs],
        "config": config,
    }
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def audio_metrics(path: Path) -> dict:
    import numpy as np
    import soundfile as sf

    samples, sample_rate = sf.read(path, dtype="float32", always_2d=True)
    mono = samples.mean(axis=1)
    peak = float(np.max(np.abs(mono))) if len(mono) else 0.0
    rms = float(np.sqrt(np.mean(np.square(mono)))) if len(mono) else 0.0
    return {
        "sample_rate": int(sample_rate),
        "channels": int(samples.shape[1]),
        "duration_s": round(len(mono) / sample_rate, 6) if sample_rate else 0.0,
        "peak": round(peak, 8),
        "rms": round(rms, 8),
        "clip_fraction": round(float(np.mean(np.abs(mono) >= 0.999)), 8) if len(mono) else 0.0,
    }


def separate(bank_dir: Path, out_dir: Path, config_path: Path, model_dir: Path,
             limit: int = 0) -> dict:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    model = model_dir / config["model"]["filename"]
    if not model.is_file() or sha256(model) != config["model"]["sha256"]:
        raise ValueError("MelBand-RoFormer model is missing or has the wrong SHA-256")
    if version(config["runtime"]["package"]) != config["runtime"]["version"]:
        raise ValueError("audio-separator runtime version does not match config")
    inputs = verified_inputs(bank_dir)
    if limit:
        inputs = inputs[:limit]
    if not inputs:
        raise ValueError("no hash-valid, transcript-verified positives to separate")
    gid = generation_id(inputs, config)
    destination = out_dir / gid
    if destination.is_dir():
        return {"generation_id": gid, "clips": len(inputs), "out_dir": str(destination)}

    processing = config["processing"]
    out_dir.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=".separation.", dir=out_dir))
    work = staging / "_work"
    work.mkdir()
    try:
        from audio_separator.separator import Separator

        separator = Separator(
            output_dir=str(work), model_file_dir=str(model_dir), output_format="WAV",
            output_single_stem="Vocals", log_level=30,
        )
        separator.load_model(model_filename=model.name)
        records = []
        for item in inputs:
            source = item["audio"]
            original = audio_metrics(source)
            separator_input = source
            padded = None
            if original["duration_s"] < processing["minimum_input_seconds"]:
                padded = work / f"{source.stem}.pad.wav"
                subprocess.run([
                    "ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(source),
                    "-af", f"apad=whole_dur={processing['padded_seconds']}", str(padded),
                ], check=True)
                separator_input = padded
            outputs = separator.separate(
                str(separator_input), custom_output_names={"Vocals": f"{source.stem}.vocal"},
            )
            stem = Path(outputs[0])
            if not stem.is_absolute():
                stem = work / stem
            stem_metrics = audio_metrics(stem)
            energy_ratio = stem_metrics["rms"] / max(original["rms"], 1e-9)
            if energy_ratio < processing["minimum_vocal_energy_ratio"]:
                raise ValueError(f"vocal energy too low for {source.stem}: {energy_ratio:.4f}")
            output = staging / f"{source.stem}.wav"
            subprocess.run([
                "ffmpeg", "-nostdin", "-y", "-loglevel", "error", "-i", str(stem),
                "-af", (
                    f"atrim=0:{original['duration_s']},"
                    f"loudnorm=I={processing['loudness_lufs']}:LRA=7:TP={processing['true_peak_db']}"
                ),
                "-ac", "1", "-ar", str(processing["output_sample_rate"]),
                "-c:a", "pcm_s16le", str(output),
            ], check=True)
            output_metrics = audio_metrics(output)
            if output_metrics["clip_fraction"] > 0.001:
                raise ValueError(f"separated output clips for {source.stem}")
            record = {
                "schema_version": "pilotfish.voice_separation.v1",
                "clip_id": source.stem,
                "source_id": item["sidecar"].get("source_id"),
                "start_s": item["sidecar"].get("start_s"),
                "end_s": item["sidecar"].get("end_s"),
                "transcript_ja_verified": item["sidecar"]["transcript_ja_verified"],
                "raw_audio_path": str(source.resolve()),
                "raw_audio_sha256": item["audio_sha256"],
                "vocal_audio_sha256": sha256(output),
                "model": {**config["model"], "runtime": config["runtime"]},
                "metrics": {
                    "raw": original, "untrimmed_vocal": stem_metrics,
                    "output": output_metrics, "vocal_energy_ratio": round(energy_ratio, 6),
                },
                "review_ready": True,
                "training_eligible": False,
            }
            output.with_suffix(".json").write_text(
                json.dumps(record, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            records.append(record)
            stem.unlink(missing_ok=True)
            if padded:
                padded.unlink(missing_ok=True)
        shutil.rmtree(work)
        (staging / "manifest.json").write_text(json.dumps({
            "schema_version": "pilotfish.voice_separation_manifest.v1",
            "generation_id": gid, "config": config, "clips": records,
        }, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        os.replace(staging, destination)
        current = out_dir / "current.json"
        temporary = out_dir / ".current.json.tmp"
        temporary.write_text(json.dumps({"generation_id": gid}, sort_keys=True) + "\n",
                             encoding="utf-8")
        os.replace(temporary, current)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return {"generation_id": gid, "clips": len(inputs), "out_dir": str(destination)}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bank-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--model-dir", default=str(Path.home() / ".cache/audio-separator-models"))
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args(argv)
    result = separate(Path(args.bank_dir).resolve(), Path(args.out_dir).resolve(),
                      Path(args.config).resolve(), Path(args.model_dir).resolve(), args.limit)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
