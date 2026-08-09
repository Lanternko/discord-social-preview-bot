#!/usr/bin/env python3
import struct
import sys
import tempfile
import unittest
import wave
import math
from pathlib import Path


TOOLS = Path(__file__).resolve().parents[2] / "tools" / "voice"
sys.path.insert(0, str(TOOLS))
import irodori_preflight as ip  # noqa: E402


class IrodoriPreflightTests(unittest.TestCase):
    def test_clean_pcm16_wav_passes_structural_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clean.wav"
            samples = [round(7000 * math.sin(index / 12)) for index in range(48000)]
            with wave.open(str(path), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(48000)
                handle.writeframes(struct.pack(f"<{len(samples)}h", *samples))
            result = ip.inspect_pcm16(path, {
                "sample_rate": 48000, "channels": 1, "max_peak_dbfs": -1.0,
                "max_clip_fraction": 0.001, "min_rms_dbfs": -35.0,
                "max_rms_dbfs": -12.0, "max_near_silence_fraction": 0.35,
            })
            self.assertTrue(result["passed"])
            self.assertEqual(result["metrics"]["duration_s"], 1.0)

    def test_clipped_or_wrong_rate_wav_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "bad.wav"
            samples = [32767] * 16000
            with wave.open(str(path), "wb") as handle:
                handle.setnchannels(1)
                handle.setsampwidth(2)
                handle.setframerate(16000)
                handle.writeframes(struct.pack(f"<{len(samples)}h", *samples))
            result = ip.inspect_pcm16(path, {
                "sample_rate": 48000, "channels": 1, "max_peak_dbfs": -1.0,
                "max_clip_fraction": 0.001, "min_rms_dbfs": -35.0,
                "max_rms_dbfs": -12.0, "max_near_silence_fraction": 0.35,
            })
            self.assertFalse(result["passed"])
            self.assertIn("sample_rate_mismatch", result["reasons"])
            self.assertIn("clipping_detected", result["reasons"])


if __name__ == "__main__":
    unittest.main()
