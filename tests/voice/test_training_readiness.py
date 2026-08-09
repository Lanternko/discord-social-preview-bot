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
import training_readiness as tr  # noqa: E402


class TrainingReadinessTests(unittest.TestCase):
    @staticmethod
    def write_clip(root: Path, source_id: str, index: int, *, transcript: bool = True):
        directory = root / "bank" / "positive"
        directory.mkdir(parents=True, exist_ok=True)
        wav_path = directory / f"{source_id}-{index:02d}.wav"
        with wave.open(str(wav_path), "wb") as handle:
            handle.setnchannels(1)
            handle.setsampwidth(2)
            handle.setframerate(16000)
            source_sample = sum(source_id.encode("utf-8")) % 30000
            handle.writeframes(struct.pack("<hh", source_sample, index + 1) * 24000)
        digest = hashlib.sha256(wav_path.read_bytes()).hexdigest()
        candidate = {"source_id": source_id, "audio_sha256": digest}
        if transcript:
            candidate["transcript_ja_verified"] = f"確認済み{index}"
        wav_path.with_suffix(".json").write_text(json.dumps({
            "source_id": source_id,
            "audio_sha256": digest,
            "review": {"answers": {
                "verdict": "target", "overlap": False, "confidence": 5,
            }},
            "candidate": candidate,
        }), encoding="utf-8")

    @staticmethod
    def inventory(root: Path, source_ids, *, allow: bool) -> Path:
        path = root / "inventory.json"
        value = "allow" if allow else "deny"
        path.write_text(json.dumps({"sources": [{
            "source_id": source_id,
            "rights": {"research_extraction": "allow", "training": value},
        } for source_id in source_ids]}), encoding="utf-8")
        return path

    def test_current_shape_fails_without_cross_episode_train_set(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(8):
                self.write_clip(root, "s1-ep05", index)
            report = tr.assess(root / "bank", self.inventory(root, ["s1-ep05"], allow=False))
            self.assertFalse(report["ready_for_training"])
            self.assertIn("episode_disjoint_holdout", report["failed_gates"])
            self.assertIn("source_rights", report["failed_gates"])

    def test_complete_episode_disjoint_corpus_passes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(8):
                self.write_clip(root, "s1-ep05", index)
            for source_id in ("s1-ep06", "s1-ep11"):
                for index in range(10):
                    self.write_clip(root, source_id, index)
            report = tr.assess(
                root / "bank",
                self.inventory(root, ["s1-ep05", "s1-ep06", "s1-ep11"], allow=True),
            )
            self.assertTrue(report["ready_for_training"])
            self.assertEqual(report["gates"]["episode_disjoint_holdout"]["holdout_source"],
                             "s1-ep05")

    def test_missing_verified_transcript_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index in range(8):
                self.write_clip(root, "s1-ep05", index)
            for source_id in ("s1-ep06", "s1-ep11"):
                for index in range(10):
                    self.write_clip(root, source_id, index,
                                    transcript=not (source_id == "s1-ep11" and index == 0))
            report = tr.assess(
                root / "bank",
                self.inventory(root, ["s1-ep05", "s1-ep06", "s1-ep11"], allow=True),
            )
            self.assertFalse(report["ready_for_training"])
            self.assertIn("verified_japanese_transcripts", report["failed_gates"])


if __name__ == "__main__":
    unittest.main()
