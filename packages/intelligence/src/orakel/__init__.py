"""
ORAKEL Forecast Engine — ML-driven market prediction and signal fusion.

Provides XGBoost direction prediction, HMM regime detection,
GARCH volatility forecasting, Kalman signal fusion, and funding rate analysis.
"""

from src.orakel.features import FeatureEngine
from src.orakel.xgboost_model import DirectionPredictor
from src.orakel.regime import RegimeDetector
from src.orakel.volatility import VolatilityForecaster
from src.orakel.kalman_fusion import SignalFusion
from src.orakel.funding import FundingCollector

__all__ = [
    "FeatureEngine",
    "DirectionPredictor",
    "RegimeDetector",
    "VolatilityForecaster",
    "SignalFusion",
    "FundingCollector",
]
