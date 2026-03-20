"""
Kalman filter for multi-source signal fusion in ORAKEL.

Fuses noisy confidence readings from multiple signal sources (QuantGuild,
GROK AI, XGBoost, Fear & Greed, Polymarket, funding, regime) into a
single filtered confidence estimate.
"""

import logging

import numpy as np
from filterpy.kalman import KalmanFilter

logger = logging.getLogger(__name__)


# Default reliability weights per signal source.
# Higher = more trusted (lower measurement noise).
SOURCE_RELIABILITY: dict[str, float] = {
    "quantguild": 0.7,
    "grok_ai": 0.8,
    "xgboost": 0.75,
    "fear_greed": 0.4,
    "polymarket": 0.5,
    "funding": 0.6,
    "regime": 0.65,
}


class SignalFusion:
    """Kalman filter based multi-source signal fusion.

    State vector: [true_confidence, confidence_velocity] (2D).
    Each signal source provides a noisy 1D measurement of true_confidence.
    """

    def __init__(self) -> None:
        self._kf = self._init_filter()

    def _init_filter(self) -> KalmanFilter:
        """Initialize a 2D Kalman filter for confidence tracking."""
        kf = KalmanFilter(dim_x=2, dim_z=1)

        # State transition: random walk with velocity
        kf.F = np.array([
            [1.0, 1.0],
            [0.0, 1.0],
        ])

        # Measurement matrix: observe true_confidence only
        kf.H = np.array([[1.0, 0.0]])

        # Measurement noise (default, adapted per source)
        kf.R = np.array([[0.1]])

        # Process noise (small — confidence changes slowly)
        kf.Q = np.array([
            [0.01, 0.0],
            [0.0, 0.01],
        ])

        # Initial state uncertainty
        kf.P = np.array([
            [1.0, 0.0],
            [0.0, 1.0],
        ])

        # Initial state: neutral confidence, zero velocity
        kf.x = np.array([[0.5], [0.0]])

        return kf

    def update(self, measurement: float, source_reliability: float = 1.0) -> float:
        """Process a single measurement through the Kalman filter.

        Args:
            measurement: Noisy confidence reading (0.0 to 1.0).
            source_reliability: How reliable this source is (0.0 to 1.0).
                Higher reliability = lower measurement noise.

        Returns:
            Filtered confidence estimate after incorporating this measurement.
        """
        # Adapt measurement noise based on source reliability
        # reliability=1.0 -> R=0.01 (very trusted)
        # reliability=0.1 -> R=1.0 (very noisy)
        r_value = max(0.01, 0.1 / (source_reliability + 1e-8))
        self._kf.R = np.array([[r_value]])

        # Predict then update
        self._kf.predict()
        self._kf.update(np.array([[measurement]]))

        filtered = float(self._kf.x[0, 0])
        return filtered

    def fuse_signals(self, signals: dict[str, tuple[float, float]]) -> float:
        """Fuse multiple signal sources into a single confidence estimate.

        Args:
            signals: {source_name: (value, reliability)}.
                value: confidence/score from that source (0.0 to 1.0).
                reliability: how much to trust it (0.0 to 1.0).
                If reliability is not provided per-signal, uses SOURCE_RELIABILITY defaults.

        Returns:
            Fused confidence score, clamped to [0.0, 0.95].
        """
        if not signals:
            logger.warning("No signals provided for fusion")
            return 0.5

        # Reset filter for fresh fusion
        self.reset()

        processed = 0
        for source_name, (value, reliability) in signals.items():
            # Use default reliability if the provided one is zero or missing
            if reliability <= 0:
                reliability = SOURCE_RELIABILITY.get(source_name, 0.5)

            self.update(value, reliability)
            processed += 1

        fused = float(self._kf.x[0, 0])

        # Clamp to valid range
        fused = max(0.0, min(0.95, fused))

        logger.debug(
            "Fused %d signals -> confidence=%.3f (sources: %s)",
            processed,
            fused,
            list(signals.keys()),
        )
        return fused

    def reset(self) -> None:
        """Reset filter state for a new symbol or fusion pass."""
        self._kf = self._init_filter()
