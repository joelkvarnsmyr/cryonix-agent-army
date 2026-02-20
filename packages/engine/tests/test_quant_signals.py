"""Tests for QuantGuild signal quality improvements."""
import numpy as np
from src.guilds.quant import QuantGuild


def test_quant_guild_basic_analysis(make_ohlcv, make_multi_tf):
    """Smoke test: QuantGuild returns valid analysis on synthetic data."""
    q = QuantGuild()
    ohlcv = make_ohlcv(n=100, base_price=100.0)
    multi_tf = make_multi_tf(trend='flat', base_price=100.0)
    result = q.analyze(ohlcv, 'TEST/USDC', multi_tf_data=multi_tf)
    assert result['status'] == 'success'
    assert result['signal']['action'] in ('BUY', 'SELL', 'HOLD')


def _make_htf_data(trend_1h='bullish', trend_4h='bullish', base_price=100.0):
    """Create multi-TF data where 1h/4h have specific trend directions."""
    def _make_tf_ohlcv(n, trend, base):
        drift = {'bullish': 0.003, 'bearish': -0.003, 'neutral': 0.0}[trend]
        prices = [base]
        for i in range(1, n):
            prices.append(prices[-1] * (1 + drift + np.random.normal(0, 0.002)))
        data = []
        for i in range(n):
            p = prices[i]
            data.append([i * 3600000, p * 0.999, p * 1.002, p * 0.998, p, 1000])
        return data

    return {
        '1h': _make_tf_ohlcv(48, trend_1h, base_price),
        '4h': _make_tf_ohlcv(24, trend_4h, base_price),
        '1d': _make_tf_ohlcv(14, 'neutral', base_price),
    }


class TestHTFGate:
    """HTF hard veto: block BUY when 1h+4h are bearish, block SELL when bullish."""

    def test_htf_gate_blocks_buy_in_double_bearish(self):
        q = QuantGuild()
        multi_tf = _make_htf_data(trend_1h='bearish', trend_4h='bearish')
        result = q._passes_htf_gate('BUY', multi_tf)
        assert result['allowed'] is False

    def test_htf_gate_allows_buy_in_double_bullish(self):
        q = QuantGuild()
        multi_tf = _make_htf_data(trend_1h='bullish', trend_4h='bullish')
        result = q._passes_htf_gate('BUY', multi_tf)
        assert result['allowed'] is True
        assert result['confidence_adj'] > 0

    def test_htf_gate_allows_buy_with_single_bearish(self):
        q = QuantGuild()
        multi_tf = _make_htf_data(trend_1h='bullish', trend_4h='bearish')
        result = q._passes_htf_gate('BUY', multi_tf)
        assert result['allowed'] is True
        assert result['confidence_adj'] < 0

    def test_htf_gate_blocks_sell_in_double_bullish(self):
        q = QuantGuild()
        multi_tf = _make_htf_data(trend_1h='bullish', trend_4h='bullish')
        result = q._passes_htf_gate('SELL', multi_tf)
        assert result['allowed'] is False

    def test_htf_gate_returns_neutral_without_data(self):
        q = QuantGuild()
        result = q._passes_htf_gate('BUY', None)
        assert result['allowed'] is True
        assert result['confidence_adj'] == 0
