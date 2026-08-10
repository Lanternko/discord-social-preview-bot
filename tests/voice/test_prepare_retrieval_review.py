import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import prepare_retrieval_review as prepare  # noqa: E402


class PrepareRetrievalReviewTests(unittest.TestCase):
    def test_promotes_only_explicit_ranked_candidates(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "ranked" / "s1-ep07"
            source.mkdir(parents=True)
            slug = "s1-ep07__000612915-000615830"
            (source / f"{slug}.wav").write_bytes(b"wav")
            (source / f"{slug}.json").write_text(json.dumps({
                "source_id": "s1-ep07", "start_s": 612.915, "end_s": 615.83,
                "rank_score": 0.42, "review_ready": False,
            }), encoding="utf-8")
            bank = root / "bank.json"
            bank.write_text(json.dumps({"positive": 13, "negative": 31}), encoding="utf-8")
            evidence = root / "evidence.json"
            evidence.write_text(json.dumps({"candidates": [{
                "source_id": "s1-ep07", "start_s": 612.915, "end_s": 615.83,
            }]}), encoding="utf-8")
            result = prepare.prepare(prepare.parser().parse_args([
                "--source-root", str(root / "ranked"), "--output-root", str(root / "candidates"),
                "--evidence", str(evidence), "--bank-manifest", str(bank),
                "--batch-id", "batch", "--checked-at", "2026-08-10T00:00:00Z",
            ]))
            self.assertEqual(result["prepared"], 1)
            sidecar = json.loads((root / "candidates" / "s1-ep07" / f"{slug}.json").read_text())
            self.assertTrue(sidecar["review_ready"])
            self.assertEqual(sidecar["selection_evidence"]["kind"], "retrieval_human_review")
            self.assertNotIn("speaker_probability", sidecar["acoustic_precheck"])
            self.assertTrue(sidecar["retrieval_only"])


if __name__ == "__main__":
    unittest.main()
