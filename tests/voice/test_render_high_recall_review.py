import tempfile
import wave
from pathlib import Path

from tools.voice.render_high_recall_review import materialize_clips, render


def test_report_is_embedded_without_creating_a_speaker_verdict():
    page = render({
        "schema_version": "pilotfish.high_recall_rescan.v1",
        "per_episode": {"s1-ep01": {}},
        "candidate_count": 1,
        "candidates": [{
            "source_id": "s1-ep01", "start_s": 1.0, "end_s": 2.0,
            "duration_s": 1.0, "lane": "short_reaction_unfiltered",
            "retrieval_score": 0.1, "subtitle_zh": "早安 </script>",
        }],
    })
    assert "早安 <\\/script>" in page
    assert "pending_human_review" not in page
    assert "不是西" in page


def test_materialized_clip_contains_only_requested_span():
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        source = root / "episode.wav"
        with wave.open(str(source), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(1000)
            audio.writeframes(b"\x01\x00" * 3000)
        report = {"candidates": [{
            "source_id": "s1-ep01", "start_s": 1.0, "end_s": 1.5,
            "audio_path": str(source),
        }]}
        materialize_clips(report, root / "clips")
        clip = root / report["candidates"][0]["review_audio_url"]
        with wave.open(str(clip), "rb") as audio:
            assert audio.getnframes() == 500
