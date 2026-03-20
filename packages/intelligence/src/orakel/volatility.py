"""
GARCH volatility forecaster for ORAKEL forecast engine.

Uses GJR-GARCH(1,1,1) with skewed Student-t innovations to forecast
multi-step-ahead volatility and detect volatility spikes.
"""

import logging

import numpy as np
import pandas as pd
from arch import arch_model

logger = logging.getLogger(__name__)


class VolatilityForecaster:
    """GJR-GARCH based volatility forecaster with position sizing guidance."""

    def fit_and_forecast(self, returns: pd.Series, horizon: int = 5) -> dict:
        """Fit GJR-GARCH(1,1,1) and forecast volatility.

        Args:
            returns: Daily (or hourly) log return series. Must have at least 100 obs.
            horizon: Number of steps ahead to forecast (default 5).

        Returns:
            Dict with predicted_vol, vol_ratio, and spike_warning.
        """
        clean_returns = returns.dropna()

        if len(clean_returns) < 100:
            logger.warning(
                "Insufficient data for GARCH: %d observations (need >= 100)",
                len(clean_returns),
            )
            return self._default_result(horizon)

        # Scale to percentage returns for numerical stability
        scaled = clean_returns * 100.0

        try:
            model = arch_model(
                scaled,
                vol="GARCH",
                p=1,
                o=1,       # GJR asymmetric leverage term
                q=1,
                dist="skewt",
                rescale=False,
            )

            result = model.fit(disp="off", show_warning=False)

            # Multi-step forecast
            forecast = result.forecast(horizon=horizon, reindex=False)
            predicted_variance = forecast.variance.iloc[-1].values

            # Convert back from percentage to decimal
            predicted_vol = np.sqrt(predicted_variance) / 100.0

            # Historical realized volatility (last 20 observations)
            hist_vol = float(clean_returns.tail(20).std())

            # Mean predicted volatility across the horizon
            mean_predicted = float(np.mean(predicted_vol))

            vol_ratio = mean_predicted / hist_vol if hist_vol > 1e-10 else 1.0

            # Spike warning: predicted vol > 2x historical mean vol
            overall_mean_vol = float(clean_returns.std())
            spike_warning = mean_predicted > 2.0 * overall_mean_vol

            output = {
                "predicted_vol": predicted_vol.tolist(),
                "vol_ratio": vol_ratio,
                "spike_warning": spike_warning,
            }

            logger.info(
                "GARCH forecast: vol_ratio=%.2f, spike=%s, horizon=%d",
                vol_ratio,
                spike_warning,
                horizon,
            )
            return output

        except Exception as e:
            logger.error("GARCH fitting failed: %s", e)
            return self._default_result(horizon)

    @staticmethod
    def get_position_scale(vol_ratio: float) -> float:
        """Get position size scaling factor based on volatility ratio.

        Args:
            vol_ratio: Ratio of predicted to historical volatility.

        Returns:
            Scaling multiplier for position sizing:
            - < 0.8: 1.2 (low vol regime, size up slightly)
            - 0.8-1.5: 1.0 (normal)
            - 1.5-2.0: 0.6 (elevated vol, reduce)
            - > 2.0: 0.3 (vol spike, minimal exposure)
        """
        if vol_ratio < 0.8:
            return 1.2
        elif vol_ratio <= 1.5:
            return 1.0
        elif vol_ratio <= 2.0:
            return 0.6
        else:
            return 0.3

    @staticmethod
    def _default_result(horizon: int) -> dict:
        """Return neutral default when GARCH cannot be fitted."""
        return {
            "predicted_vol": [0.0] * horizon,
            "vol_ratio": 1.0,
            "spike_warning": False,
        }
