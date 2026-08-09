#!/usr/bin/env python3
import sys
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


if __name__ == "__main__":
    unittest.main()
