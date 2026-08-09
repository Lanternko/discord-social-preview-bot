#!/usr/bin/env python3
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import transcribe_positive_bank as tpb  # noqa: E402


class TranscribePositiveBankTests(unittest.TestCase):
    def test_positive_records_are_hash_bound_and_generation_is_stable(self):
        with tempfile.TemporaryDirectory() as directory:
            bank = Path(directory) / "bank"
            positive = bank / "positive"
            positive.mkdir(parents=True)
            audio = positive / "clip.wav"
            audio.write_bytes(b"audio fixture")
            digest = hashlib.sha256(audio.read_bytes()).hexdigest()
            audio.with_suffix(".json").write_text(json.dumps({
                "audio_sha256": digest,
                "source_id": "s1-ep05",
                "candidate": {"start_s": 1.0, "end_s": 3.0,
                              "transcript_zh_subtitle": "提示"},
            }), encoding="utf-8")
            records = tpb.positive_records(bank)
            self.assertEqual(records[0]["audio_sha256"], digest)
            first = tpb.generation_id({"model": "fixture"}, records)
            second = tpb.generation_id({"model": "fixture"}, records)
            self.assertEqual(first, second)

    def test_hash_mismatch_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            bank = Path(directory) / "bank"
            positive = bank / "positive"
            positive.mkdir(parents=True)
            audio = positive / "clip.wav"
            audio.write_bytes(b"audio fixture")
            audio.with_suffix(".json").write_text(json.dumps({
                "audio_sha256": "0" * 64, "source_id": "s1-ep05",
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                tpb.positive_records(bank)


if __name__ == "__main__":
    unittest.main()
