#!/usr/bin/env python3
"""
Strategy Comparison Backtester

Runs the same market data through three strategy filters to compare:
  A) Dip Focus Only (current: DIP_BUY, DEEP_VALUE, BOLLINGER only)
  B) Dip Focus + Trend Pass (NEW: + MACD/EMA when ADX >= 30 + HTF bullish)
  C) All Patterns (no filter — baseline)

Usage:
  python3 scripts/strategy-lab/backtest_compare.py --days 30 --capital 40
  python3 scripts/strategy-lab/backtest_compare.py --days 14 --symbols BTC/USDC,SOL/USDC,ETH/USDC
"""
import argparse
import json
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from backtest import (
    BacktestConfig, DataFetcher, Backtester, MetricsCalculator, print_report
)

# Strategy filter definitions
VALUE_PATTERNS = {'DIP_BUY', 'DEEP_VALUE_CRASH', 'BOLLINGER_SQUEEZE'}
TREND_PATTERNS = {'MACD_BULLISH_CROSS', 'EMA_BULLISH_CROSS'}
ADX_THRESHOLD = 30


def filter_dip_only(signal, result):
    """Strategy A: Only allow value/dip patterns."""
    patterns = signal.get('patterns', [])
    return any(p in VALUE_PATTERNS for p in patterns)


def filter_dip_plus_trend(signal, result):
    """Strategy B: Allow dip patterns + trend patterns when ADX >= 30 and HTF bullish."""
    patterns = signal.get('patterns', [])

    # Always allow value patterns
    if any(p in VALUE_PATTERNS for p in patterns):
        return True

    # Allow trend patterns in strong trends
    if any(p in TREND_PATTERNS for p in patterns):
        indicators = result.get('indicators', {})
        htf = result.get('htf_trend', {})
        adx = indicators.get('adx', 0) or 0
        htf_bias = htf.get('bias', '') if isinstance(htf, dict) else ''
        trend_aligned = signal.get('trend_aligned', False)

        if adx >= ADX_THRESHOLD and (htf_bias == 'bullish' or trend_aligned):
            return True

    return False


def filter_all(_signal, _result):
    """Strategy C: No filter — all patterns allowed."""
    return True


STRATEGIES = {
    'A_dip_only': {'filter': filter_dip_only, 'label': 'Dip Focus Only'},
    'B_dip_trend': {'filter': filter_dip_plus_trend, 'label': 'Dip + Trend (ADX≥30)'},
    'C_all': {'filter': filter_all, 'label': 'All Patterns (baseline)'},
}


def run_comparison(symbol: str, days: int, capital: float, timeframe: str):
    """Run all three strategies on the same data for one symbol."""
    config = BacktestConfig(
        symbol=symbol, days=days, timeframe=timeframe, capital=capital,
    )

    print(f'\n{"="*72}')
    print(f'  STRATEGY COMPARISON: {symbol}')
    print(f'  {days}d | {timeframe} | ${capital:.0f} capital')
    print(f'{"="*72}')

    # Fetch data once
    print(f'\n  Fetching data for {symbol}...')
    fetcher = DataFetcher(symbol, days, timeframe)
    data = fetcher.fetch_all()

    results = {}

    for key, strat in STRATEGIES.items():
        print(f'\n  --- Strategy {key[0]}: {strat["label"]} ---')
        bt = Backtester(config, signal_filter=strat['filter'])
        trades, equity = bt.run(data)
        metrics = MetricsCalculator.compute(trades, equity, capital, days)
        metrics['signals_generated'] = bt.signals_generated
        metrics['signals_filtered'] = bt.signals_filtered
        results[key] = {
            'label': strat['label'],
            'metrics': metrics,
            'trades': trades,
        }

        # Brief summary
        m = metrics
        print(f'  Trades: {m["total_trades"]} | WR: {m["win_rate"]}% | '
              f'PnL: ${m["total_pnl"]:+.4f} ({m["total_return_pct"]:+.2f}%) | '
              f'Sharpe: {m["sharpe_ratio"]:.2f}')

    return results


