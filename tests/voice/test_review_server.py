#!/usr/bin/env python3
import json
import sys
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import review_server as rs  # noqa: E402


class ReviewStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        (self.root / "reference").mkdir()
        (self.root / "reference" / "gold.wav").write_bytes(b"RIFF fixture")
        (self.root / "candidates").mkdir()
        (self.root / "candidates" / "candidate.wav").write_bytes(b"RIFF candidate")
        (self.root / "generations").mkdir()
        (self.root / "generations" / "generated.wav").write_bytes(b"RIFF generated")
        self.store = rs.ReviewStore(self.root, "reviewer-a")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_session_indexes_both_queues_and_reference(self):
        session = self.store.session()
        self.assertEqual(len(session["references"]), 1)
        self.assertEqual(len(session["queues"]["identity"]), 1)
        self.assertEqual(len(session["queues"]["generation"]), 1)
        self.assertEqual(session["counts"]["identity"], {"total": 1, "reviewed": 0})

    def test_nested_cutter_sidecar_metadata_is_exposed(self):
        sidecar = self.root / "candidates" / "candidate.json"
        sidecar.write_text(json.dumps({
            "source": "s1-ep05", "speaker": "pending",
            "times": {"start_s": 5.829, "end_s": 14.8},
            "transcript_zh_subtitle": "字幕台詞", "rank": 3,
        }), encoding="utf-8")
        item = self.store.session()["queues"]["identity"][0]
        self.assertEqual(item["source_id"], "s1-ep05")
        self.assertEqual((item["start_s"], item["end_s"]), (5.829, 14.8))
        self.assertEqual(item["transcript"], "字幕台詞")
        self.assertEqual(item["rank"], 3)

    def test_identity_queue_is_sorted_by_rank(self):
        second = self.root / "candidates" / "second.wav"
        second.write_bytes(b"RIFF second")
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps({"rank": 2}), encoding="utf-8",
        )
        (self.root / "candidates" / "second.json").write_text(
            json.dumps({"rank": 1}), encoding="utf-8",
        )
        items = self.store.session()["queues"]["identity"]
        self.assertEqual([item["rank"] for item in items], [1, 2])

    def test_identity_review_is_atomically_upserted(self):
        item = self.store.session()["queues"]["identity"][0]
        record = self.store.save({"kind": "identity", "item_id": item["id"], "answers": {
            "verdict": "target", "overlap": False, "confidence": 5, "notes": "clean",
        }})
        self.assertEqual(record["answers"]["verdict"], "target")
        document = json.loads(self.store.review_path.read_text(encoding="utf-8"))
        self.assertEqual(len(document["reviews"]), 1)
        self.assertEqual(self.store.session()["counts"]["identity"]["reviewed"], 1)

    def test_generation_review_requires_complete_scores(self):
        item = self.store.session()["queues"]["generation"][0]
        with self.assertRaisesRegex(ValueError, "likeness"):
            self.store.save({"kind": "generation", "item_id": item["id"], "answers": {
                "verdict": "accept", "naturalness": 5, "artifacts": [], "notes": "",
            }})

    def test_unknown_media_and_extra_fields_fail_closed(self):
        self.store.session()
        with self.assertRaisesRegex(ValueError, "unknown"):
            self.store.save({"kind": "identity", "item_id": "missing", "answers": {}})
        item = self.store.session()["queues"]["identity"][0]
        with self.assertRaisesRegex(ValueError, "invalid"):
            self.store.save({"kind": "identity", "item_id": item["id"], "answers": {
                "verdict": "target", "overlap": False, "confidence": 5, "surprise": True,
            }})


if __name__ == "__main__":
    unittest.main()
