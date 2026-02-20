"""Tests for QuantGuild signal quality improvements."""
from src.guilds.quant import QuantGuild


def test_quant_guild_basic_analysis(make_ohlcv, make_multi_tf):
    """Smoke test: QuantGuild returns valid analysis on synthetic data."""
    q = QuantGuild()
    ohlcv = make_ohlcv(n=100, base_price=100.0)
    multi_tf = make_multi_tf(trend='flat', base_price=100.0)
    result = q.analyze(ohlcv, 'TEST/USDC', multi_tf_data=multi_tf)
    assert result['status'] == 'success'
    assert result['signal']['action'] in ('BUY', 'SELL', 'HOLD')
