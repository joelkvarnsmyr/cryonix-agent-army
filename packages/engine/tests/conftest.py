import pytest
import pandas as pd
import numpy as np
import sys
import os

# Add engine src to path so imports work
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


@pytest.fixture
def make_ohlcv():
    """Factory for synthetic OHLCV data."""
    def _make(n=100, base_price=100.0, trend='flat', volatility=0.01, volume_base=1000.0):
        timestamps = pd.date_range('2026-01-01', periods=n, freq='15min')
        prices = [base_price]
        for i in range(1, n):
            drift = {'up': 0.001, 'down': -0.001, 'flat': 0.0}[trend]
            noise = np.random.normal(drift, volatility)
            prices.append(prices[-1] * (1 + noise))

        data = []
        for i, ts in enumerate(timestamps):
            p = prices[i]
            h = p * (1 + abs(np.random.normal(0, volatility / 2)))
            l = p * (1 - abs(np.random.normal(0, volatility / 2)))
            o = prices[i - 1] if i > 0 else p
            v = volume_base * (1 + np.random.normal(0, 0.3))
            data.append([int(ts.timestamp() * 1000), o, h, l, p, max(0, v)])
        return data
    return _make


@pytest.fixture
def make_multi_tf(make_ohlcv):
    """Create multi-timeframe data dict with matching trend direction."""
    def _make(trend='flat', base_price=100.0):
        return {
            '1h': make_ohlcv(n=48, base_price=base_price, trend=trend, volatility=0.015),
            '4h': make_ohlcv(n=24, base_price=base_price, trend=trend, volatility=0.02),
            '1d': make_ohlcv(n=14, base_price=base_price, trend=trend, volatility=0.03),
        }
    return _make
