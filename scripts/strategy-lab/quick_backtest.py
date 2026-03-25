#!/usr/bin/env python3
"""
Quick backtest function for Evolution and AI Brain integration.

Reuses the full QuantGuild backtester from backtest.py but exposes a simple
function interface + CLI with JSON output. No DB writes.

Usage as CLI:
  python3 scripts/strategy-lab/quick_backtest.py BTC/USDC 14
  python3 scripts/strategy-lab/quick_backtest.py BTC/USDC 30 --with-ai

Usage as import:
  from quick_backtest import quick_backtest
  result = quick_backtest("BTC/USDC", days=14)
  result = quick_backtest("BTC/USDC", days=30, with_ai=True)
"""
import json
import os
import sys

import tomlkit

# Ensure backtest.py's directory is importable
sys.path.insert(0, os.path.dirname(__file__))

from backtest import BacktestConfig, DataFetcher, Backtester, MetricsCalculator

# Locate cryonix.toml — Docker (/app/) or host (../../)
_TOML_PATHS = [
    os.path.join(os.path.dirname(__file__), '..', '..', 'cryonix.toml'),  # host
    '/app/cryonix.toml',                                                   # Docker
]


def _load_toml() -> dict:
    """Load and parse cryonix.toml, return full dict."""
    for path in _TOML_PATHS:
        if os.path.isfile(path):
            with open(path) as f:
                return tomlkit.parse(f.read())
    return {}


def _load_toml_defaults() -> dict:
    """Read cryonix.toml and map relevant params to BacktestConfig fields."""
    toml = _load_toml()
    if not toml:
        return {}
    return {
        'min_confidence': toml.get('risk', {}).get('min_confidence', 0.65),
        'trailing_stop_pct': toml.get('exits', {}).get('trailing_stop_pct', 3.0) / 100,
        'trailing_profit_threshold': toml.get('exits', {}).get('trailing_activation_pct', 1.5) / 100,
        'position_size_pct': toml.get('capital', {}).get('max_position_size_pct', 0.25),
        'max_positions': toml.get('limits', {}).get('max_open_positions', 3),
    }


# ---------------------------------------------------------------------------
# Grok AI validation
# ---------------------------------------------------------------------------

_GROK_SYSTEM = """You are a crypto trading risk analyst for backtesting validation.
Evaluate this BUY signal and decide if it should be approved.

Key principles:
- Approve signals with 2+ confirming indicators or 1 strong signal (RSI<30, Bollinger squeeze with volume)
- REJECT if: signal contradicts higher-timeframe trend, weak single-pattern signal, or poor risk-reward
- Be selective — only approve high-conviction setups

Respond with ONLY a JSON object:
{"approve": true/false, "confidence": 0-100, "reasoning": "1 sentence"}"""


def _make_grok_filter(symbol, toml):
    """Create a signal_filter callable that validates via Grok API."""
    import httpx
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', '.env'))

    api_key = os.environ.get('XAI_API_KEY')
    if not api_key:
        print('  [AI] No XAI_API_KEY found, skipping AI validation')
        return None

    ai_cfg = toml.get('ai', {})
    model = ai_cfg.get('model', 'grok-4-1-fast-non-reasoning')
    temperature = float(ai_cfg.get('temperature', 0.1))
    ta_weight = float(ai_cfg.get('ta_weight', 0.6))
    ai_weight = float(ai_cfg.get('ai_weight', 0.4))

    client = httpx.Client(
        base_url='https://api.x.ai/v1',
        headers={'Authorization': f'Bearer {api_key}'},
        timeout=30.0,
    )
    stats = {'approved': 0, 'rejected': 0, 'errors': 0}

    def filter_fn(signal, result):
        """Returns True to keep signal, False to reject."""
        try:
            patterns = result.get('patterns', [])
            pattern_names = [p.get('pattern', '') for p in patterns]
            indicators = result.get('indicators', {})

            user_msg = (
                f"Symbol: {symbol}\n"
                f"Signal: BUY @ confidence {signal.get('confidence', 0):.0%}\n"
                f"Patterns: {', '.join(pattern_names) if pattern_names else 'none'}\n"
                f"RSI: {indicators.get('rsi', 'N/A')}\n"
                f"MACD: {indicators.get('macd', 'N/A')}\n"
                f"ADX: {indicators.get('adx', 'N/A')}\n"
                f"Volume ratio: {indicators.get('volume_ratio', 'N/A')}\n"
                f"Trend: {indicators.get('trend', 'N/A')}"
            )

            body = {
                'model': model,
                'temperature': temperature,
                'max_tokens': 200,
                'messages': [
                    {'role': 'system', 'content': _GROK_SYSTEM},
                    {'role': 'user', 'content': user_msg},
                ],
            }

            resp = client.post('/chat/completions', json=body)
            resp.raise_for_status()
            content = resp.json()['choices'][0]['message']['content']

            # Parse JSON from response (handle markdown code blocks)
            clean = content.strip()
            if clean.startswith('```'):
                clean = clean.split('\n', 1)[1].rsplit('```', 1)[0].strip()
            ai_result = json.loads(clean)

            approved = ai_result.get('approve', True)
            ai_conf = ai_result.get('confidence', 50) / 100.0
            confidence = signal.get('confidence', 0)

            if approved:
                # Blend confidence like live system
                signal['confidence'] = (confidence * ta_weight) + (ai_conf * ai_weight)
                stats['approved'] += 1
            else:
                stats['rejected'] += 1

            return approved

        except Exception:
            stats['errors'] += 1
            return True  # Fail-open in backtest (don't lose signal data)

    filter_fn.stats = stats
    filter_fn.client = client
    return filter_fn


