#!/usr/bin/env python3
import hashlib
import json
import os
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import build_segment_manifest as bsm  # noqa: E402


def inventory(*, rights="allow", research_rights="allow", duration_s=10.0,
              media_path="/media/ep5.wav", source_sha256=None):
    return {
        "schema_version": "test",
        "policy": {"rights": {
            "download": "deny", "training": rights,
            "redistribution": "deny", "research_extraction": research_rights,
        }},
        "sources": [{
            "source_id": "s1-ep05",
            "platform": "youtube",
            "url": "https://example.test/ep5",
            "media_path": media_path,
            "duration_s": duration_s,
            "source_sha256": source_sha256 or ("a" * 64),
            "rights": {
                "download": "deny", "training": rights,
                "redistribution": "deny", "research_extraction": research_rights,
            },
        }],
    }


def anchor(**overrides):
    result = {
        "anchor_id": "a1",
        "source_id": "s1-ep05",
        "start_s": 1.0,
        "end_s": 3.0,
        "speaker": "西奈津美",
        "confidence": 0.95,
        "verdict": "accept",
        "reviewer": "tester",
        "reviewed_at": "2026-08-09T00:00:00+00:00",
        "transcript_ja_verified": "これは確認済みの日本語台詞です",
        "emotion": "calm",
        "uncertain": False,
        "seed_only": False,
        "identity_confirmations": [
            {"reviewer": "identity-a", "verdict": "target", "overlap": False,
             "reviewed_at": "2026-08-09T00:00:00+00:00"},
            {"reviewer": "identity-b", "verdict": "target", "overlap": False,
             "reviewed_at": "2026-08-09T00:01:00+00:00"},
        ],
        "evidence": {"voice_sim": 0.71},
    }
    result.update(overrides)
    return result


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.media_path = Path(self.temp_dir.name) / "ep5.wav"
        self.media_path.write_bytes(b"fixture voice bytes\n")
        self.media_sha256 = hashlib.sha256(self.media_path.read_bytes()).hexdigest()

    def tearDown(self):
        self.temp_dir.cleanup()

    def make_inventory(self, **kwargs):
        kwargs.setdefault("media_path", str(self.media_path))
        kwargs.setdefault("source_sha256", self.media_sha256)
        return inventory(**kwargs)

    def build(self, anchors, *, source_rights="allow", threshold=0.85):
        _, sources = bsm.normalize_inventory(self.make_inventory(rights=source_rights))
        _, normalized = bsm.normalize_anchors({"anchors": anchors})
        return bsm.build_manifests(
            sources,
            normalized,
            target_speaker="西奈津美",
            min_confidence=threshold,
            inventory_digest="inv-hash",
            anchors_digest="anchor-hash",
            inventory_path=str(Path(self.temp_dir.name) / "inventory.json"),
            generated_at="2026-08-09T00:00:00+00:00",
        )

    def test_high_confidence_accept_is_training_eligible(self):
        candidates, manifest = self.build([anchor()])
        item = candidates["candidates"][0]
        self.assertTrue(item["eligible_for_training"])
        self.assertEqual(item["segment_id"], "s1-ep05:a1")
        self.assertEqual(len(manifest["segments"]), 1)
        self.assertEqual(manifest["segments"][0]["reviewer"], "tester")
        self.assertEqual(manifest["segments"][0]["reviewed_at"], "2026-08-09T00:00:00+00:00")
        self.assertEqual(candidates["generation_id"], manifest["generation_id"])
        self.assertEqual(
            manifest["segments"][0]["provenance"]["inventory"]["inventory_sha256"],
            "inv-hash",
        )

    def test_low_confidence_never_enters_training_manifest(self):
        candidates, manifest = self.build([anchor(confidence=0.84)])
        self.assertFalse(candidates["candidates"][0]["eligible_for_training"])
        self.assertIn("confidence_below_threshold", candidates["candidates"][0]["excluded_reasons"])
        self.assertEqual(manifest["segments"], [])

    def test_seed_only_is_never_training_eligible(self):
        candidates, manifest = self.build([anchor(seed_only=True)])
        item = candidates["candidates"][0]
        self.assertFalse(item["eligible_for_training"])
        self.assertIn("seed_only", item["excluded_reasons"])
        self.assertEqual(manifest["segments"], [])

    def test_two_independent_clean_identity_confirmations_are_required(self):
        cases = [
            ([], "identity_confirmations_insufficient"),
            ([{"reviewer": "same", "verdict": "target", "overlap": False,
               "reviewed_at": "now"}] * 2, "identity_confirmations_insufficient"),
            ([{"reviewer": "a", "verdict": "target", "overlap": False, "reviewed_at": "now"},
              {"reviewer": "b", "verdict": "other", "overlap": False, "reviewed_at": "now"}],
             "identity_confirmation_conflict"),
            ([{"reviewer": "a", "verdict": "target", "overlap": False, "reviewed_at": "now"},
              {"reviewer": "b", "verdict": "target", "overlap": True, "reviewed_at": "now"}],
             "speaker_overlap"),
        ]
        for confirmations, reason in cases:
            with self.subTest(reason=reason):
                candidates, manifest = self.build([
                    anchor(identity_confirmations=confirmations)
                ])
                self.assertIn(reason, candidates["candidates"][0]["excluded_reasons"])
                self.assertEqual(manifest["segments"], [])

    def test_default_deny_rights_blocks_training(self):
        _, sources = bsm.normalize_inventory({"sources": [{"source_id": "s1-ep05"}]})
        _, anchors = bsm.normalize_anchors({"anchors": [anchor()]})
        candidates, manifest = bsm.build_manifests(
            sources, anchors, target_speaker="西奈津美", min_confidence=0.85,
            inventory_digest="i", anchors_digest="a", generated_at="now"
        )
        self.assertEqual(sources[0]["rights"]["training"], "deny")
        self.assertIn("rights.training_denied", candidates["candidates"][0]["excluded_reasons"])
        self.assertEqual(manifest["segments"], [])

    def test_non_accept_uncertain_and_speaker_mismatch_are_blocked(self):
        rows = [
            anchor(anchor_id="reject", verdict="reject", start_s=1.0, end_s=3.0),
            anchor(anchor_id="review", verdict="review", start_s=3.0, end_s=5.0),
            anchor(anchor_id="uncertain", uncertain=True, start_s=5.0, end_s=7.0),
            anchor(anchor_id="wrong-speaker", speaker="其他角色", start_s=7.0, end_s=9.0),
        ]
        candidates, manifest = self.build(rows)
        self.assertEqual(len(manifest["segments"]), 0)
        reasons = {item["segment_id"]: item["excluded_reasons"] for item in candidates["candidates"]}
        self.assertIn("verdict_not_accept", reasons["s1-ep05:reject"])
        self.assertIn("uncertain", reasons["s1-ep05:uncertain"])
        self.assertIn("speaker_mismatch", reasons["s1-ep05:wrong-speaker"])

    def test_missing_confidence_is_safe_exclusion(self):
        candidates, manifest = self.build([anchor(confidence=None)])
        self.assertIn("confidence_missing", candidates["candidates"][0]["excluded_reasons"])
        self.assertEqual(manifest["segments"], [])

    def test_hard_gates_preserve_every_missing_reason(self):
        source_cases = [
            ({"media_path": None}, "source.media_path_missing"),
            ({"source_sha256": None}, "source.source_sha256_missing"),
            ({"source_sha256": "bad"}, "source.source_sha256_invalid"),
        ]
        for changes, reason in source_cases:
            with self.subTest(reason=reason):
                inv = self.make_inventory()
                row = inv["sources"][0]
                row.update(changes)
                _, sources = bsm.normalize_inventory(inv)
                _, anchors = bsm.normalize_anchors({"anchors": [anchor()]})
                candidates, manifest = bsm.build_manifests(
                    sources, anchors, target_speaker="西奈津美", min_confidence=0.85,
                    inventory_digest="i", anchors_digest="a", generated_at="now"
                )
                self.assertIn(reason, candidates["candidates"][0]["excluded_reasons"])
                self.assertEqual(manifest["segments"], [])

        anchor_cases = [
            ({"reviewer": None}, "reviewer_missing"),
            ({"reviewed_at": None}, "reviewed_at_missing"),
            ({"transcript_ja_verified": None, "text": "展示文字不能替代"}, "transcript_ja_verified_missing"),
            ({"emotion": None}, "emotion_missing"),
            ({"emotion": "unknown"}, "emotion_unknown"),
        ]
        for changes, reason in anchor_cases:
            with self.subTest(reason=reason):
                candidates, manifest = self.build([anchor(**changes)])
                self.assertIn(reason, candidates["candidates"][0]["excluded_reasons"])
                self.assertEqual(manifest["segments"], [])

    def test_media_probe_rejects_remote_missing_directory_and_hash_mismatch(self):
        cases = [
            ("https://example.invalid/ep5.wav", None, "source.media_path_remote"),
            (str(Path(self.temp_dir.name) / "missing.wav"), None, "source.media_path_not_found"),
            (self.temp_dir.name, None, "source.media_path_not_regular_file"),
            (str(self.media_path), "b" * 64, "source.source_sha256_mismatch"),
        ]
        for media_path, source_sha256, reason in cases:
            with self.subTest(reason=reason):
                inv = self.make_inventory(
                    media_path=media_path,
                    source_sha256=source_sha256 or self.media_sha256,
                )
                _, sources = bsm.normalize_inventory(inv)
                _, anchors = bsm.normalize_anchors({"anchors": [anchor()]})
                candidates, manifest = bsm.build_manifests(
                    sources, anchors, target_speaker="西奈津美", min_confidence=0.85,
                    inventory_digest="i", anchors_digest="a", generated_at="now",
                )
                self.assertIn(reason, candidates["candidates"][0]["excluded_reasons"])
                self.assertEqual(manifest["segments"], [])

    def test_research_extraction_rights_are_required(self):
        candidates, manifest = self.build([anchor()], source_rights="allow")
        self.assertNotIn("rights.research_extraction_denied", candidates["candidates"][0]["excluded_reasons"])
        self.assertEqual(len(manifest["segments"]), 1)

        inv = self.make_inventory(research_rights="deny")
        _, sources = bsm.normalize_inventory(inv)
        _, anchors = bsm.normalize_anchors({"anchors": [anchor()]})
        candidates, manifest = bsm.build_manifests(
            sources, anchors, target_speaker="西奈津美", min_confidence=0.85,
            inventory_digest="i", anchors_digest="a", generated_at="now",
        )
        self.assertIn("rights.research_extraction_denied", candidates["candidates"][0]["excluded_reasons"])
        self.assertEqual(manifest["segments"], [])

    def test_relative_media_path_uses_inventory_parent_and_manifest_is_absolute(self):
        inventory_path = Path(self.temp_dir.name) / "inventory.json"
        inventory_path.write_text("{}", encoding="utf-8")
        inv = self.make_inventory(media_path="ep5.wav")
        _, sources = bsm.normalize_inventory(inv)
        _, anchors = bsm.normalize_anchors({"anchors": [anchor()]})
        _, manifest = bsm.build_manifests(
            sources, anchors, target_speaker="西奈津美", min_confidence=0.85,
            inventory_digest="i", anchors_digest="a",
            inventory_path=str(inventory_path), generated_at="now",
        )
        self.assertEqual(manifest["segments"][0]["media_path"], str(self.media_path.resolve()))
        self.assertTrue(Path(manifest["segments"][0]["media_path"]).is_absolute())

    def test_programmatic_relative_media_path_uses_cwd_without_inventory_path(self):
        original_cwd = os.getcwd()
        try:
            os.chdir(self.temp_dir.name)
            relative_media = Path("ep5.wav")
            relative_media.write_bytes(self.media_path.read_bytes())
            inv = self.make_inventory(
                media_path=str(relative_media), source_sha256=self.media_sha256,
            )
            _, sources = bsm.normalize_inventory(inv)
            _, anchors = bsm.normalize_anchors({"anchors": [anchor()]})
            _, manifest = bsm.build_manifests(
                sources, anchors, target_speaker="西奈津美", min_confidence=0.85,
                inventory_digest="i", anchors_digest="a", generated_at="now",
            )
            expected_media_path = str(relative_media.resolve())
        finally:
            os.chdir(original_cwd)
        self.assertEqual(manifest["segments"][0]["media_path"], expected_media_path)

    def test_formal_manifest_contains_no_null_values(self):
        candidates, manifest = self.build([anchor(text=None)])
        self.assertTrue(candidates["candidates"][0]["eligible_for_training"])

        def assert_no_null(value):
            if isinstance(value, dict):
                for child in value.values():
                    self.assertIsNotNone(child)
                    assert_no_null(child)
            elif isinstance(value, list):
                for child in value:
                    assert_no_null(child)

        assert_no_null(manifest)
        self.assertNotIn("text", manifest["segments"][0])

    def test_generation_id_is_deterministic_and_changes_with_policy_inputs(self):
        first, _ = self.build([anchor()])
        second, _ = self.build([anchor()])
        self.assertEqual(first["generation_id"], second["generation_id"])
        changed, _ = self.build([anchor()], threshold=0.90)
        self.assertNotEqual(first["generation_id"], changed["generation_id"])

    def test_pair_writer_leaves_existing_finals_when_second_stage_fails(self):
        candidates, manifest = self.build([anchor()])
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidates_path = root / "candidates.json"
            manifest_path = root / "manifest.json"
            candidates_path.write_text("old candidates", encoding="utf-8")
            manifest_path.write_text("old manifest", encoding="utf-8")
            original_stage = bsm._stage_json
            calls = 0

            def fail_on_second(path, document):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError("synthetic staging failure")
                return original_stage(path, document)

            with mock.patch.object(bsm, "_stage_json", side_effect=fail_on_second):
                with self.assertRaises(OSError):
                    bsm.write_manifests_pair(candidates_path, manifest_path, candidates, manifest)
            self.assertEqual(candidates_path.read_text(encoding="utf-8"), "old candidates")
            self.assertEqual(manifest_path.read_text(encoding="utf-8"), "old manifest")

    def test_pair_writer_rejects_mismatched_generation_ids(self):
        candidates, manifest = self.build([anchor()])
        manifest["generation_id"] = "different"
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(OSError, "generation_id"):
                bsm.write_manifests_pair(
                    Path(directory) / "candidates.json",
                    Path(directory) / "manifest.json",
                    candidates,
                    manifest,
                )

    def test_unknown_source_and_bad_ranges_fail_strict_validation(self):
        _, normalized = bsm.normalize_anchors({"anchors": [anchor(source_id="missing")]})
        _, sources = bsm.normalize_inventory(self.make_inventory())
        with self.assertRaises(bsm.ValidationError):
            bsm.build_manifests(
                sources, normalized, target_speaker="西奈津美", min_confidence=0.85,
                inventory_digest="i", anchors_digest="a"
            )
        with self.assertRaises(bsm.ValidationError):
            self.build([anchor(start_s=9.0, end_s=11.0)])
        with self.assertRaises(bsm.ValidationError):
            bsm.normalize_anchors({"anchors": [anchor(start_s=2.0, end_s=2.0)]})

    def test_duplicate_ids_and_spans_fail(self):
        with self.assertRaises(bsm.ValidationError):
            bsm.normalize_anchors({"anchors": [anchor(), anchor()]})
        with self.assertRaises(bsm.ValidationError):
            bsm.normalize_anchors({"anchors": [anchor(anchor_id="a2"), anchor(anchor_id="a3")]})

    def test_input_hash_is_sha256_of_raw_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "input.json"
            path.write_bytes(b'{"ok": true}\n')
            expected = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(bsm.sha256_file(path), expected)

    def test_dry_run_does_not_write_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            inv_path = root / "inventory.json"
            anchor_path = root / "anchors.json"
            candidate_path = root / "out" / "candidates.json"
            manifest_path = root / "out" / "manifest.json"
            inv_path.write_text(json.dumps(inventory()), encoding="utf-8")
            anchor_path.write_text(json.dumps({"anchors": [anchor()]}), encoding="utf-8")
            exit_code = bsm.main([
                "--inventory", str(inv_path), "--anchors", str(anchor_path),
                "--candidates-out", str(candidate_path), "--manifest-out", str(manifest_path),
                "--dry-run",
            ])
            self.assertEqual(exit_code, 0)
            self.assertFalse(candidate_path.exists())
            self.assertFalse(manifest_path.exists())

    def test_config_files_contain_required_seed_and_s2_mapping(self):
        app_root = Path(__file__).resolve().parents[2]
        sources = json.loads((app_root / "configs/voice/xibao.sources.json").read_text(encoding="utf-8"))
        anchors = json.loads((app_root / "configs/voice/xibao.anchors.json").read_text(encoding="utf-8"))
        self.assertEqual(len([s for s in sources["sources"] if s["season"] == 1]), 12)
        self.assertEqual(len([s for s in sources["sources"] if s["season"] == 2]), 6)
        s2 = {s["episode"]: s["url"] for s in sources["sources"] if s["season"] == 2}
        s1 = {s["episode"]: s["url"] for s in sources["sources"] if s["season"] == 1}
        self.assertTrue(all(s1.values()))
        self.assertTrue(s1[4].endswith("v=7xDprxciG7k"))
        self.assertTrue(s1[8].endswith("v=11G8oacoLfI"))
        self.assertTrue(s1[12].endswith("v=byAzVN6dkiM"))
        self.assertTrue(s2[13].endswith("sn=49896"))
        self.assertTrue(s2[16].endswith("sn=50320"))
        self.assertEqual(len(anchors["anchors"]), 1)
        seed = anchors["anchors"][0]
        self.assertEqual((seed["start_s"], seed["end_s"]), (3.0, 5.829))
        self.assertTrue(seed["seed_only"])
        ep5 = next(s for s in sources["sources"] if s["source_id"] == "s1-ep05")
        self.assertEqual(ep5["rights"]["research_extraction"], "allow")
        self.assertEqual(ep5["rights"]["training"], "deny")
        self.assertTrue(all(
            source["rights"]["research_extraction"] == "allow"
            for source in sources["sources"] if source["season"] == 1
        ))
        self.assertTrue(all(
            source.get("rights", {}).get("research_extraction", "deny") == "deny"
            for source in sources["sources"] if source["season"] == 2
        ))


if __name__ == "__main__":
    unittest.main()
