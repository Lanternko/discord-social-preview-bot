#!/usr/bin/env python3
"""Rank candidate clips with a classifier trained on the bank, not a centroid threshold.

Cosine distance to a positive centroid does not work here, and the ep06 review
proved it with numbers: of 12 clips the reviewer confirmed as the target, 11 sat
inside the score range of the 36 she rejected (confirmed 0.46-0.84, rejected
0.45-0.82). No threshold separates those.

A discriminative model can use the negatives instead of only the positives, which
is what the hard negatives harvested from that review are for. Validation is
grouped by episode, so the reported AUC is what to expect on an episode the model
has not seen rather than an in-sample number.

The score is still retrieval evidence. It orders a review queue; it is not a
verdict, and it cannot see whether the speaker is on screen.
"""

from __future__ import annotations

import argparse
import glob
import json
from pathlib import Path
from typing import Any

MODEL_ID = "speechbrain/spkrec-ecapa-voxceleb"
SAMPLE_RATE = 16000
SCORER_VERSION = "pilotfish.bank_classifier.v1"


def load_bank(bank_dir: Path, embed) -> tuple[list, list, list]:
    """Embeddings, labels and episode ids for every clip in the review bank."""
    import soundfile as sf
    from scipy.signal import resample_poly

    vectors, labels, groups = [], [], []
    for label, name in ((1, "positive"), (0, "negative")):
        for path in sorted((bank_dir / name).glob("*.wav")):
            samples, rate = sf.read(path, dtype="float32", always_2d=False)
            if samples.ndim > 1:
                samples = samples.mean(axis=1)
            if rate != SAMPLE_RATE:
                samples = resample_poly(samples, SAMPLE_RATE, rate).astype("float32")
            sidecar = path.with_suffix(".json")
            source = "unknown"
            if sidecar.is_file():
                document = json.loads(sidecar.read_text(encoding="utf-8"))
                source = document.get("source_id") or source
            vectors.append(embed(samples).numpy())
            labels.append(label)
            groups.append(source)
    return vectors, labels, groups


def validate(vectors, labels, groups) -> dict[str, Any]:
    """Episode-disjoint cross-validation, so the number means out-of-episode."""
    import numpy as np
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedGroupKFold, cross_val_predict
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    matrix = np.stack(vectors)
    labels = np.asarray(labels)
    groups = np.asarray(groups)
    folds = min(len(set(groups)), 5)
    if folds < 2:
        return {"auc": None, "note": "not enough episodes to validate"}
    pipeline = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0))
    probabilities = cross_val_predict(
        pipeline, matrix, labels,
        cv=StratifiedGroupKFold(n_splits=folds, shuffle=True, random_state=0),
        groups=groups, method="predict_proba")[:, 1]
    positive = probabilities[labels == 1]
    negative = probabilities[labels == 0]
    comparisons = positive[:, None] - negative[None, :]
    auc = float((comparisons > 0).mean() + 0.5 * (comparisons == 0).mean())
    report = {"auc": round(auc, 4), "folds": folds,
              "positives": int((labels == 1).sum()), "negatives": int((labels == 0).sum()),
              "operating_points": []}
    for threshold in (0.5, 0.6, 0.7, 0.8, 0.9):
        report["operating_points"].append({
            "threshold": threshold,
            "recall": round(float((positive >= threshold).mean()), 4),
            "false_positive_rate": round(float((negative >= threshold).mean()), 4),
        })
    return report


def main(argv: list[str] | None = None) -> int:
    import numpy as np
    import soundfile as sf
    import torch
    import torch.nn.functional as functional
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler
    from speechbrain.inference.speaker import EncoderClassifier

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bank-dir", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--turns", nargs="+", required=True, help="segment_turns.py outputs")
    parser.add_argument("--audio", nargs="+", required=True, help="matching 16 kHz wavs")
    parser.add_argument("--out", required=True)
    parser.add_argument("--min-duration", type=float, default=2.0)
    parser.add_argument("--max-duration", type=float, default=7.0)
    parser.add_argument("--min-f0", type=float, default=230.0)
    args = parser.parse_args(argv)

    device = "cuda" if torch.cuda.is_available() else "cpu"
    classifier = EncoderClassifier.from_hparams(
        source=MODEL_ID, savedir=args.model_dir, run_opts={"device": device})

    def embed(chunk):
        tensor = torch.from_numpy(np.ascontiguousarray(chunk)).float().unsqueeze(0).to(device)
        with torch.no_grad():
            vector = classifier.encode_batch(tensor).squeeze()
        return functional.normalize(vector, dim=0).cpu()

    vectors, labels, groups = load_bank(Path(args.bank_dir).resolve(), embed)
    report = validate(vectors, labels, groups)
    print(json.dumps(report, ensure_ascii=False, indent=1))

    model = make_pipeline(StandardScaler(), LogisticRegression(max_iter=2000, C=1.0))
    model.fit(np.stack(vectors), np.asarray(labels))

    scored = []
    for turns_path, audio_path in zip(args.turns, args.audio):
        samples, rate = sf.read(audio_path, dtype="float32", always_2d=False)
        if rate != SAMPLE_RATE:
            raise ValueError(f"expected {SAMPLE_RATE} Hz, got {rate} in {audio_path}")
        document = json.loads(Path(turns_path).read_text(encoding="utf-8"))
        for turn in document["turns"]:
            if turn["exclusions"] or "positive_similarity" not in turn:
                continue
            if not args.min_duration <= turn["duration_s"] <= args.max_duration:
                continue
            if (turn["median_f0_hz"] or 0) < args.min_f0:
                continue
            chunk = samples[int(turn["start_s"] * SAMPLE_RATE):int(turn["end_s"] * SAMPLE_RATE)]
            probability = float(model.predict_proba(embed(chunk).numpy()[None, :])[0, 1])
            scored.append({**{k: v for k, v in turn.items() if k != "embedding"},
                           "audio": str(Path(audio_path).resolve()),
                           "speaker_probability": round(probability, 4)})

    scored.sort(key=lambda row: -row["speaker_probability"])
    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "schema_version": SCORER_VERSION, "validation": report,
        "note": "retrieval evidence only; ranks a review queue and is not a verdict",
        "candidates": scored}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{out}: {len(scored)} candidates scored")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
