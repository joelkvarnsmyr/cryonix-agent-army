"""Tests for QuantGuild signal quality improvements."""
import numpy as np
import pandas as pd
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


class TestMultiTFConfirmation:
    """Patterns must be confirmed on higher timeframes."""

    def test_rsi_oversold_rejected_without_1h_confirmation(self):
        """RSI < 30 on 15m but 1h RSI = 55 -> pattern should NOT fire."""
        q = QuantGuild()
        indicators = {'rsi': 28, 'price': 100}
        htf_indicators = {'1h': {'rsi': 55}}
        result = q._detect_rsi_extreme(indicators, htf_indicators=htf_indicators)
        assert result is None

    def test_rsi_oversold_confirmed_with_1h(self):
        """RSI < 30 on 15m AND 1h RSI < 40 -> pattern fires."""
        q = QuantGuild()
        indicators = {'rsi': 28}
        htf_indicators = {'1h': {'rsi': 35}}
        result = q._detect_rsi_extreme(indicators, htf_indicators=htf_indicators)
        assert result is not None
        assert result['action'] == 'BUY'

    def test_rsi_threshold_is_30_not_35(self):
        """RSI oversold threshold should be 30 (was 35)."""
        q = QuantGuild()
        indicators = {'rsi': 32}
        htf_indicators = {'1h': {'rsi': 30}}
        result = q._detect_rsi_extreme(indicators, htf_indicators=htf_indicators)
        assert result is None  # 32 > 30, no trigger

    def test_rsi_without_htf_data_still_works(self):
        """RSI oversold should still work without HTF data (backwards compat)."""
        q = QuantGuild()
        indicators = {'rsi': 25}
        result = q._detect_rsi_extreme(indicators)
        assert result is not None
        assert result['action'] == 'BUY'


class TestRegimeGate:
    """Regime-gated pattern selection: right patterns for right market conditions."""

    def test_rsi_blocked_in_trending(self):
        q = QuantGuild()
        patterns = [{'pattern': 'RSI_OVERSOLD', 'action': 'BUY', 'confidence': 0.80}]
        filtered = q._filter_by_regime(patterns, 'trending', ema21=100, price=95)
        assert len(filtered) == 0

    def test_ema_cross_blocked_in_ranging(self):
        q = QuantGuild()
        patterns = [{'pattern': 'EMA_BULLISH_CROSS', 'action': 'BUY', 'confidence': 0.65}]
        filtered = q._filter_by_regime(patterns, 'ranging', ema21=100, price=102)
        assert len(filtered) == 0

    def test_rsi_allowed_in_ranging(self):
        q = QuantGuild()
        patterns = [{'pattern': 'RSI_OVERSOLD', 'action': 'BUY', 'confidence': 0.80}]
        filtered = q._filter_by_regime(patterns, 'ranging', ema21=100, price=95)
        assert len(filtered) == 1

    def test_ema_cross_allowed_in_trending(self):
        q = QuantGuild()
        patterns = [{'pattern': 'EMA_BULLISH_CROSS', 'action': 'BUY', 'confidence': 0.65}]
        filtered = q._filter_by_regime(patterns, 'trending', ema21=100, price=102)
        assert len(filtered) == 1

    def test_volatile_blocks_everything_except_deep_value_and_volume(self):
        q = QuantGuild()
        patterns = [
            {'pattern': 'RSI_OVERSOLD', 'action': 'BUY', 'confidence': 0.80},
            {'pattern': 'VOLUME_SPIKE_UP', 'action': 'BUY', 'confidence': 0.75},
            {'pattern': 'DEEP_VALUE_CRASH', 'action': 'BUY', 'confidence': 0.82},
        ]
        filtered = q._filter_by_regime(patterns, 'volatile', ema21=100, price=95)
        assert len(filtered) == 2
        names = [p['pattern'] for p in filtered]
        assert 'RSI_OVERSOLD' not in names

    def test_dip_buy_in_trending_only_if_uptrend(self):
        q = QuantGuild()
        patterns = [{'pattern': 'DIP_BUY', 'action': 'BUY', 'confidence': 0.78}]
        # Price > EMA21 = uptrend -> allowed
        filtered = q._filter_by_regime(patterns, 'trending', ema21=100, price=102)
        assert len(filtered) == 1
        # Price < EMA21 = downtrend -> blocked
        filtered = q._filter_by_regime(patterns, 'trending', ema21=100, price=95)
        assert len(filtered) == 0


class TestMomentumGainerFix:
    """MOMENTUM_GAINER must go through consensus gate, not bypass it."""

    def test_momentum_gainer_alone_does_not_produce_buy(self):
        """If only MOMENTUM_GAINER fires, signal should be HOLD (consensus needs 2+)."""
        q = QuantGuild()
        patterns = [{'pattern': 'MOMENTUM_GAINER', 'action': 'BUY', 'confidence': 0.80}]
        indicators = {
            'price': 100, 'atr': 2.0, 'bb_mid': 100, 'volume_ratio': 2.0,
            'market_regime': 'trending', 'ema21': 98, 'adx': 30,
            'plus_di': 25, 'minus_di': 15,
        }
        signal = q._generate_signal(patterns, indicators, pd.DataFrame({'close': [100]}))
        assert signal['action'] == 'HOLD'


class TestIntegration:
    """Full pipeline integration: signal goes through all gates."""

    def test_full_pipeline_bearish_htf_blocks_buy(self, make_ohlcv):
        """A BUY pattern in bearish HTF should be blocked entirely."""
        q = QuantGuild()
        ohlcv = make_ohlcv(n=100, base_price=100.0, trend='flat')
        multi_tf = _make_htf_data(trend_1h='bearish', trend_4h='bearish')
        result = q.analyze(ohlcv, 'TEST/USDC', multi_tf_data=multi_tf)
        # Even if 15m patterns fire, HTF gate should block BUY
        assert result['signal']['action'] != 'BUY' or \
            result['signal'].get('is_deep_value', False), \
            f"BUY signal passed HTF gate in bearish HTF: {result['signal']}"

    def test_full_pipeline_ranging_blocks_trend_patterns(self, make_ohlcv, make_multi_tf):
        """In ranging market, trend-following patterns should be filtered."""
        q = QuantGuild()
        ohlcv = make_ohlcv(n=100, base_price=100.0, trend='flat', volatility=0.005)
        multi_tf = make_multi_tf(trend='flat')
        result = q.analyze(ohlcv, 'TEST/USDC', multi_tf_data=multi_tf)
        if result['signal']['action'] in ('BUY', 'SELL'):
            patterns = result['signal'].get('patterns', [])
            trend_patterns = {'EMA_BULLISH_CROSS', 'EMA_BEARISH_CROSS',
                              'MACD_BULLISH_CROSS', 'MACD_BEARISH_CROSS'}
            for p in patterns:
                assert p not in trend_patterns, \
                    f"Trend pattern {p} passed regime gate in ranging market"

    def test_all_gates_produce_hold_on_noisy_data(self, make_ohlcv, make_multi_tf):
        """Noisy flat data with bearish HTF should not produce signals."""
        q = QuantGuild()
        np.random.seed(42)
        ohlcv = make_ohlcv(n=100, base_price=100.0, trend='flat', volatility=0.005)
        multi_tf = _make_htf_data(trend_1h='bearish', trend_4h='bearish')
        result = q.analyze(ohlcv, 'TEST/USDC', multi_tf_data=multi_tf)
        # With bearish HTF + flat 15m, signal should be HOLD
        assert result['signal']['action'] == 'HOLD'
