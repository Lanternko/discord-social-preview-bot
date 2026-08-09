#!/usr/bin/env python3
import sys
import json
import tempfile
import numpy as np
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import build_review_candidates as brc  # noqa: E402


class CandidateSpanTests(unittest.TestCase):
    def test_subtitle_spans_filter_multispeaker_short_and_long_events(self):
        document = {"events": [
            {"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "單人台詞"}]},
            {"tStartMs": 4000, "dDurationMs": 2000, "segs": [{"utf8": "-甲\n-乙"}]},
            {"tStartMs": 7000, "dDurationMs": 500, "segs": [{"utf8": "太短"}]},
            {"tStartMs": 8000, "dDurationMs": 9000, "segs": [{"utf8": "太長"}]},
        ]}
        spans = brc.subtitle_spans(document)
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0]["transcript_zh_subtitle"], "單人台詞")
        self.assertEqual((spans[0]["start_s"], spans[0]["end_s"]), (1.0, 3.0))

    def test_gold_overlap_is_detected_at_both_edges(self):
        self.assertTrue(brc.overlaps({"start_s": 2.0, "end_s": 3.1}, 3.0, 5.829))
        self.assertTrue(brc.overlaps({"start_s": 5.8, "end_s": 6.0}, 3.0, 5.829))
        self.assertFalse(brc.overlaps({"start_s": 5.829, "end_s": 7.0}, 3.0, 5.829))

    def test_inventory_requires_explicit_research_extraction(self):
        with self.assertRaisesRegex(ValueError, "does not allow"):
            brc._rights_allow({"sources": [{
                "source_id": "s1-ep05", "rights": {"research_extraction": "deny"},
            }]}, "s1-ep05")

    def test_reviewed_bank_spans_are_discoverable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "item.json").write_text(json.dumps({
                "source_id": "s1-ep05", "start_s": 1.234, "end_s": 3.456,
            }), encoding="utf-8")
            self.assertEqual(
                brc.bank_span_keys(root), {("s1-ep05", 1.234, 3.456)},
            )

    def test_binary_metrics_report_conservative_gate(self):
        metrics = brc.binary_metrics(
            np.array([1, 1, 0, 0]), np.array([0.9, 0.6, 0.2, 0.1]), 0.7,
        )
        self.assertEqual(metrics["fpr"], 0.0)
        self.assertEqual(metrics["recall"], 0.5)

    def test_bank_source_ids_reads_nested_and_flat_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "flat.json").write_text(json.dumps({"source_id": "s1-ep05"}))
            (root / "nested.json").write_text(json.dumps({
                "candidate": {"source_id": "s1-ep07"},
            }))
            self.assertEqual(brc.bank_source_ids(root), {"s1-ep05", "s1-ep07"})

    def test_review_gate_requires_three_positive_episodes(self):
        held = brc.review_gate_readiness({"s1-ep05"}, minimum_episodes=3)
        self.assertFalse(held["review_ready"])
        self.assertFalse(held["episode_disjoint"])
        enough_sources = brc.review_gate_readiness(
            {"s1-ep05", "s1-ep07", "s2-ep16"}, minimum_episodes=3,
        )
        self.assertFalse(enough_sources["review_ready"])
        ready = brc.finalize_review_gate(enough_sources, {
            "episode_disjoint": True, "auc": 0.91, "fpr": 0.04,
        })
        self.assertTrue(ready["review_ready"])
        self.assertTrue(ready["episode_disjoint"])

    def test_review_gate_rejects_good_non_disjoint_metrics(self):
        enough_sources = brc.review_gate_readiness(
            {"s1-ep05", "s1-ep07", "s2-ep16"}, minimum_episodes=3,
        )
        held = brc.finalize_review_gate(enough_sources, {
            "episode_disjoint": False, "auc": 0.99, "fpr": 0.0,
        })
        self.assertFalse(held["review_ready"])
        self.assertIn("not episode-disjoint", " ".join(held["reasons"]))


if __name__ == "__main__":
    unittest.main()
