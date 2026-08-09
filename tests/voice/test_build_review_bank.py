#!/usr/bin/env python3
import sys
import json
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import build_review_bank as brb  # noqa: E402


class ReviewBankTests(unittest.TestCase):
    def test_only_clean_confident_target_is_positive(self):
        self.assertEqual(brb.classify({
            "verdict": "target", "overlap": False, "confidence": 3,
        }), "positive")
        self.assertIsNone(brb.classify({
            "verdict": "target", "overlap": True, "confidence": 5,
        }))
        self.assertIsNone(brb.classify({
            "verdict": "target", "overlap": False, "confidence": 2,
        }))

    def test_confident_other_is_negative(self):
        self.assertEqual(brb.classify({
            "verdict": "other", "overlap": False, "confidence": 5,
        }), "negative")
        self.assertIsNone(brb.classify({
            "verdict": "uncertain", "overlap": False, "confidence": 5,
        }))

    def test_existing_bank_is_preserved_when_new_reviews_are_added(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bank = root / "bank"
            (bank / "positive").mkdir(parents=True)
            (bank / "positive" / "old.wav").write_bytes(b"old")
            reviews = root / "reviews.json"
            media = root / "new.wav"
            media.write_bytes(b"new")
            reviews.write_text(json.dumps({"reviews": {"new": {
                "kind": "identity", "media_path": str(media),
                "answers": {"verdict": "other", "overlap": False, "confidence": 5},
            }}}), encoding="utf-8")
            counts = brb.build(reviews, bank)
            self.assertEqual((counts["positive"], counts["negative"]), (1, 1))
            self.assertTrue((bank / "positive" / "old.wav").is_file())

    def test_missing_media_can_restore_reviewed_span_from_archive_sidecar(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "archive"
            archive.mkdir()
            (archive / "gone.json").write_text(json.dumps({
                "source_id": "s1-ep01", "start_s": 1.0, "end_s": 2.0,
            }), encoding="utf-8")
            reviews = root / "reviews.json"
            reviews.write_text(json.dumps({"reviews": {"old": {
                "kind": "identity", "media_path": str(root / "gone.wav"),
                "answers": {"verdict": "uncertain", "overlap": False, "confidence": 2},
            }}}), encoding="utf-8")
            counts = brb.build(reviews, root / "bank", [archive])
            self.assertEqual(counts["reviewed_spans"], 1)


if __name__ == "__main__":
    unittest.main()
