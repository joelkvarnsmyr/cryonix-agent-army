"""Tests for Bayesian Vedic scoring engine — prior calibration."""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))

import pytest
from src.vedic.bayesian import BayesianVedic


def _make_engine() -> BayesianVedic:
    engine = BayesianVedic()
    engine.initialize_from_research()
    return engine


def _neutral_signals() -> dict:
    """Neutral signal set — no strong directional bias."""
    return {
        "venus_rx": False,
        "mercury_rx": False,
        "n_retrogrades": 1,
        "v4_score": 0,
        "polymarket_crypto_score": 50,
        "jup_sat_tight": False,
        "mars_rahu_tight": False,
        "merc_venus_tight": False,
        "merc_speed_fast": False,
        "venus_speed_fast": False,
        "venus_near_sun": False,
        "eclipse_near": False,
    }


class TestPriorCalibration:
    def test_prior_does_not_dominate(self):
        """With zero real trades, P(up) should be 50-85%, not 99%+."""
        engine = _make_engine()
        prob, details = engine.predict(_neutral_signals())
        assert 0.50 <= prob <= 0.85, (
            f"P(up) = {prob:.4f} with zero trades — prior is too strong"
        )

    def test_trades_shift_posterior(self):
        """5 consecutive losses should drop P(up) meaningfully (below 55%)."""
        engine = _make_engine()
        signals = _neutral_signals()

        for _ in range(5):
            engine.update(signals, won=False)

        prob, details = engine.predict(signals)
        assert prob < 0.55, (
            f"P(up) = {prob:.4f} after 5 losses — posterior not responsive enough"
        )

    def test_venus_rx_stays_bearish(self):
        """Venus Rx should always give P(up) < 40% — strongest bearish signal."""
        engine = _make_engine()
        signals = _neutral_signals()
        signals["venus_rx"] = True

        prob, details = engine.predict(signals)
        assert prob < 0.40, (
            f"P(up) = {prob:.4f} during Venus Rx — should be bearish (<40%)"
        )
