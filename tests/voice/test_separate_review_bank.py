#!/usr/bin/env python3
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import separate_review_bank as srb  # noqa: E402


class SeparateReviewBankTests(unittest.TestCase):
    def test_only_hash_valid_transcript_verified_positives_are_selected(self):
        with tempfile.TemporaryDirectory() as directory:
            bank = Path(directory)
            positive = bank / "positive"
            positive.mkdir()
            audio = positive / "valid.wav"
            audio.write_bytes(b"RIFF valid")
            audio.with_suffix(".json").write_text(json.dumps({
                "label": "positive", "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
                "transcript_ja_verified": "確認済み",
            }), encoding="utf-8")
            unverified = positive / "unverified.wav"
            unverified.write_bytes(b"RIFF unverified")
            unverified.with_suffix(".json").write_text(json.dumps({
                "label": "positive", "audio_sha256": hashlib.sha256(unverified.read_bytes()).hexdigest(),
            }), encoding="utf-8")
            self.assertEqual([item["audio"].name for item in srb.verified_inputs(bank)], ["valid.wav"])

    def test_hash_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            positive = Path(directory) / "positive"
            positive.mkdir()
            audio = positive / "changed.wav"
            audio.write_bytes(b"changed")
            audio.with_suffix(".json").write_text(json.dumps({
                "label": "positive", "audio_sha256": "0" * 64,
                "transcript_ja_verified": "確認済み",
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                srb.verified_inputs(Path(directory))

    def test_generation_id_changes_with_inputs_and_config(self):
        inputs = [{"audio": Path("a.wav"), "audio_sha256": "a" * 64}]
        first = srb.generation_id(inputs, {"model": "one"})
        self.assertNotEqual(first, srb.generation_id(inputs, {"model": "two"}))
        self.assertNotEqual(first, srb.generation_id(
            [{"audio": Path("a.wav"), "audio_sha256": "b" * 64}], {"model": "one"},
        ))


if __name__ == "__main__":
    unittest.main()
