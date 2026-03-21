"""Test Kuramoto coherence for V4 signals."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.vedic.coherence import compute_coherence

def test_all_bullish_high_coherence():
    signals = {"venus_rx": 0, "jup_sat": +15, "mars_rahu": +10,
               "merc_venus": 0, "merc_speed": +8, "venus_speed": +8,
               "retro": +5, "venus_sun": 0, "eclipse": 0, "spread": +5}
    c = compute_coherence(signals)
    assert c.coherence > 0.7, f"All bullish should have high coherence: {c.coherence}"
    assert c.size_multiplier > 1.0

def test_mixed_low_coherence():
    signals = {"venus_rx": -40, "jup_sat": +15, "mars_rahu": +10,
               "merc_venus": -10, "merc_speed": +8, "venus_speed": 0,
               "retro": -5, "venus_sun": -10, "eclipse": -5, "spread": +5}
    c = compute_coherence(signals)
    assert c.coherence < 0.65, f"Mixed signals should have low coherence: {c.coherence}"
    assert c.size_multiplier < 1.15

def test_all_neutral_returns_neutral():
    signals = {"venus_rx": 0, "jup_sat": 0, "mars_rahu": 0,
               "merc_venus": 0, "merc_speed": 0, "venus_speed": 0,
               "retro": 0, "venus_sun": 0, "eclipse": 0, "spread": 0}
    c = compute_coherence(signals)
    assert c.coherence == 0.5, f"All zero should return neutral coherence: {c.coherence}"
    assert c.size_multiplier == 1.0

if __name__ == "__main__":
    test_all_bullish_high_coherence()
    test_mixed_low_coherence()
    test_all_neutral_returns_neutral()
    print("All coherence tests passed!")
