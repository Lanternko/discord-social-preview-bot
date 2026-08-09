#!/usr/bin/env python3
"""Create hash-bound Japanese ASR drafts for every reviewed positive clip."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any


APP_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = APP_ROOT / "configs" / "voice" / "xibao.asr.json"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def positive_records(bank_dir: Path) -> list[dict[str, Any]]:
    positive = bank_dir / "positive"
    if not positive.is_dir():
        raise ValueError("positive bank directory is missing")
    records = []
    for audio in sorted(positive.glob("*.wav")):
        sidecar_path = audio.with_suffix(".json")
        if not sidecar_path.is_file():
            raise ValueError(f"sidecar is missing for {audio.name}")
        sidecar = json.loads(sidecar_path.read_text(encoding="utf-8"))
        candidate = sidecar.get("candidate")
        candidate = candidate if isinstance(candidate, dict) else sidecar
        actual_hash = sha256_file(audio)
        expected_hash = sidecar.get("audio_sha256") or candidate.get("audio_sha256")
        if expected_hash != actual_hash:
            raise ValueError(f"audio hash mismatch for {audio.name}")
        source_id = sidecar.get("source_id") or candidate.get("source_id") or candidate.get("source")
        if not isinstance(source_id, str) or not source_id:
            raise ValueError(f"source_id is missing for {audio.name}")
        records.append({
            "audio": audio.resolve(),
            "audio_sha256": actual_hash,
            "clip_id": audio.stem,
            "source_id": source_id,
            "start_s": candidate.get("start_s"),
            "end_s": candidate.get("end_s"),
            "transcript_zh_subtitle": candidate.get("transcript_zh_subtitle"),
        })
    if not records:
        raise ValueError("positive bank is empty")
    return records


def generation_id(config: dict, records: list[dict[str, Any]]) -> str:
    value = {
        "config": config,
        "clips": [{"clip_id": item["clip_id"], "audio_sha256": item["audio_sha256"]}
                  for item in records],
    }
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _publish_directory(staging: Path, destination: Path) -> None:
    backup = destination.with_name(f".{destination.name}.backup")
    if backup.exists():
        shutil.rmtree(backup)
    moved_existing = False
    try:
        if destination.exists():
            os.replace(destination, backup)
            moved_existing = True
        os.replace(staging, destination)
    except Exception:
        if moved_existing and backup.exists() and not destination.exists():
            os.replace(backup, destination)
        raise
    finally:
        if backup.exists():
            shutil.rmtree(backup)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--bank-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    config_path = Path(args.config).resolve()
    config = json.loads(config_path.read_text(encoding="utf-8"))
    model_path = Path(args.model_path).resolve()
    model_file = model_path / "model.bin"
    tokenizer_file = model_path / "tokenizer.json"
    if (not model_file.is_file() or
            sha256_file(model_file) != config["model"]["model_sha256"]):
        raise ValueError("ASR model.bin integrity check failed")
    if (not tokenizer_file.is_file() or
            sha256_file(tokenizer_file) != config["model"]["tokenizer_sha256"]):
        raise ValueError("ASR tokenizer integrity check failed")
    records = positive_records(Path(args.bank_dir).resolve())
    generation = generation_id(config, records)
    if args.dry_run:
        print(json.dumps({"clips": len(records), "generation_id": generation,
                          "dry_run": True}, sort_keys=True))
        return 0

    from faster_whisper import WhisperModel  # Imported lazily for dry-run portability.
    import ctranslate2
    import faster_whisper

    if faster_whisper.__version__ != config["runtime"]["faster_whisper"]:
        raise ValueError("faster-whisper version does not match pinned runtime")
    if ctranslate2.__version__ != config["runtime"]["ctranslate2"]:
        raise ValueError("CTranslate2 version does not match pinned runtime")
    runtime = config["runtime"]
    decoding = config["decoding"]
    model = WhisperModel(str(model_path), device=runtime["device"],
                         compute_type=runtime["compute_type"], local_files_only=True)
    out_dir = Path(args.out_dir).resolve()
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{out_dir.name}.", dir=out_dir.parent))
    try:
        for record in records:
            segments, info = model.transcribe(str(record["audio"]), **decoding)
            segment_values = []
            for segment in segments:
                segment_values.append({
                    "start": round(segment.start, 3), "end": round(segment.end, 3),
                    "text": segment.text.strip(),
                    "avg_logprob": round(segment.avg_logprob, 6),
                    "no_speech_prob": round(segment.no_speech_prob, 6),
                    "words": [{"start": round(word.start, 3), "end": round(word.end, 3),
                               "word": word.word, "probability": round(word.probability, 6)}
                              for word in (segment.words or [])],
                })
            draft = {
                "schema_version": "pilotfish.japanese_asr_draft.v1",
                **record,
                "audio": None,
                "audio_path": str(record["audio"]),
                "transcript_ja_asr": "".join(item["text"] for item in segment_values).strip(),
                "language": info.language,
                "language_probability": round(info.language_probability, 6),
                "model": config["model"],
                "runtime": config["runtime"],
                "segments": segment_values,
                "verified": False,
                "generation_id": generation,
            }
            draft.pop("audio")
            (staging / f"{record['clip_id']}.json").write_text(
                json.dumps(draft, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
        manifest = {
            "schema_version": "pilotfish.japanese_asr_draft_manifest.v1",
            "generation_id": generation,
            "clips": len(records),
            "verified": 0,
            "config_sha256": sha256_file(config_path),
            "items": [record["clip_id"] for record in records],
        }
        (staging / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        _publish_directory(staging, out_dir)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    print(json.dumps({"clips": len(records), "generation_id": generation,
                      "out_dir": str(out_dir)}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
