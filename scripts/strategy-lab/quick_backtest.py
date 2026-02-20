#!/usr/bin/env python3
"""
Quick backtest function for Evolution and AI Brain integration.

Reuses the full QuantGuild backtester from backtest.py but exposes a simple
function interface + CLI with JSON output. No DB writes.

Usage as CLI:
  python3 scripts/strategy-lab/quick_backtest.py BTC/USDC 14
  python3 scripts/strategy-lab/quick_backtest.py BTC/USDC 14 '{"min_confidence": 0.75}'

Usage as import:
  from quick_backtest import quick_backtest
  result = quick_backtest("BTC/USDC", days=14, config_overrides={"min_confidence": 0.75})
"""
import json
import os
import sys

# Ensure backtest.py's directory is importable
sys.path.insert(0, os.path.dirname(__file__))

from backtest import BacktestConfig, DataFetcher, Backtester, MetricsCalculator


def quick_backtest(symbol: str, days: int = 14, config_overrides: dict = None) -> dict:
    """
    Run a fast backtest using the QuantGuild engine.

    Args:
        symbol: Trading pair (e.g. "BTC/USDC")
        days: Lookback period (default 14)
        config_overrides: Optional dict of config params to override.
            Supported keys: min_confidence, trailing_stop_pct,
            trailing_profit_threshold, position_size_pct, fee_pct,
            max_positions, capital

    Returns:
        {
            "symbol": str,
            "days": int,
            "sharpe_ratio": float,
            "profit_factor": float,
            "win_rate": float,
            "total_return_pct": float,
            "max_drawdown_pct": float,
            "total_trades": int,
            "expectancy": float,
        }
    """
    # Build config with overrides
    cfg = BacktestConfig(symbol=symbol, days=days)
    if config_overrides:
        for key, value in config_overrides.items():
            if hasattr(cfg, key):
                setattr(cfg, key, value)

    # Fetch data
    fetcher = DataFetcher(cfg.symbol, cfg.days, cfg.timeframe)
    data = fetcher.fetch_all()

    if not data.get(cfg.timeframe):
        return _empty_result(symbol, days)

    # Run backtest
    bt = Backtester(cfg)
    trades, equity = bt.run(data)

    if not trades:
        return _empty_result(symbol, days)

    # Compute metrics
    metrics = MetricsCalculator.compute(trades, equity, cfg.capital, cfg.days)

    return {
        'symbol': symbol,
        'days': days,
        'sharpe_ratio': metrics['sharpe_ratio'],
        'profit_factor': metrics['profit_factor'],
        'win_rate': metrics['win_rate'],
        'total_return_pct': metrics['total_return_pct'],
        'max_drawdown_pct': metrics['max_drawdown_pct'],
        'total_trades': metrics['total_trades'],
        'expectancy': metrics['expectancy'],
    }


def _empty_result(symbol: str, days: int) -> dict:
    return {
        'symbol': symbol,
        'days': days,
        'sharpe_ratio': 0.0,
        'profit_factor': 0.0,
        'win_rate': 0.0,
        'total_return_pct': 0.0,
        'max_drawdown_pct': 0.0,
        'total_trades': 0,
        'expectancy': 0.0,
    }


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: quick_backtest.py SYMBOL [DAYS] [CONFIG_JSON]', file=sys.stderr)
        sys.exit(1)

    sym = sys.argv[1]
    d = int(sys.argv[2]) if len(sys.argv) > 2 else 14
    overrides = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None

    # Redirect stdout to stderr during backtest so progress messages
    # don't corrupt the JSON output that callers parse
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        result = quick_backtest(sym, d, overrides)
    finally:
        sys.stdout = real_stdout

    print(json.dumps(result))