def quick_backtest(symbol: str, days: int = 14, config_overrides: dict = None,
                   with_ai: bool = False) -> dict:
    """
    Run a fast backtest using the QuantGuild engine.
    Reads defaults from cryonix.toml, then applies any overrides.

    Args:
        symbol: Trading pair (e.g. "BTC/USDC")
        days: Lookback period (default 14)
        config_overrides: Optional dict of config params to override.
        with_ai: If True, validate each BUY signal via Grok API (~3 sec/signal).

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
            "ai_approved": int,       # only with --with-ai
            "ai_rejected": int,       # only with --with-ai
            "ai_errors": int,         # only with --with-ai
        }
    """
    # Build config: TOML defaults -> then manual overrides
    cfg = BacktestConfig(symbol=symbol, days=days)
    toml_defaults = _load_toml_defaults()
    for key, value in toml_defaults.items():
        if hasattr(cfg, key):
            setattr(cfg, key, value)
    if config_overrides:
        for key, value in config_overrides.items():
            if hasattr(cfg, key):
                setattr(cfg, key, value)

    # Fetch data
    fetcher = DataFetcher(cfg.symbol, cfg.days, cfg.timeframe)
    data = fetcher.fetch_all()

    if not data.get(cfg.timeframe):
        return _empty_result(symbol, days)

    # Build AI filter if requested
    toml = _load_toml() if with_ai else {}
    signal_filter = _make_grok_filter(symbol, toml) if with_ai else None

    if with_ai and signal_filter:
        print(f'  [AI] Grok validation enabled (model: {toml.get("ai", {}).get("model", "grok-4-1-fast-non-reasoning")})')
    elif with_ai and not signal_filter:
        pass  # Warning already printed by _make_grok_filter

    # Run backtest
    bt = Backtester(cfg, signal_filter=signal_filter)
    trades, equity = bt.run(data)

    if not trades:
        result = _empty_result(symbol, days)
    else:
        metrics = MetricsCalculator.compute(trades, equity, cfg.capital, cfg.days)
        result = {
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

    # Add AI stats if used
    if signal_filter and hasattr(signal_filter, 'stats'):
        s = signal_filter.stats
        result['ai_approved'] = s['approved']
        result['ai_rejected'] = s['rejected']
        result['ai_errors'] = s['errors']
        print(f'  [AI] Results: {s["approved"]} approved, {s["rejected"]} rejected, {s["errors"]} errors')
        signal_filter.client.close()

    return result


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
        print('Usage: quick_backtest.py SYMBOL [DAYS] [--with-ai]', file=sys.stderr)
        sys.exit(1)

    # Parse args — strip flags from positional args
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    use_ai = '--with-ai' in sys.argv

    sym = args[0]
    d = int(args[1]) if len(args) > 1 else 14

    # Redirect stdout to stderr during backtest so progress messages
    # don't corrupt the JSON output that callers parse
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        result = quick_backtest(sym, d, with_ai=use_ai)
    finally:
        sys.stdout = real_stdout

    print(json.dumps(result))
