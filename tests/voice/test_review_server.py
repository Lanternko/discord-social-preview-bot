#!/usr/bin/env python3
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import review_server as rs  # noqa: E402


class ReviewStoreTests(unittest.TestCase):
    bank_manifest = b'{"positive":8,"negative":20}\n'

    @staticmethod
    def ready_sidecar(**values):
        return {
            "review_ready": True,
            "selection_evidence": {
                "kind": "visual_lipsync_precheck", "character_on_screen": "西奈津美",
                "observer": "fixture", "checked_at": "2026-08-10T00:00:00Z",
                "mouth_motion_observed": True, "single_visible_speaker": True,
                "no_shot_change": True, "frames_per_second": 8,
            },
            "acoustic_precheck": {
                "review_eligible": True,
                "scorer_version": "pilotfish.acoustic_precheck.v1",
                "decision": "ambiguous_human_review",
                "scored_at": "2026-08-10T00:00:00Z",
                "bank_sha256": hashlib.sha256(ReviewStoreTests.bank_manifest).hexdigest(),
                "positive_clips": 8,
                "negative_clips": 20,
                "speaker_probability": 0.45,
                "identity_margin": 0.01,
            },
            **values,
        }

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        (self.root / "reference").mkdir()
        (self.root / "reference" / "gold.wav").write_bytes(b"RIFF fixture")
        (self.root / "candidates").mkdir()
        (self.root / "candidates" / "candidate.wav").write_bytes(b"RIFF candidate")
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(self.ready_sidecar()), encoding="utf-8",
        )
        (self.root / "generations").mkdir()
        (self.root / "generations" / "generated.wav").write_bytes(b"RIFF generated")
        bank_dir = self.root / "calibration" / "review-bank"
        bank_dir.mkdir(parents=True)
        (bank_dir / "manifest.json").write_bytes(self.bank_manifest)
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
        sidecar.write_text(json.dumps(self.ready_sidecar(**{
            "source": "s1-ep05", "speaker": "pending",
            "times": {"start_s": 5.829, "end_s": 14.8},
            "transcript_zh_subtitle": "字幕台詞", "rank": 3,
        })), encoding="utf-8")
        item = self.store.session()["queues"]["identity"][0]
        self.assertEqual(item["source_id"], "s1-ep05")
        self.assertEqual((item["start_s"], item["end_s"]), (5.829, 14.8))
        self.assertEqual(item["transcript"], "字幕台詞")
        self.assertEqual(item["rank"], 3)

    def test_identity_queue_is_sorted_by_rank(self):
        second = self.root / "candidates" / "second.wav"
        second.write_bytes(b"RIFF second")
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(self.ready_sidecar(rank=2)), encoding="utf-8",
        )
        (self.root / "candidates" / "second.json").write_text(
            json.dumps(self.ready_sidecar(rank=1)), encoding="utf-8",
        )
        items = self.store.session()["queues"]["identity"]
        self.assertEqual([item["rank"] for item in items], [1, 2])

    def test_explicit_visual_review_batch_precedes_model_probability(self):
        second = self.root / "candidates" / "second.wav"
        second.write_bytes(b"RIFF second")
        (self.root / "candidates" / "candidate.json").write_text(json.dumps(
            self.ready_sidecar(review_batch=2, speaker_probability=0.99),
        ), encoding="utf-8")
        second.with_suffix(".json").write_text(json.dumps(
            self.ready_sidecar(review_batch=1, speaker_probability=0.70),
        ), encoding="utf-8")
        items = self.store.session()["queues"]["identity"]
        self.assertEqual([item["name"] for item in items], ["second", "candidate"])

    def test_identity_review_is_atomically_upserted(self):
        item = self.store.session()["queues"]["identity"][0]
        record = self.store.save({"kind": "identity", "item_id": item["id"], "answers": {
            "verdict": "target", "overlap": False, "confidence": 5, "notes": "clean",
        }})
        self.assertEqual(record["answers"]["verdict"], "target")
        document = json.loads(self.store.review_path.read_text(encoding="utf-8"))
        self.assertEqual(len(document["reviews"]), 1)
        bank = json.loads((
            self.root / "calibration" / "review-bank" / "manifest.json"
        ).read_text(encoding="utf-8"))
        self.assertEqual(bank["positive"], 1)

    def test_generation_review_requires_complete_scores(self):
        item = self.store.session()["queues"]["generation"][0]
        with self.assertRaisesRegex(ValueError, "likeness"):
            self.store.save({"kind": "generation", "item_id": item["id"], "answers": {
                "verdict": "accept", "naturalness": 5, "artifacts": [], "notes": "",
            }})

    def test_separation_queue_binds_raw_and_vocal_hashes(self):
        raw = self.root / "calibration" / "review-bank" / "positive" / "clip.wav"
        raw.parent.mkdir(parents=True)
        raw.write_bytes(b"RIFF raw")
        generation = self.root / "separation" / "generation-a"
        generation.mkdir(parents=True)
        vocal = generation / "clip.wav"
        vocal.write_bytes(b"RIFF vocal")
        vocal.with_suffix(".json").write_text(json.dumps({
            "review_ready": True, "raw_audio_path": str(raw),
            "raw_audio_sha256": hashlib.sha256(raw.read_bytes()).hexdigest(),
            "vocal_audio_sha256": hashlib.sha256(vocal.read_bytes()).hexdigest(),
            "source_id": "s1-ep05", "transcript_ja_verified": "確認済み",
        }), encoding="utf-8")
        (self.root / "separation" / "current.json").write_text(
            json.dumps({"generation_id": "generation-a"}), encoding="utf-8",
        )
        item = self.store.session()["queues"]["separation"][0]
        self.assertTrue(item["reference_media_url"].startswith("/media/"))
        record = self.store.save({"kind": "separation", "item_id": item["id"], "answers": {
            "verdict": "accept", "voice_intact": 5, "cleanup": 4,
            "artifacts": [], "notes": "clean",
        }})
        self.assertEqual(record["answers"]["voice_intact"], 5)

    def test_transcript_queue_requires_hash_and_nonempty_accepted_text(self):
        audio = self.root / "candidates" / "candidate.wav"
        drafts = self.root / "transcripts" / "asr"
        drafts.mkdir(parents=True)
        (drafts / "candidate.json").write_text(json.dumps({
            "clip_id": "candidate", "audio_path": str(audio.resolve()),
            "audio_sha256": hashlib.sha256(audio.read_bytes()).hexdigest(),
            "source_id": "s1-ep05", "start_s": 1.0, "end_s": 3.0,
            "transcript_zh_subtitle": "中文提示", "transcript_ja_asr": "草稿です",
        }), encoding="utf-8")
        item = self.store.session()["queues"]["transcript"][0]
        with self.assertRaisesRegex(ValueError, "non-empty"):
            self.store.save({"kind": "transcript", "item_id": item["id"], "answers": {
                "verdict": "accept", "transcript_ja_verified": "", "notes": "",
            }})
        record = self.store.save({"kind": "transcript", "item_id": item["id"], "answers": {
            "verdict": "accept", "transcript_ja_verified": "校正版です", "notes": "",
        }})
        self.assertEqual(record["answers"]["transcript_ja_verified"], "校正版です")

    def test_transcript_draft_with_wrong_hash_is_quarantined(self):
        drafts = self.root / "transcripts" / "asr"
        drafts.mkdir(parents=True)
        (drafts / "candidate.json").write_text(json.dumps({
            "audio_path": str((self.root / "candidates" / "candidate.wav").resolve()),
            "audio_sha256": "0" * 64, "transcript_ja_asr": "wrong binding",
        }), encoding="utf-8")
        self.assertEqual(self.store.session()["queues"]["transcript"], [])

    def test_unknown_media_and_extra_fields_fail_closed(self):
        self.store.session()
        with self.assertRaisesRegex(ValueError, "unknown"):
            self.store.save({"kind": "identity", "item_id": "missing", "answers": {}})
        item = self.store.session()["queues"]["identity"][0]
        with self.assertRaisesRegex(ValueError, "invalid"):
            self.store.save({"kind": "identity", "item_id": item["id"], "answers": {
                "verdict": "target", "overlap": False, "confidence": 5, "surprise": True,
            }})

    def test_identity_batches_unlock_ten_and_pause_after_three_clear_others(self):
        for index in range(1, 12):
            path = self.root / "candidates" / f"extra-{index}.wav"
            path.write_bytes(f"RIFF {index}".encode())
            path.with_suffix(".json").write_text(json.dumps(self.ready_sidecar(
                speaker_probability=0.99 - index / 100,
            )), encoding="utf-8")
        session = self.store.session()
        self.assertEqual(len(session["queues"]["identity"]), 10)
        for item in session["queues"]["identity"][:3]:
            self.store.save({"kind": "identity", "item_id": item["id"], "answers": {
                "verdict": "other", "overlap": False, "confidence": 5, "notes": "",
            }})
            if item != session["queues"]["identity"][2]:
                self.assertEqual((
                    self.root / "calibration" / "review-bank" / "manifest.json"
                ).read_bytes(), self.bank_manifest)
        held = self.store.session()
        self.assertEqual(held["queues"]["identity"], [])
        self.assertEqual(held["identity_quarantined_total"], 12)

    def test_unvalidated_candidates_are_quarantined(self):
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps({"review_ready": False}), encoding="utf-8",
        )
        session = self.store.session()
        self.assertEqual(session["queues"]["identity"], [])
        self.assertEqual(session["identity_quarantined_total"], 1)

    def test_bare_review_ready_flag_cannot_bypass_provenance_gate(self):
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps({"review_ready": True}), encoding="utf-8",
        )
        self.assertEqual(self.store.session()["queues"]["identity"], [])

    def test_visual_precheck_without_current_acoustic_precheck_is_quarantined(self):
        sidecar = self.ready_sidecar()
        sidecar.pop("acoustic_precheck")
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(sidecar), encoding="utf-8",
        )
        self.assertEqual(self.store.session()["queues"]["identity"], [])

    def test_acoustic_precheck_requires_sufficient_human_banks(self):
        sidecar = self.ready_sidecar()
        sidecar["acoustic_precheck"]["negative_clips"] = 19
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(sidecar), encoding="utf-8",
        )
        self.assertEqual(self.store.session()["queues"]["identity"], [])

    def test_obvious_acoustic_other_is_not_sent_as_ambiguous(self):
        sidecar = self.ready_sidecar()
        sidecar["acoustic_precheck"]["speaker_probability"] = 0.14
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(sidecar), encoding="utf-8",
        )
        self.assertEqual(self.store.session()["queues"]["identity"], [])

    def test_strong_lipsync_can_surface_visual_acoustic_disagreement(self):
        sidecar = self.ready_sidecar()
        sidecar["selection_evidence"]["kind"] = "visual_lipsync_disagreement"
        sidecar["selection_evidence"]["keyword_trigger"] = {
            "addressed_text": "西同學", "reply_text": "ありがとう",
        }
        sidecar["acoustic_precheck"].update({
            "decision": "visual_acoustic_disagreement",
            "speaker_probability": 0.06,
            "identity_margin": -0.053,
        })
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(sidecar), encoding="utf-8",
        )
        item = self.store.session()["queues"]["identity"][0]
        self.assertEqual(item["selection_kind"], "visual_lipsync_disagreement")

    def test_visual_and_acoustic_agreement_is_still_human_reviewed(self):
        sidecar = self.ready_sidecar()
        sidecar["selection_evidence"]["kind"] = "visual_lipsync_confirmed"
        sidecar["acoustic_precheck"].update({
            "decision": "high_confidence_human_review",
            "speaker_probability": 0.91,
            "identity_margin": 0.08,
        })
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(sidecar), encoding="utf-8",
        )
        item = self.store.session()["queues"]["identity"][0]
        self.assertEqual(item["selection_kind"], "visual_lipsync_confirmed")

    def test_high_acoustic_score_without_confirmed_lipsync_stays_hidden(self):
        sidecar = self.ready_sidecar()
        sidecar["acoustic_precheck"].update({
            "decision": "high_confidence_human_review",
            "speaker_probability": 0.91,
            "identity_margin": 0.08,
        })
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(sidecar), encoding="utf-8",
        )
        self.assertEqual(self.store.session()["queues"]["identity"], [])

    def test_low_acoustic_score_without_disagreement_provenance_stays_hidden(self):
        sidecar = self.ready_sidecar()
        sidecar["acoustic_precheck"].update({
            "decision": "visual_acoustic_disagreement",
            "speaker_probability": 0.06,
            "identity_margin": -0.053,
        })
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(sidecar), encoding="utf-8",
        )
        self.assertEqual(self.store.session()["queues"]["identity"], [])

    def test_static_character_frame_is_not_lipsync_evidence(self):
        sidecar = self.ready_sidecar()
        sidecar["selection_evidence"]["mouth_motion_observed"] = False
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(sidecar), encoding="utf-8",
        )
        self.assertEqual(self.store.session()["queues"]["identity"], [])

    def test_acoustic_precheck_is_invalidated_when_bank_changes(self):
        bank = self.root / "calibration" / "review-bank" / "manifest.json"
        bank.write_bytes(self.bank_manifest + b" ")
        self.assertEqual(self.store.session()["queues"]["identity"], [])

    def test_uncalibrated_retrieval_rank_requires_visual_evidence_and_no_prediction(self):
        sidecar = self.ready_sidecar()
        sidecar["selection_evidence"]["kind"] = "retrieval_human_review"
        sidecar["acoustic_precheck"] = {
            "review_eligible": True,
            "scorer_version": "pilotfish.retrieval_rank.v1",
            "decision": "uncalibrated_retrieval",
            "scored_at": "2026-08-10T00:00:00Z",
            "bank_sha256": hashlib.sha256(self.bank_manifest).hexdigest(),
            "positive_clips": 13,
            "negative_clips": 31,
            "rank_score": 0.41,
            "selection_rank": 1,
        }
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(sidecar), encoding="utf-8",
        )
        item = self.store.session()["queues"]["identity"][0]
        self.assertEqual(item["selection_kind"], "retrieval_human_review")
        self.assertEqual(item["retrieval_rank_score"], 0.41)

        sidecar["acoustic_precheck"]["speaker_probability"] = 0.99
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(sidecar), encoding="utf-8",
        )
        self.assertEqual(self.store.session()["queues"]["identity"], [])

    def test_uncalibrated_retrieval_rank_needs_continuous_visual_provenance(self):
        sidecar = self.ready_sidecar()
        sidecar["selection_evidence"]["kind"] = "retrieval_human_review"
        sidecar["selection_evidence"]["single_visible_speaker"] = False
        sidecar["acoustic_precheck"] = {
            "review_eligible": True,
            "scorer_version": "pilotfish.retrieval_rank.v1",
            "decision": "uncalibrated_retrieval",
            "scored_at": "2026-08-10T00:00:00Z",
            "bank_sha256": hashlib.sha256(self.bank_manifest).hexdigest(),
            "positive_clips": 13,
            "negative_clips": 31,
            "rank_score": 0.41,
            "selection_rank": 1,
        }
        (self.root / "candidates" / "candidate.json").write_text(
            json.dumps(sidecar), encoding="utf-8",
        )
        self.assertEqual(self.store.session()["queues"]["identity"], [])


if __name__ == "__main__":
    unittest.main()
