import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import tools.voice.cut_anchors as cut_anchors
from tools.voice.cut_anchors import CutError, execute_plan, load_anchors, load_inventory, plan_cuts


class CutAnchorsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.media = self.root / "source.wav"
        with wave.open(str(self.media), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\x00\x00" * 16000 * 2)
        self.inventory = self.root / "inventory.json"
        self.inventory.write_text(json.dumps({"items": [{
            "source_id": "yt-1", "media_path": str(self.media),
            "rights": {"training": "allow", "research_extraction": "allow"},
        }]}), encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def anchors(self, rows):
        path = self.root / "anchors.json"
        canonical = []
        for row in rows:
            row = dict(row)
            if "label" in row and "seed_only" not in row:
                row["seed_only"] = row["label"] == "seed"
            row.setdefault("verdict", "accept")
            row.setdefault("seed_only", False)
            row.setdefault("uncertain", False)
            row.setdefault("speaker", "西奈津美")
            row.setdefault("confidence", 1.0)
            if "start" in row:
                row["start_s"] = row.pop("start")
            if "end" in row:
                row["end_s"] = row.pop("end")
            canonical.append(row)
        path.write_text(json.dumps({"target_speaker": "西奈津美", "anchors": canonical}), encoding="utf-8")
        return path

    def inventory_sources(self):
        return load_inventory(self.inventory)

    def test_default_plan_is_dry_and_does_not_write(self):
        plans = plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
            {"anchor_id": "a1", "source_id": "yt-1", "label": "seed", "start": 0.1, "end": 0.8},
        ])), self.root / "out")
        self.assertFalse((self.root / "out").exists())
        self.assertEqual(plans[0]["output"].name, "yt-1__a1.wav")

    def test_execute_writes_16k_mono_pcm_and_hash_sidecar(self):
        plans = plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
            {"anchor_id": "a1", "source_id": "yt-1", "label": "accept", "start": 0.1, "end": 0.8},
        ])), self.root / "out")
        results = execute_plan(plans)
        output = self.root / "out" / "yt-1__a1.wav"
        sidecar = json.loads((self.root / "out" / "yt-1__a1.json").read_text())
        self.assertEqual(len(results), 1)
        self.assertTrue(output.exists())
        info = subprocess.check_output([
            "ffprobe", "-v", "error", "-show_entries", "stream=sample_rate,channels,codec_name",
            "-of", "json", str(output),
        ], text=True)
        stream = json.loads(info)["streams"][0]
        self.assertEqual(stream, {"codec_name": "pcm_s16le", "sample_rate": "16000", "channels": 1})
        self.assertEqual(sidecar["input_hash"], hashlib.sha256(self.media.read_bytes()).hexdigest())
        self.assertEqual(sidecar["output_hash"], hashlib.sha256(output.read_bytes()).hexdigest())
        self.assertEqual(sidecar["times"]["start_s"], 0.1)
        self.assertEqual(sidecar["training_eligible"], False)
        self.assertEqual(sidecar["training_gate_required"], True)

    def test_unknown_source_is_rejected(self):
        with self.assertRaisesRegex(CutError, "unknown source"):
            plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
                {"anchor_id": "a1", "source_id": "missing", "label": "seed", "start": 0, "end": 1},
            ])), self.root / "out")

    def test_non_seed_accept_is_rejected(self):
        with self.assertRaisesRegex(CutError, "label conflicts"):
            load_anchors(self.anchors([
                {"anchor_id": "a1", "source_id": "yt-1", "label": "candidate", "start": 0, "end": 1},
            ]))

    def test_out_of_bounds_is_rejected(self):
        with self.assertRaisesRegex(CutError, "out of bounds"):
            plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
                {"anchor_id": "a1", "source_id": "yt-1", "label": "seed", "start": 1, "end": 3},
            ])), self.root / "out")

    def test_restricted_rights_allow_seed_only_and_mark_ineligible(self):
        self.inventory.write_text(json.dumps({"items": [{
            "source_id": "yt-1", "media_path": str(self.media),
            "rights": {"training": "deny", "research_extraction": "allow"},
        }]}), encoding="utf-8")
        plans = plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
            {"anchor_id": "a1", "source_id": "yt-1", "label": "seed", "start": 0, "end": 1},
        ])), self.root / "out")
        self.assertFalse(plans[0]["training_eligible"])
        execute_plan(plans)
        self.assertFalse(json.loads((self.root / "out" / "yt-1__a1.json").read_text())["training_eligible"])
        accept_plans = plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
            {"anchor_id": "a2", "source_id": "yt-1", "label": "accept", "start": 0, "end": 1},
        ])), self.root / "out2")
        self.assertFalse(accept_plans[0]["training_eligible"])

    def test_seed_is_never_training_eligible_even_when_source_allows_training(self):
        plans = plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
            {"anchor_id": "a1", "source_id": "yt-1", "label": "seed", "start": 0, "end": 1},
        ])), self.root / "out")
        self.assertFalse(plans[0]["training_eligible"])

    def test_missing_rights_defaults_to_training_denied(self):
        self.inventory.write_text(json.dumps({"items": [{
            "source_id": "yt-1", "media_path": str(self.media),
        }]}), encoding="utf-8")
        with self.assertRaisesRegex(CutError, "research_extraction=deny"):
            plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
                {"anchor_id": "a1", "source_id": "yt-1", "label": "seed", "start": 0, "end": 1},
            ])), self.root / "out")
        with self.assertRaisesRegex(CutError, "research_extraction=deny"):
            plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
                {"anchor_id": "a2", "source_id": "yt-1", "label": "accept", "start": 0, "end": 1},
            ])), self.root / "out2")

    def test_remote_media_path_is_rejected(self):
        self.inventory.write_text(json.dumps({"items": [{
            "source_id": "yt-1", "media_path": "https://example.invalid/a.mp4",
        }]}), encoding="utf-8")
        sources = load_inventory(self.inventory)
        with self.assertRaisesRegex(CutError, "no existing local media_path"):
            plan_cuts(sources, load_anchors(self.anchors([{
                "anchor_id": "a1", "source_id": "yt-1", "label": "seed", "start": 0, "end": 1,
            }])), self.root / "out")

    def test_reviewed_manifest_aliases_make_seed_research_cut_ineligible(self):
        self.inventory.write_text(json.dumps({
            "policy": {"rights": {"training": "deny", "research_extraction": "allow"}},
            "sources": [{"source_id": "yt-1", "media_path": str(self.media)}],
        }), encoding="utf-8")
        anchors = self.anchors([{
            "anchor_id": "a1", "source_id": "yt-1", "verdict": "accept",
            "seed_only": True, "start_s": 0, "end_s": 1,
        }])
        plans = plan_cuts(self.inventory_sources(), load_anchors(anchors), self.root / "out")
        self.assertEqual(plans[0]["label"], "seed")
        self.assertFalse(plans[0]["training_eligible"])

    def test_seed_requires_research_extraction_allow(self):
        self.inventory.write_text(json.dumps({"items": [{
            "source_id": "yt-1", "media_path": str(self.media),
            "rights": {"training": "deny", "research_extraction": "deny"},
        }]}), encoding="utf-8")
        with self.assertRaisesRegex(CutError, "research_extraction=deny"):
            plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
                {"anchor_id": "a1", "source_id": "yt-1", "label": "seed", "start": 0, "end": 1},
            ])), self.root / "out")

    def test_training_allowed_alias_is_rejected(self):
        self.inventory.write_text(json.dumps({"items": [{
            "source_id": "yt-1", "media_path": str(self.media),
            "training_allowed": True,
            "rights": {"training": "allow", "research_extraction": "allow"},
        }]}), encoding="utf-8")
        with self.assertRaisesRegex(CutError, "not canonical"):
            load_inventory(self.inventory)

    def test_metadata_inventory_only_requires_media_for_referenced_source(self):
        self.inventory.write_text(json.dumps({"sources": [
            {"source_id": "yt-1",
             "rights": {"training": "deny", "research_extraction": "allow"}},
            {"source_id": "metadata-only", "url": "https://example.invalid/video",
             "rights": {"training": "deny", "research_extraction": "deny"}},
        ]}), encoding="utf-8")
        overlay = self.root / "local-overlay.json"
        overlay.write_text(json.dumps({"sources": [{
            "source_id": "yt-1", "media_path": str(self.media),
        }]}), encoding="utf-8")
        sources = load_inventory(self.inventory, overlay)
        self.assertIn("metadata-only", sources)
        plan_cuts(sources, load_anchors(self.anchors([
            {"anchor_id": "a1", "source_id": "yt-1", "label": "seed", "start": 0, "end": 1},
        ])), self.root / "out")
        with self.assertRaisesRegex(CutError, "no existing local media_path"):
            plan_cuts(sources, load_anchors(self.anchors([
                {"anchor_id": "a2", "source_id": "metadata-only", "label": "seed", "start": 0, "end": 1},
            ])), self.root / "out2")

    def test_canonical_metadata_config_requires_local_overlay(self):
        repo = Path(__file__).resolve().parents[2]
        inventory = repo / "configs/voice/xibao.sources.json"
        anchors = repo / "configs/voice/xibao.anchors.json"
        sources = load_inventory(inventory)
        reviewed = load_anchors(anchors)
        with self.assertRaisesRegex(CutError, "no existing local media_path"):
            plan_cuts(sources, reviewed, self.root / "out")

    def test_source_sha256_mismatch_is_rejected(self):
        self.inventory.write_text(json.dumps({"items": [{
            "source_id": "yt-1", "media_path": str(self.media),
            "source_sha256": "0" * 64,
            "rights": {"training": "allow", "research_extraction": "allow"},
        }]}), encoding="utf-8")
        with self.assertRaisesRegex(CutError, "sha256"):
            plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
                {"anchor_id": "a1", "source_id": "yt-1", "label": "accept", "start": 0, "end": 1},
            ])), self.root / "out")

    def test_local_overlay_sha256_is_enforced(self):
        self.inventory.write_text(json.dumps({
            "policy": {"rights": {"training": "deny", "research_extraction": "allow"}},
            "sources": [{"source_id": "yt-1"}],
        }), encoding="utf-8")
        overlay = self.root / "overlay.json"
        overlay.write_text(json.dumps({"sources": [{
            "source_id": "yt-1", "media_path": str(self.media), "source_sha256": "0" * 64,
        }]}), encoding="utf-8")
        with self.assertRaisesRegex(CutError, "sha256"):
            plan_cuts(load_inventory(self.inventory, overlay), load_anchors(self.anchors([
                {"anchor_id": "a1", "source_id": "yt-1", "label": "seed", "start": 0, "end": 1},
            ])), self.root / "out")

    def test_local_overlay_cannot_override_canonical_sha256(self):
        canonical_hash = hashlib.sha256(self.media.read_bytes()).hexdigest()
        self.inventory.write_text(json.dumps({"sources": [{
            "source_id": "yt-1", "source_sha256": canonical_hash,
            "rights": {"training": "deny", "research_extraction": "allow"},
        }]}), encoding="utf-8")
        overlay = self.root / "overlay.json"
        overlay.write_text(json.dumps({"sources": [{
            "source_id": "yt-1", "media_path": str(self.media), "source_sha256": "0" * 64,
        }]}), encoding="utf-8")
        with self.assertRaisesRegex(CutError, "conflicts with canonical"):
            load_inventory(self.inventory, overlay)

    def test_execute_rejects_mutated_training_flags(self):
        plans = plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
            {"anchor_id": "a1", "source_id": "yt-1", "label": "accept", "start": 0, "end": 1},
        ])), self.root / "out")
        plans[0]["training_eligible"] = True
        with self.assertRaisesRegex(CutError, "mutated training flags"):
            execute_plan(plans)

    def test_second_replace_failure_restores_existing_pair(self):
        plans = plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
            {"anchor_id": "a1", "source_id": "yt-1", "label": "accept", "start": 0, "end": 1},
        ])), self.root / "out")
        output = plans[0]["output"]
        sidecar = plans[0]["sidecar"]
        output.parent.mkdir(parents=True)
        old_wav = b"old wav"
        old_sidecar = b'{"old": true}\n'
        output.write_bytes(old_wav)
        sidecar.write_bytes(old_sidecar)
        original_replace = cut_anchors.os.replace
        failed = False

        def fail_second(src, dst):
            nonlocal failed
            if Path(dst) == sidecar and not failed:
                failed = True
                raise OSError("injected second replace failure")
            return original_replace(src, dst)

        with mock.patch.object(cut_anchors.os, "replace", side_effect=fail_second):
            with self.assertRaisesRegex(CutError, "atomic output pair replace failed"):
                execute_plan(plans)
        self.assertTrue(failed)
        self.assertEqual(output.read_bytes(), old_wav)
        self.assertEqual(sidecar.read_bytes(), old_sidecar)
        self.assertEqual(list(output.parent.glob(".*.rollback")), [])
        self.assertEqual(list(output.parent.glob(".*.tmp.*")), [])

    def test_second_replace_failure_removes_new_orphan_without_old_pair(self):
        plans = plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
            {"anchor_id": "a1", "source_id": "yt-1", "label": "accept", "start": 0, "end": 1},
        ])), self.root / "out")
        output = plans[0]["output"]
        sidecar = plans[0]["sidecar"]
        original_replace = cut_anchors.os.replace
        failed = False

        def fail_second(src, dst):
            nonlocal failed
            if Path(dst) == sidecar and not failed:
                failed = True
                raise OSError("injected second replace failure")
            return original_replace(src, dst)

        with mock.patch.object(cut_anchors.os, "replace", side_effect=fail_second):
            with self.assertRaisesRegex(CutError, "atomic output pair replace failed"):
                execute_plan(plans)
        self.assertTrue(failed)
        self.assertFalse(output.exists())
        self.assertFalse(sidecar.exists())
        self.assertEqual(list(output.parent.glob(".*.rollback")), [])
        self.assertEqual(list(output.parent.glob(".*.tmp.*")), [])

    def test_uncertain_anchor_is_not_cut(self):
        with self.assertRaisesRegex(CutError, "uncertain"):
            load_anchors(self.anchors([{
                "anchor_id": "a1", "source_id": "yt-1", "label": "accept",
                "start": 0, "end": 1, "uncertain": True,
            }]))

    def test_canonical_anchor_conflicts_fail_closed(self):
        conflicts = [
            {"label": "seed", "seed_only": False},
            {"verdict": "reject"},
            {"uncertain": "false"},
            {"speaker": "other"},
            {"confidence": 1.2},
        ]
        for extra in conflicts:
            with self.subTest(extra=extra):
                row = {"anchor_id": "conflict", "source_id": "yt-1", "label": "accept",
                       "start": 0, "end": 1}
                row.update(extra)
                with self.assertRaises(CutError):
                    load_anchors(self.anchors([row]))

    def test_execute_leaves_no_temp_artifacts(self):
        plans = plan_cuts(self.inventory_sources(), load_anchors(self.anchors([
            {"anchor_id": "a1", "source_id": "yt-1", "label": "accept", "start": 0, "end": 1},
        ])), self.root / "out")
        execute_plan(plans)
        self.assertEqual(list((self.root / "out").glob(".*.tmp.*")), [])

    def test_noncanonical_anchor_fields_are_rejected(self):
        with self.assertRaisesRegex(CutError, "non-canonical"):
            self.anchors([{
                "anchor_id": "a1", "source_id": "yt-1", "verdict": "accept",
                "start_s": 0, "end_s": 1, "speaker": "西奈津美", "confidence": 1,
                "status": "accept",
            }])
            load_anchors(self.root / "anchors.json")


if __name__ == "__main__":
    unittest.main()
