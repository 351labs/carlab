#!/usr/bin/env python3
"""Known-signal contracts for the acoustic analyzer. Run via lm-remote."""
import importlib.util
from pathlib import Path
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location("engine_acoustic_analyzer", Path(__file__).with_name("analyze.py"))
analyzer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(analyzer)

RATE = 48000


def sine(frequency, seconds=3, amplitude=0.5):
    return amplitude * np.sin(2 * np.pi * frequency * np.arange(round(RATE * seconds)) / RATE)


def band_fraction(audio, low, high):
    frequency, power, _ = analyzer.welch(audio, RATE)
    selected = (frequency >= 20) & (frequency < 20000)
    return float(np.sum(power[(frequency >= low) & (frequency < high)]) / np.sum(power[selected]))


class KnownSignalTests(unittest.TestCase):
    def test_100_hz_sine_is_in_body_band(self):
        audio = sine(100)
        self.assertGreater(band_fraction(audio, 80, 200), 0.999)
        self.assertLess(band_fraction(audio, 20, 80), 0.001)
        self.assertAlmostEqual(analyzer.db(np.sqrt(np.mean(audio * audio))), -9.03089987, places=6)

    def test_40_hz_sine_is_in_bass_band(self):
        audio = sine(40)
        self.assertGreater(band_fraction(audio, 20, 80), 0.999)
        self.assertLess(band_fraction(audio, 80, 200), 0.001)

    def test_opposite_phase_channels_preserve_recording_power(self):
        mono = sine(100)
        stereo = np.column_stack((mono, -mono))
        self.assertEqual(float(np.max(np.abs(np.mean(stereo, axis=1)))), 0)
        _, mono_power, _ = analyzer.welch(mono, RATE)
        _, stereo_power, _ = analyzer.welch(stereo, RATE)
        np.testing.assert_allclose(stereo_power, mono_power, rtol=1e-12, atol=1e-20)
        self.assertGreater(band_fraction(stereo, 80, 200), 0.999)

    def test_constant_periodic_rms_has_negligible_envelope_variation(self):
        audio = sine(100)[:, None]
        result, _, _ = analyzer.envelope_metrics(audio, RATE)
        self.assertLess(result["active_rms_envelope_cv"], 1e-7)
        self.assertLess(result["relative_envelope_rms"], 1e-7)
        self.assertEqual(result["dip_candidates_count"], 0)

    def test_100_ms_silence_is_an_energy_dip_without_ignition_claim(self):
        audio = sine(100)
        audio[round(0.9 * RATE):round(1.0 * RATE)] = 0
        result, _, _ = analyzer.envelope_metrics(audio[:, None], RATE)
        relevant = [dip for dip in result["dip_candidates"] if 0.89 < dip["start_seconds"] < 0.92]
        self.assertEqual(len(relevant), 1)
        self.assertGreater(relevant[0]["duration_ms"], 70)
        self.assertLess(relevant[0]["duration_ms"], 130)
        self.assertLess(relevant[0]["depth_relative_local_rms_db"], -10)
        self.assertIn("not misfires", result["dip_method"])
        peaks = analyzer.acoustic_peak_metrics(audio[:, None], RATE)
        self.assertIn("No ignition count, RPM or misfire inference", peaks["interpretation"])
        self.assertNotIn("rpm", peaks)
        self.assertNotIn("ignition_count", peaks)


if __name__ == "__main__":
    unittest.main()
