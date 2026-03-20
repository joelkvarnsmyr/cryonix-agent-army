"""
HMM regime detection for ORAKEL forecast engine.

Uses a 3-state Gaussian HMM to classify the market as bull, bear,
or sideways based on returns and realized volatility.
"""

import logging

import numpy as np
import pandas as pd
from hmmlearn.hmm import GaussianHMM

logger = logging.getLogger(__name__)


class RegimeDetector:
    """Hidden Markov Model based market regime detector (3 states)."""

    N_COMPONENTS = 3
    N_ITER = 1000
    COVARIANCE_TYPE = "full"

    def __init__(self) -> None:
        self.model: GaussianHMM | None = None
        self._label_map: dict[int, str] = {}
        self._is_fitted = False

    def fit(self, returns: pd.Series, volatility: pd.Series) -> None:
        """Fit HMM on historical return + volatility data.

        Args:
            returns: Daily log returns (e.g. BTC).
            volatility: 20-day rolling realized volatility.
        """
        # Align and clean
        data = pd.DataFrame({"returns": returns, "volatility": volatility}).dropna()

        if len(data) < 60:
            raise ValueError(f"Need at least 60 observations, got {len(data)}")

        X = data.values
        logger.info("Fitting HMM on %d observations", len(X))

        self.model = GaussianHMM(
            n_components=self.N_COMPONENTS,
            covariance_type=self.COVARIANCE_TYPE,
            n_iter=self.N_ITER,
            random_state=42,
        )
        self.model.fit(X)

        # Label states post-hoc by mean return
        means = self.model.means_[:, 0]  # Return component
        sorted_indices = np.argsort(means)

        self._label_map = {
            int(sorted_indices[0]): "bear",
            int(sorted_indices[1]): "sideways",
            int(sorted_indices[2]): "bull",
        }
        self._is_fitted = True

        logger.info(
            "HMM fitted. State means (return): %s, label map: %s",
            {self._label_map[i]: f"{means[i]:.4f}" for i in range(self.N_COMPONENTS)},
            self._label_map,
        )

    def detect(self, returns: pd.Series, volatility: pd.Series) -> dict:
        """Detect current market regime.

        Args:
            returns: Recent daily log returns.
            volatility: Recent 20-day rolling realized volatility.

        Returns:
            Dict with regime, probabilities, transition_risk, and regime_age_days.
        """
        if not self._is_fitted or self.model is None:
            logger.warning("HMM not fitted, returning default sideways regime")
            return {
                "regime": "sideways",
                "probabilities": {"bull": 0.33, "bear": 0.33, "sideways": 0.34},
                "transition_risk": 0.33,
                "regime_age_days": 0,
            }

        data = pd.DataFrame({"returns": returns, "volatility": volatility}).dropna()
        if len(data) < 2:
            logger.warning("Insufficient data for regime detection")
            return {
                "regime": "sideways",
                "probabilities": {"bull": 0.33, "bear": 0.33, "sideways": 0.34},
                "transition_risk": 0.33,
                "regime_age_days": 0,
            }

        X = data.values

        # Decode most likely state sequence
        try:
            state_sequence = self.model.predict(X)
            state_probs = self.model.predict_proba(X)
        except Exception as e:
            logger.error("HMM prediction failed: %s", e)
            return {
                "regime": "sideways",
                "probabilities": {"bull": 0.33, "bear": 0.33, "sideways": 0.34},
                "transition_risk": 0.33,
                "regime_age_days": 0,
            }

        current_state = int(state_sequence[-1])
        current_regime = self._label_map.get(current_state, "sideways")

        # Build probability dict from last observation
        last_probs = state_probs[-1]
        probabilities = {}
        for state_idx in range(self.N_COMPONENTS):
            label = self._label_map.get(state_idx, f"state_{state_idx}")
            probabilities[label] = float(last_probs[state_idx])

        # Transition risk: P(current_state -> bear) from transition matrix
        bear_state = None
        for state_idx, label in self._label_map.items():
            if label == "bear":
                bear_state = state_idx
                break
        transition_risk = float(
            self.model.transmat_[current_state, bear_state]
        ) if bear_state is not None else 0.33

        # Regime age: how many consecutive days the current state has persisted
        regime_age = 0
        for s in reversed(state_sequence):
            if int(s) == current_state:
                regime_age += 1
            else:
                break

        result = {
            "regime": current_regime,
            "probabilities": probabilities,
            "transition_risk": transition_risk,
            "regime_age_days": regime_age,
        }

        logger.info(
            "Regime: %s (age=%d days, bear_risk=%.3f)",
            current_regime,
            regime_age,
            transition_risk,
        )
        return result

    def get_position_multiplier(self) -> float:
        """Get position sizing multiplier based on current regime.

        Returns:
            1.0 for bull, 0.6 for sideways, 0.25 for bear.
            Defaults to 0.6 (sideways) if not fitted or unknown.
        """
        if not self._is_fitted or self.model is None:
            return 0.6

        try:
            # Use stored model state — last predicted state
            # Caller should call detect() first to ensure model has latest data
            # We use the last computed state from the most recent detect() call
            return self._regime_multiplier_map().get(
                self._last_regime if hasattr(self, "_last_regime") else "sideways",
                0.6,
            )
        except Exception:
            return 0.6

    @staticmethod
    def _regime_multiplier_map() -> dict[str, float]:
        return {
            "bull": 1.0,
            "sideways": 0.6,
            "bear": 0.25,
        }

    def detect_and_update(self, returns: pd.Series, volatility: pd.Series) -> dict:
        """Convenience method: detect regime and cache for get_position_multiplier."""
        result = self.detect(returns, volatility)
        self._last_regime = result["regime"]
        return result
