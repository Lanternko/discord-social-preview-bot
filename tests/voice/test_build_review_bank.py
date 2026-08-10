#!/usr/bin/env python3
import sys
import json
import hashlib
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

    def test_updated_overlap_verdict_retracts_existing_positive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bank = root / "bank"
            (bank / "positive").mkdir(parents=True)
            (bank / "positive" / "clip.wav").write_bytes(b"old positive")
            (bank / "positive" / "clip.json").write_text("{}", encoding="utf-8")
            media = root / "clip.wav"
            media.write_bytes(b"current candidate")
            reviews = root / "reviews.json"
            reviews.write_text(json.dumps({"reviews": {"identity": {
                "kind": "identity", "media_path": str(media),
                "answers": {"verdict": "target", "overlap": True, "confidence": 5},
            }}}), encoding="utf-8")

            counts = brb.build(reviews, bank)

            self.assertEqual(counts["positive"], 0)
            self.assertFalse((bank / "positive" / "clip.wav").exists())
            self.assertFalse((bank / "positive" / "clip.json").exists())

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

    def test_accepted_transcript_review_is_merged_into_positive_bank(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "clip.wav"
            media.write_bytes(b"reviewed audio")
            media.with_suffix(".json").write_text(json.dumps({
                "source_id": "s1-ep05",
                "audio_sha256": hashlib.sha256(media.read_bytes()).hexdigest(),
            }), encoding="utf-8")
            reviews = root / "reviews.json"
            reviews.write_text(json.dumps({"reviews": {
                "identity": {"kind": "identity", "media_path": str(media),
                             "answers": {"verdict": "target", "overlap": False,
                                         "confidence": 5}},
                "transcript": {"kind": "transcript", "media_path": str(media),
                               "reviewer": "linguist", "reviewed_at": "now",
                               "answers": {"verdict": "accept",
                                           "transcript_ja_verified": "谷くんです。"}},
            }}), encoding="utf-8")
            brb.build(reviews, root / "bank")
            exported = json.loads((root / "bank" / "positive" / "clip.json").read_text())
            self.assertEqual(exported["transcript_ja_verified"], "谷くんです。")
            self.assertEqual(exported["transcript_review"]["reviewer"], "linguist")

    def test_transcript_survives_rebuild_after_original_candidate_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "candidate.wav"
            media.write_bytes(b"RIFF reviewed voice")
            media.with_suffix(".json").write_text(json.dumps({
                "source_id": "s1-ep05", "start_s": 1.0, "end_s": 3.0,
                "audio_sha256": hashlib.sha256(media.read_bytes()).hexdigest(),
            }), encoding="utf-8")
            reviews = root / "reviews.json"
            reviews.write_text(json.dumps({"reviews": {
                "identity": {
                    "kind": "identity", "media_path": str(media),
                    "answers": {"verdict": "target", "overlap": False, "confidence": 5},
                },
            }}), encoding="utf-8")
            bank = root / "bank"
            brb.build(reviews, bank)
            media.unlink()
            media.with_suffix(".json").unlink()
            bank_audio = bank / "positive" / "candidate.wav"
            document = json.loads(reviews.read_text(encoding="utf-8"))
            document["reviews"]["transcript"] = {
                "kind": "transcript", "media_path": str(bank_audio), "reviewer": "linguist",
                "answers": {"verdict": "accept", "transcript_ja_verified": "確認済みです"},
            }
            reviews.write_text(json.dumps(document), encoding="utf-8")

            brb.build(reviews, bank)

            exported = json.loads((bank / "positive" / "candidate.json").read_text())
            self.assertEqual(exported["transcript_ja_verified"], "確認済みです")
            self.assertEqual(
                exported["transcript_audio_sha256"],
                hashlib.sha256(bank_audio.read_bytes()).hexdigest(),
            )


if __name__ == "__main__":
    unittest.main()
