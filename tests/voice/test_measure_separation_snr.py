#!/usr/bin/env python3
import sys
import unittest
from pathlib import Path

import numpy as np


TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import measure_separation_snr as mss  # noqa: E402


class MeasureSeparationSnrTests(unittest.TestCase):
    def test_aligns_time_and_gain_before_measuring_residual(self):
        rng = np.random.default_rng(7)
        vocal = rng.normal(0, 0.1, 16000).astype("float32")
        residual = rng.normal(0, 0.01, 16000).astype("float32")
        raw = np.concatenate([np.zeros(160, dtype="float32"), 0.4 * vocal + residual])
        measured = mss.aligned_snr(raw, vocal, 16000)
        self.assertEqual(measured["lag_samples"], 160)
        self.assertAlmostEqual(measured["gain"], 0.4, places=2)
        self.assertAlmostEqual(measured["snr_db"], 12.0, delta=0.4)

    def test_rejects_silence(self):
        with self.assertRaisesRegex(ValueError, "silent"):
            mss.aligned_snr(np.zeros(10), np.ones(10), 16000)


if __name__ == "__main__":
    unittest.main()
