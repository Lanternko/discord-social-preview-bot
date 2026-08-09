#!/usr/bin/env python3
import hashlib
import json
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import build_irodori_manifests as bim  # noqa: E402


class IrodoriManifestTests(unittest.TestCase):
    @staticmethod
    def add_clip(root: Path, source_id: str, index: int):
        positive = root / "bank" / "positive"
        positive.mkdir(parents=True, exist_ok=True)
        audio = positive / f"{source_id}-{index}.wav"
        with wave.open(str(audio), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16000)
            handle.writeframes(struct.pack(
                "<hh", sum(source_id.encode("utf-8")) % 30000, index + 1,
            ) * 24000)
        digest = hashlib.sha256(audio.read_bytes()).hexdigest()
        audio.with_suffix(".json").write_text(json.dumps({
            "source_id": source_id,
            "audio_sha256": digest,
            "transcript_ja_verified": f"台詞{source_id}{index}",
            "review": {"answers": {
                "verdict": "target", "overlap": False, "confidence": 5,
            }},
        }), encoding="utf-8")

    @staticmethod
    def inventory(root: Path, source_ids, allow=True):
        path = root / "inventory.json"
        path.write_text(json.dumps({"sources": [{
            "source_id": source_id,
            "rights": {
                "research_extraction": "allow",
                "training": "allow" if allow else "deny",
            },
        } for source_id in source_ids]}), encoding="utf-8")
        return path

    def test_unready_bank_cannot_export(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.add_clip(root, "s1-ep05", 0)
            with self.assertRaisesRegex(bim.ReadinessError, "readiness failed"):
                bim.export(
                    root / "bank", self.inventory(root, ["s1-ep05"], allow=False),
                    root / "out",
                )
            self.assertFalse((root / "out").exists())

    def test_ready_bank_exports_grouped_holdout_and_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(8):
                self.add_clip(root, "s1-ep05", index)
            for source_id in ("s1-ep06", "s1-ep11"):
                for index in range(10):
                    self.add_clip(root, source_id, index)
            result = bim.export(
                root / "bank",
                self.inventory(root, ["s1-ep05", "s1-ep06", "s1-ep11"]),
                root / "out",
            )
            self.assertEqual((result["train"], result["holdout"]), (20, 8))
            generation_dir = root / "out" / result["generation_id"]
            manifest = json.loads((generation_dir / "dataset.json").read_text())
            self.assertEqual(len(manifest["generation_id"]), 64)
            self.assertEqual(
                {row["source_id"] for row in manifest["records"] if row["split"] == "holdout"},
                {"s1-ep05"},
            )
            train = [json.loads(line) for line in
                     (generation_dir / "train.input.jsonl").read_text().splitlines()]
            self.assertTrue(all(set(row) == {"audio", "text"} for row in train))
            current = json.loads((root / "out" / "current.json").read_text())
            self.assertEqual(current["generation_id"], result["generation_id"])


if __name__ == "__main__":
    unittest.main()
