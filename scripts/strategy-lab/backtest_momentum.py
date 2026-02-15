#!/usr/bin/env python3
"""
Strategy Lab: Momentum Gainer Backtest

Backtests the MOMENTUM_GAINER strategy against historical trade data:
"If we had bought every coin that hit +X% in GainerScanner with RSI confirmation,
what would our P&L have been?"

Uses scanner:history (if available) and trades table to simulate.

Usage:
  python3 scripts/strategy-lab/backtest_momentum.py [--threshold 3.0] [--days 7]
"""
import argparse
import json
import sys
import os
from datetime import datetime, timezone

import pandas as pd
from tabulate import tabulate

sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg, get_redis


def fetch_all_trades(pg, days: int) -> pd.DataFrame:
    """Fetch all trades (open + closed) to understand what we traded."""
    cur = pg.cursor()
    cur.execute("""
        SELECT
            id, symbol, side, pattern, confidence,
            entry_price, exit_price, pnl,
            reasoning, timestamp, status
        FROM trades
        WHERE timestamp > NOW() - INTERVAL '%s days'
        ORDER BY timestamp
    """ % int(days))
    columns = [desc[0] for desc in cur.description]
    rows = cur.fetchall()
    cur.close()
    return pd.DataFrame(rows, columns=columns)


def analyze_momentum_trades(df: pd.DataFrame) -> dict:
    """Analyze trades that had GainerScanner involvement."""
    if df.empty:
        return {}

    df = df.copy()
    df['pnl_f'] = df['pnl'].apply(lambda x: float(x) if x is not None else 0)

    # Trades with momentum/gainer patterns
    momentum_mask = df['pattern'].str.contains('MOMENTUM_GAINER', na=False, case=False)
    # Trades with volume spike (often correlated with momentum)
    volume_mask = df['pattern'].str.contains('VOLUME_SPIKE', na=False, case=False)
    # Trades where GainerScanner boost was applied (check reasoning)
    scanner_mask = df['reasoning'].str.contains('GainerScanner|top mover', na=False, case=False)

    combined_mask = momentum_mask | scanner_mask

    momentum_trades = df[combined_mask]
    other_trades = df[~combined_mask]

    return {
        'momentum': {
            'total': len(momentum_trades),
            'closed': len(momentum_trades[momentum_trades['status'] == 'CLOSED']),
            'open': len(momentum_trades[momentum_trades['status'] == 'FILLED']),
            'wins': int((momentum_trades['pnl_f'] > 0).sum()),
            'losses': int((momentum_trades['pnl_f'] < 0).sum()),
            'total_pnl': round(float(momentum_trades[momentum_trades['status'] == 'CLOSED']['pnl_f'].sum()), 4),
            'symbols': momentum_trades['symbol'].unique().tolist(),
        },
        'other': {
            'total': len(other_trades),
            'closed': len(other_trades[other_trades['status'] == 'CLOSED']),
            'wins': int((other_trades[other_trades['status'] == 'CLOSED']['pnl_f'] > 0).sum()),
            'losses': int((other_trades[other_trades['status'] == 'CLOSED']['pnl_f'] < 0).sum()),
            'total_pnl': round(float(other_trades[other_trades['status'] == 'CLOSED']['pnl_f'].sum()), 4),
        },
        'volume_spike': {
            'total': int(volume_mask.sum()),
            'pnl': round(float(df[volume_mask & (df['status'] == 'CLOSED')]['pnl_f'].sum()), 4),
        }
    }


def analyze_scanner_vs_traded(redis_client) -> dict:
    """Compare what GainerScanner sees vs what we actually traded."""
    try:
        raw = redis_client.get('scanner:top_movers')
        if not raw:
            return {'error': 'No scanner data in Redis'}

        scanner = json.loads(raw)
        gainers = scanner.get('gainers', [])
        vol_surges = scanner.get('volume_surges', [])

        return {
            'total_gainers': len(gainers),
            'gainers_3pct': len([g for g in gainers if g.get('change_1h', 0) >= 3]),
            'gainers_5pct': len([g for g in gainers if g.get('change_1h', 0) >= 5]),
            'top_gainers': [
                {
                    'symbol': g['symbol'],
                    'change_1h': g.get('change_1h', 0),
                    'change_24h': g.get('change_24h', 0),
                    'vol_ratio': g.get('vol_ratio', 0),
                }
                for g in gainers[:5]
            ],
            'vol_surges': len(vol_surges),
            'timestamp': scanner.get('timestamp'),
        }
    except Exception as e:
        return {'error': str(e)}


