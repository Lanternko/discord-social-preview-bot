#!/usr/bin/env python3
import hashlib
import sys
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import validate_generation as vg  # noqa: E402


class GenerationQualityGateTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.audio = Path(self.temp_dir.name) / "sample.wav"
        self.audio.write_bytes(b"synthetic fixture")

    def tearDown(self):
        self.temp_dir.cleanup()

    def report(self):
        return {
            "audio_path": str(self.audio),
            "audio_sha256": hashlib.sha256(self.audio.read_bytes()).hexdigest(),
            "identity": {"calibrated": True, "episode_disjoint": True, "auc": 0.91,
                         "fpr": 0.04, "score": 0.76, "threshold": 0.72},
            "audio_quality": {"peak_dbfs": -2.0, "clip_fraction": 0.0001,
                              "rms_dbfs": -22.0, "silence_ratio": 0.1},
            "dnsmos": {"ovrl": 3.1, "sig": 3.2, "bak": 3.4},
            "human_reviews": [
                {"reviewer": "a", "identity": "target", "natural": True, "artifacts": False},
                {"reviewer": "b", "identity": "target", "natural": True, "artifacts": False},
            ],
        }

    def test_complete_clean_report_passes(self):
        decision = vg.evaluate(self.report())
        self.assertTrue(decision["approved_for_use"])
        self.assertEqual(decision["reasons"], [])

    def test_identity_failure_cannot_be_hidden_by_good_audio(self):
        report = self.report()
        report["identity"]["score"] = 0.5
        decision = vg.evaluate(report)
        self.assertFalse(decision["approved_for_use"])
        self.assertIn("identity_score_below_threshold", decision["reasons"])

    def test_clipping_and_unnatural_audio_are_blocked(self):
        report = self.report()
        report["audio_quality"]["peak_dbfs"] = -0.1
        report["audio_quality"]["clip_fraction"] = 0.02
        report["dnsmos"]["ovrl"] = 2.0
        report["human_reviews"][1]["natural"] = False
        decision = vg.evaluate(report)
        self.assertFalse(decision["approved_for_use"])
        self.assertIn("peak_too_high", decision["reasons"])
        self.assertIn("clipping_detected", decision["reasons"])
        self.assertIn("dnsmos_ovrl_below_minimum", decision["reasons"])
        self.assertIn("human_review_rejected", decision["reasons"])

    def test_duplicate_reviewers_do_not_count_twice(self):
        report = self.report()
        report["human_reviews"][1]["reviewer"] = "a"
        decision = vg.evaluate(report)
        self.assertFalse(decision["approved_for_use"])
        self.assertIn("human_reviews_insufficient", decision["reasons"])

    def test_hash_mismatch_is_blocked(self):
        report = self.report()
        report["audio_sha256"] = "0" * 64
        decision = vg.evaluate(report)
        self.assertFalse(decision["approved_for_use"])
        self.assertIn("audio_sha256_mismatch", decision["reasons"])


if __name__ == "__main__":
    unittest.main()
