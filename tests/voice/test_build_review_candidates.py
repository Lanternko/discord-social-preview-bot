#!/usr/bin/env python3
import sys
import json
import tempfile
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


if __name__ == "__main__":
    unittest.main()