def simulate_momentum_strategy(df: pd.DataFrame, threshold: float) -> dict:
    """
    Simulate: what if we ONLY traded MOMENTUM_GAINER signals?

    Compare to actual results. Use closed trades to calculate
    hypothetical hit rate for momentum-correlated patterns.
    """
    if df.empty:
        return {}

    df = df.copy()
    df['pnl_f'] = df['pnl'].apply(lambda x: float(x) if x is not None else 0)
    closed = df[df['status'] == 'CLOSED'].copy()

    if closed.empty:
        return {'note': 'No closed trades to simulate against'}

    # Group by pattern and see which ones correlate with momentum
    momentum_patterns = ['VOLUME_SPIKE_UP', 'MOMENTUM_GAINER']
    non_momentum = ['MACD_BULLISH_CROSS', 'EMA_BULLISH_CROSS']

    results = {}
    for pattern_group, name in [(momentum_patterns, 'momentum'), (non_momentum, 'non_momentum')]:
        mask = closed['pattern'].apply(
            lambda p: any(mp in str(p) for mp in pattern_group) if p else False
        )
        subset = closed[mask]
        if not subset.empty:
            wins = int((subset['pnl_f'] > 0).sum())
            results[name] = {
                'trades': len(subset),
                'wins': wins,
                'win_rate': round(wins / len(subset) * 100, 1),
                'total_pnl': round(float(subset['pnl_f'].sum()), 4),
                'avg_pnl': round(float(subset['pnl_f'].mean()), 4),
            }

    # What if we filtered out non-momentum patterns?
    all_pnl = float(closed['pnl_f'].sum())
    non_mom_mask = closed['pattern'].apply(
        lambda p: any(mp in str(p) for mp in non_momentum) if p else False
    )
    non_mom_pnl = float(closed[non_mom_mask]['pnl_f'].sum())

    results['hypothetical'] = {
        'actual_pnl': round(all_pnl, 4),
        'without_non_momentum': round(all_pnl - non_mom_pnl, 4),
        'saved_by_filtering': round(-non_mom_pnl, 4) if non_mom_pnl < 0 else 0,
    }

    return results


