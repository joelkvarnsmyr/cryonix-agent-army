"""
Feature engineering pipeline for ORAKEL forecast models.

Computes technical features from OHLCV data using pandas/numpy only
(no ta-lib dependency). All indicators are implemented from scratch.
"""

import logging

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


class FeatureEngine:
    """Builds ML-ready feature matrices from raw OHLCV data."""

    def build_features(
        self,
        ohlcv_df: pd.DataFrame,
        symbol: str,
        btc_returns: pd.Series | None = None,
    ) -> pd.DataFrame:
        """Build feature DataFrame from OHLCV candle data.

        Args:
            ohlcv_df: DataFrame with columns [timestamp, open, high, low, close, volume].
                      Assumed to be 1h candles, sorted ascending by time.
            symbol: Trading pair symbol (e.g. "BTC/USDC").
            btc_returns: Optional BTC 1h log returns series, index-aligned with ohlcv_df.
                         Used to compute btc_cross_momentum for alt coins.

        Returns:
            Clean DataFrame with computed features, NaN rows dropped.
        """
        df = ohlcv_df.copy()
        logger.info("Building features for %s from %d candles", symbol, len(df))

        if len(df) < 30:
            logger.warning("Insufficient data for %s: %d candles (need >= 30)", symbol, len(df))
            return pd.DataFrame()

        close = df["close"].astype(float)
        high = df["high"].astype(float)
        low = df["low"].astype(float)
        volume = df["volume"].astype(float)

        # -- Log returns over lookback windows (1h candle basis) --
        df["return_1h"] = np.log(close / close.shift(1))
        df["return_4h"] = np.log(close / close.shift(4))
        df["return_24h"] = np.log(close / close.shift(24))

        # -- Volume ratio: current / 20-period SMA --
        vol_sma_20 = volume.rolling(window=20).mean()
        df["volume_ratio"] = volume / vol_sma_20.replace(0, np.nan)

        # -- RSI 14 --
        df["rsi_14"] = self._compute_rsi(close, period=14)

        # -- Bollinger Band %B --
        df["bb_pct"] = self._compute_bb_pct(close, period=20, num_std=2.0)

        # -- ATR as % of price (14-period) --
        atr = self._compute_atr(high, low, close, period=14)
        df["atr_pct"] = atr / close.replace(0, np.nan)

        # -- Realized volatility: rolling std of 1h returns, 20-period --
        df["realized_vol"] = df["return_1h"].rolling(window=20).std()

        # -- Time features --
        if "timestamp" in df.columns:
            ts = pd.to_datetime(df["timestamp"], unit="ms", errors="coerce")
            # Fall back to index if timestamp column is not millisecond epoch
            if ts.isna().all():
                ts = pd.to_datetime(df["timestamp"], errors="coerce")
            df["hour_of_day"] = ts.dt.hour
            df["day_of_week"] = ts.dt.dayofweek
        else:
            df["hour_of_day"] = 0
            df["day_of_week"] = 0
            logger.warning("No timestamp column found for %s, time features set to 0", symbol)

        # -- BTC cross momentum: BTC return over past 4h --
        if btc_returns is not None:
            try:
                btc_aligned = btc_returns.reindex(df.index)
                df["btc_cross_momentum"] = btc_aligned.rolling(window=4).sum()
            except Exception:
                logger.debug("Could not align BTC returns for %s, setting NaN", symbol)
                df["btc_cross_momentum"] = np.nan
        else:
            df["btc_cross_momentum"] = np.nan

        # -- Select only feature columns --
        feature_cols = [
            "return_1h",
            "return_4h",
            "return_24h",
            "volume_ratio",
            "rsi_14",
            "bb_pct",
            "atr_pct",
            "realized_vol",
            "hour_of_day",
            "day_of_week",
            "btc_cross_momentum",
        ]

        result = df[feature_cols].copy()
        initial_len = len(result)
        result = result.dropna()
        dropped = initial_len - len(result)

        logger.info(
            "Features for %s: %d rows (%d dropped for NaN)",
            symbol,
            len(result),
            dropped,
        )
        return result

    @staticmethod
    def _compute_rsi(close: pd.Series, period: int = 14) -> pd.Series:
        """Compute RSI using exponential moving average of gains/losses."""
        delta = close.diff()
        gains = delta.where(delta > 0, 0.0)
        losses = (-delta).where(delta < 0, 0.0)

        avg_gain = gains.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()
        avg_loss = losses.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()

        # Prevent division by zero
        avg_loss = avg_loss.replace(0, np.nan)
        rs = avg_gain / avg_loss
        rsi = 100.0 - (100.0 / (1.0 + rs))

        # Clamp to [1, 99] to avoid extremes
        return rsi.clip(1.0, 99.0)

    @staticmethod
    def _compute_bb_pct(close: pd.Series, period: int = 20, num_std: float = 2.0) -> pd.Series:
        """Compute Bollinger Band %B: (price - lower) / (upper - lower)."""
        sma = close.rolling(window=period).mean()
        std = close.rolling(window=period).std()

        upper = sma + num_std * std
        lower = sma - num_std * std

        band_width = (upper - lower).replace(0, np.nan)
        return (close - lower) / band_width

    @staticmethod
    def _compute_atr(
        high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14
    ) -> pd.Series:
        """Compute Average True Range (ATR) using Wilder's smoothing."""
        prev_close = close.shift(1)
        tr = pd.concat(
            [
                high - low,
                (high - prev_close).abs(),
                (low - prev_close).abs(),
            ],
            axis=1,
        ).max(axis=1)

        return tr.ewm(alpha=1.0 / period, min_periods=period, adjust=False).mean()
