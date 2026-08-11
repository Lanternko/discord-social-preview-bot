from tools.voice.high_recall_rescan import (
    candidate_spans,
    group_sentences,
    overlaps_reviewed,
    reviewed_spans,
    select_lanes,
)


def test_groups_contiguous_subtitles_but_splits_at_real_pause():
    rows = [
        {"start": 1.0, "end": 2.0, "text": "a"},
        {"start": 2.1, "end": 3.0, "text": "b"},
        {"start": 3.5, "end": 4.0, "text": "c"},
    ]
    groups = group_sentences(rows, break_gap=0.35, max_duration=7.0)
    assert [[item["text"] for item in group] for group in groups] == [["a", "b"], ["c"]]


def test_candidate_spans_are_padded_without_crossing_neighbours():
    document = {"sentences": [
        {"start": 1.0, "end": 1.5, "text": "一"},
        {"start": 2.0, "end": 2.5, "text": "二"},
    ]}
    rows = candidate_spans(document, source_id="s1-ep01", min_duration=0.3,
                           max_duration=7.0, break_gap=0.35,
                           head_pad=0.08, tail_pad=0.16)
    assert rows[0]["start_s"] == 0.92
    assert rows[0]["end_s"] == 1.66
    assert rows[1]["start_s"] == 1.92


def test_reviewed_spans_are_removed_by_overlap():
    reviews = {"reviews": {"r": {
        "kind": "identity",
        "media_path": "/tmp/s1-ep02__000010000-000012000.wav",
    }}}
    known = reviewed_spans(reviews)
    assert overlaps_reviewed({"source_id": "s1-ep02", "start_s": 10.5, "end_s": 12.1}, known)
    assert not overlaps_reviewed({"source_id": "s1-ep02", "start_s": 20.0, "end_s": 22.0}, known)


def test_short_lane_bypasses_ecapa_and_spoken_lane_uses_low_threshold():
    rows = [
        {"duration_s": 1.0, "retrieval_score": 0.01},
        {"duration_s": 2.0, "retrieval_score": 0.25},
        {"duration_s": 2.0, "retrieval_score": 0.19},
    ]
    selected = select_lanes(rows, spoken_score=0.2, short_max_duration=1.8)
    assert [row["lane"] for row in selected] == [
        "short_reaction_unfiltered", "spoken_low_threshold",
    ]
    assert all(row["training_eligible"] is False for row in selected)