def generate_report(trades_df, scanner_data, momentum_analysis,
                    simulation, threshold) -> str:
    """Generate backtest report."""
    lines = []
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

    lines.append("=" * 70)
    lines.append("  MOMENTUM GAINER BACKTEST REPORT")
    lines.append(f"  Threshold: {threshold}% | Generated: {now}")
    lines.append("=" * 70)

    # Section 1: Current scanner state
    lines.append("\n  1. CURRENT GAINERSCANNER STATE")
    if 'error' in scanner_data:
        lines.append(f"  {scanner_data['error']}")
    else:
        lines.append(f"  Total gainers: {scanner_data['total_gainers']}")
        lines.append(f"  Gainers >= 3% (1h): {scanner_data['gainers_3pct']}")
        lines.append(f"  Gainers >= 5% (1h): {scanner_data['gainers_5pct']}")
        lines.append(f"  Volume surges: {scanner_data['vol_surges']}")

        if scanner_data.get('top_gainers'):
            gainer_data = [[
                g['symbol'], f"{g['change_1h']:+.1f}%",
                f"{g['change_24h']:+.1f}%", f"{g['vol_ratio']:.1f}x"
            ] for g in scanner_data['top_gainers']]
            lines.append(tabulate(gainer_data,
                                  headers=['Symbol', '1h', '24h', 'Vol'],
                                  tablefmt='simple'))

    # Section 2: Momentum vs other trades
    lines.append("\n  2. MOMENTUM vs NON-MOMENTUM TRADES")
    if momentum_analysis:
        mom = momentum_analysis.get('momentum', {})
        other = momentum_analysis.get('other', {})

        comp_data = []
        if mom.get('closed', 0) > 0:
            mom_wr = mom['wins'] / mom['closed'] * 100 if mom['closed'] > 0 else 0
            comp_data.append(['Momentum/Scanner', mom['total'], mom['closed'],
                              f"{mom_wr:.0f}%", f"${mom['total_pnl']:.4f}"])
        if other.get('closed', 0) > 0:
            oth_wr = other['wins'] / other['closed'] * 100 if other['closed'] > 0 else 0
            comp_data.append(['Other patterns', other['total'], other['closed'],
                              f"{oth_wr:.0f}%", f"${other['total_pnl']:.4f}"])

        if comp_data:
            lines.append(tabulate(comp_data,
                                  headers=['Group', 'Total', 'Closed', 'Win%', 'P&L'],
                                  tablefmt='simple'))
        else:
            lines.append("  No momentum trades found yet (MOMENTUM_GAINER is new)")

    # Section 3: Simulation results
    lines.append("\n  3. HYPOTHETICAL: FILTER OUT WEAK PATTERNS")
    if simulation:
        for key in ['momentum', 'non_momentum']:
            data = simulation.get(key, {})
            if data:
                lines.append(f"  {key}: {data.get('trades', 0)} trades, "
                             f"{data.get('win_rate', 0)}% win rate, "
                             f"P&L ${data.get('total_pnl', 0):.4f}")

        hypo = simulation.get('hypothetical', {})
        if hypo:
            lines.append(f"\n  Actual total P&L: ${hypo.get('actual_pnl', 0):.4f}")
            lines.append(f"  Without MACD/EMA (weak patterns): "
                         f"${hypo.get('without_non_momentum', 0):.4f}")
            saved = hypo.get('saved_by_filtering', 0)
            if saved > 0:
                lines.append(f"  >> Filtering out weak patterns would have saved ${saved:.4f}")

    # Section 4: Recommendations
    lines.append(f"\n  {'='*60}")
    lines.append(f"  RECOMMENDATIONS")
    lines.append(f"  {'='*60}")

    actions = []

    mom = momentum_analysis.get('momentum', {}) if momentum_analysis else {}
    other = momentum_analysis.get('other', {}) if momentum_analysis else {}

    if not mom.get('total'):
        actions.append("MOMENTUM_GAINER pattern just deployed -- no historical data yet. "
                       "Monitor for 48-72h before drawing conclusions.")

    hypo = simulation.get('hypothetical', {}) if simulation else {}
    if hypo.get('saved_by_filtering', 0) > 0:
        actions.append(f"Filtering MACD_BULLISH_CROSS and EMA_BULLISH_CROSS would save "
                       f"${hypo['saved_by_filtering']:.4f}. Consider raising their "
                       f"confidence threshold to 85%+.")

    if scanner_data.get('gainers_5pct', 0) > 0:
        actions.append(f"Currently {scanner_data['gainers_5pct']} coins with >5% 1h move. "
                       f"MOMENTUM_GAINER will now detect these automatically.")

    if not actions:
        actions.append("No specific actions. Continue monitoring.")

    for i, action in enumerate(actions, 1):
        lines.append(f"  {i}. {action}")

    lines.append("")
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description='Strategy Lab: Momentum Backtest')
    parser.add_argument('--threshold', type=float, default=3.0,
                        help='Min 1h change %% for momentum trigger (default: 3.0)')
    parser.add_argument('--days', type=int, default=7,
                        help='Lookback days (default: 7)')
    parser.add_argument('--save', type=str, help='Save report to file')
    args = parser.parse_args()

    pg = get_pg()
    r = get_redis()

    try:
        trades_df = fetch_all_trades(pg, args.days)
        print(f"Fetched {len(trades_df)} trades from last {args.days} days")

        scanner_data = analyze_scanner_vs_traded(r)
        momentum_analysis = analyze_momentum_trades(trades_df)
        simulation = simulate_momentum_strategy(trades_df, args.threshold)

        report = generate_report(trades_df, scanner_data, momentum_analysis,
                                 simulation, args.threshold)
        print(report)

        if args.save:
            with open(args.save, 'w') as f:
                f.write(report)
            print(f"Report saved to {args.save}")

    finally:
        pg.close()
        r.close()


if __name__ == '__main__':
    main()