def print_comparison_table(all_results: dict):
    """Print side-by-side comparison across all symbols."""
    print(f'\n\n{"="*90}')
    print(f'  AGGREGATE COMPARISON')
    print(f'{"="*90}')

    # Aggregate per strategy
    agg = {}
    for symbol, sym_results in all_results.items():
        for strat_key, strat_data in sym_results.items():
            if strat_key not in agg:
                agg[strat_key] = {
                    'label': strat_data['label'],
                    'total_trades': 0, 'wins': 0, 'total_pnl': 0.0,
                    'symbols_traded': 0, 'symbols_profitable': 0,
                    'pattern_trades': {},
                }
            m = strat_data['metrics']
            agg[strat_key]['total_trades'] += m['total_trades']
            agg[strat_key]['wins'] += m['winning_trades']
            agg[strat_key]['total_pnl'] += m['total_pnl']
            if m['total_trades'] > 0:
                agg[strat_key]['symbols_traded'] += 1
            if m['total_pnl'] > 0:
                agg[strat_key]['symbols_profitable'] += 1

            # Collect pattern breakdown
            for pat, pdata in m.get('pattern_performance', {}).items():
                if pat not in agg[strat_key]['pattern_trades']:
                    agg[strat_key]['pattern_trades'][pat] = {
                        'trades': 0, 'wins': 0, 'pnl': 0.0
                    }
                agg[strat_key]['pattern_trades'][pat]['trades'] += pdata['trades']
                agg[strat_key]['pattern_trades'][pat]['wins'] += int(
                    pdata['trades'] * pdata['win_rate'] / 100
                )
                agg[strat_key]['pattern_trades'][pat]['pnl'] += pdata['total_pnl']

    # Print comparison
    header = f'  {"Metric":<30}'
    for key in sorted(agg.keys()):
        header += f' | {agg[key]["label"]:<22}'
    print(header)
    print(f'  {"-"*30}' + (' | ' + '-'*22) * len(agg))

    rows = [
        ('Total Trades', lambda a: str(a['total_trades'])),
        ('Win Rate', lambda a: f'{a["wins"]/a["total_trades"]*100:.1f}%' if a['total_trades'] else 'N/A'),
        ('Total PnL', lambda a: f'${a["total_pnl"]:+.4f}'),
        ('Symbols Traded', lambda a: str(a['symbols_traded'])),
        ('Symbols Profitable', lambda a: str(a['symbols_profitable'])),
    ]

    for label, fn in rows:
        row = f'  {label:<30}'
        for key in sorted(agg.keys()):
            row += f' | {fn(agg[key]):<22}'
        print(row)

    # Per-symbol breakdown
    print(f'\n  PER-SYMBOL BREAKDOWN')
    print(f'  {"Symbol":<14}', end='')
    for key in sorted(next(iter(all_results.values())).keys()):
        label = STRATEGIES[key]['label'][:18]
        print(f' | {label:<18}', end='')
    print()
    print(f'  {"-"*14}' + (' | ' + '-'*18) * len(STRATEGIES))

    for symbol in all_results:
        row = f'  {symbol:<14}'
        for key in sorted(all_results[symbol].keys()):
            m = all_results[symbol][key]['metrics']
            if m['total_trades'] == 0:
                row += f' | {"—":>18}'
            else:
                row += f' | {m["total_trades"]}T {m["win_rate"]}%W ${m["total_pnl"]:+.2f}'
                # Pad to 18 chars
                cell = f'{m["total_trades"]}T {m["win_rate"]}%W ${m["total_pnl"]:+.2f}'
                row_end = f' | {cell:<18}'
                row = row[:-len(f' | {cell}')] + row_end
        print(row)

    # Trend pattern performance (most interesting comparison)
    print(f'\n  TREND PATTERN PERFORMANCE (B vs C)')
    for key in ['B_dip_trend', 'C_all']:
        label = agg[key]['label']
        print(f'\n  {label}:')
        for pat in sorted(agg[key]['pattern_trades'].keys()):
            pd_ = agg[key]['pattern_trades'][pat]
            if pd_['trades'] > 0:
                wr = pd_['wins'] / pd_['trades'] * 100
                print(f'    {pat:<35} {pd_["trades"]:>3}T  {wr:>5.1f}%W  ${pd_["pnl"]:>+8.4f}')


def main():
    parser = argparse.ArgumentParser(description='Strategy Comparison Backtester')
    parser.add_argument('--days', type=int, default=30, help='Backtest period (default: 30)')
    parser.add_argument('--capital', type=float, default=40.0, help='Starting capital (default: 40)')
    parser.add_argument('--timeframe', type=str, default='15m', help='Timeframe (default: 15m)')
    parser.add_argument('--symbols', type=str,
                        default='BTC/USDC,ETH/USDC,SOL/USDC,XRP/USDC,AVAX/USDC,LINK/USDC,ADA/USDC,DOT/USDC,NEAR/USDC,SUI/USDC,ATOM/USDC,INJ/USDC,ARB/USDC,UNI/USDC,RENDER/USDC',
                        help='Comma-separated symbols')
    parser.add_argument('--json', action='store_true', help='Output JSON')
    args = parser.parse_args()

    symbols = [s.strip() for s in args.symbols.split(',')]
    all_results = {}

    for symbol in symbols:
        try:
            results = run_comparison(symbol, args.days, args.capital, args.timeframe)
            all_results[symbol] = results
        except Exception as e:
            print(f'\n  ERROR on {symbol}: {e}')
            continue

    if not all_results:
        print('No results.')
        return

    if args.json:
        # JSON output with metrics only
        output = {}
        for symbol, sym_results in all_results.items():
            output[symbol] = {
                key: data['metrics'] for key, data in sym_results.items()
            }
        print(json.dumps(output, indent=2, default=str))
    else:
        print_comparison_table(all_results)


if __name__ == '__main__':
    main()
