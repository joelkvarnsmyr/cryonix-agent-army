#!/usr/bin/env python3
"""
Strategy Lab: Morning Report & What-If Engine

Analyzes recent trading performance and runs counterfactual scenarios:
- What if stop-loss was wider/tighter?
- Which exits were optimal vs suboptimal?
- Which patterns are dragging performance?
- What big movers did we miss?

Usage:
  python3 scripts/strategy-lab/morning_report.py [--hours 24] [--save report.txt]
"""
import argparse
import json
import sys
import os
from datetime import datetime, timezone, timedelta

import pandas as pd
from tabulate import tabulate

sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg, get_redis


def fetch_trades(pg, hours: int) -> pd.DataFrame:
    """Fetch closed trades within the lookback window."""
    cur = pg.cursor()
    cur.execute("""
        SELECT
            id, symbol, side, pattern, confidence,
            entry_price, exit_price, pnl,
            reasoning, timestamp, status, quantity
        FROM trades
        WHERE status = 'CLOSED'
          AND pnl IS NOT NULL
          AND timestamp > NOW() - INTERVAL '%s hours'
        ORDER BY timestamp DESC
    """ % int(hours))
    columns = [desc[0] for desc in cur.description]
    rows = cur.fetchall()
    cur.close()
    return pd.DataFrame(rows, columns=columns)


def fetch_open_positions(pg) -> pd.DataFrame:
    """Fetch currently open positions."""
    cur = pg.cursor()
    cur.execute("""
        SELECT symbol, side, entry_price, confidence, pattern, timestamp, quantity
        FROM trades
        WHERE status = 'FILLED'
        ORDER BY timestamp
    """)
    columns = [desc[0] for desc in cur.description]
    rows = cur.fetchall()
    cur.close()
    return pd.DataFrame(rows, columns=columns)


def classify_exit(reasoning) -> str:
    """Classify exit type from reasoning string."""
    if not reasoning:
        return 'UNKNOWN'
    r = str(reasoning).lower()
    if 'stop-loss' in r or 'short sl' in r or 'sl hit' in r:
        return 'SL'
    elif 'take-profit' in r or 'short tp' in r or 'tp hit' in r:
        return 'TP'
    elif 'trailing' in r:
        return 'TRAILING'
    return 'OTHER'


def analyze_exits(df: pd.DataFrame) -> dict:
    """Analyze exit types and their effectiveness."""
    if df.empty:
        return {}

    df = df.copy()
    df['exit_type'] = df['reasoning'].apply(classify_exit)
    df['entry'] = df['entry_price'].astype(float)
    df['exit'] = df['exit_price'].astype(float)
    df['pnl_f'] = df['pnl'].astype(float)
    df['sl_distance_pct'] = ((df['entry'] - df['exit']).abs() / df['entry'] * 100)

    result = {}
    for exit_type in ['SL', 'TP', 'TRAILING', 'OTHER', 'UNKNOWN']:
        subset = df[df['exit_type'] == exit_type]
        if subset.empty:
            continue
        result[exit_type] = {
            'count': len(subset),
            'total_pnl': round(float(subset['pnl_f'].sum()), 4),
            'avg_pnl': round(float(subset['pnl_f'].mean()), 4),
            'avg_distance_pct': round(float(subset['sl_distance_pct'].mean()), 2),
            'symbols': subset['symbol'].tolist(),
        }

    return result


def run_whatif_sl(df: pd.DataFrame, multipliers: list) -> list:
    """
    What-if scenario: different stop-loss distances.

    For each SL-exit trade, simulate what would have happened with
    wider or tighter SL. This is a simplified model based on the
    actual exit distances observed.
    """
    if df.empty:
        return []

    df = df.copy()
    df['exit_type'] = df['reasoning'].apply(classify_exit)
    df['entry'] = df['entry_price'].astype(float)
    df['exit'] = df['exit_price'].astype(float)
    df['pnl_f'] = df['pnl'].astype(float)

    sl_trades = df[df['exit_type'] == 'SL'].copy()
    if sl_trades.empty:
        return []

    sl_trades['actual_sl_pct'] = (
        (sl_trades['entry'] - sl_trades['exit']).abs() / sl_trades['entry'] * 100
    )
    avg_actual_sl = float(sl_trades['actual_sl_pct'].mean())

    scenarios = []
    actual_sl_pnl = float(sl_trades['pnl_f'].sum())

    for mult in multipliers:
        hypothetical_sl_pct = avg_actual_sl * mult

        # Trades where actual distance < hypothetical = would survive with wider SL
        would_survive = sl_trades[sl_trades['actual_sl_pct'] < hypothetical_sl_pct]
        would_still_stop = sl_trades[sl_trades['actual_sl_pct'] >= hypothetical_sl_pct]

        # Surviving trades: conservatively assume break-even recovery
        saved_pnl = float(would_survive['pnl_f'].sum())  # loss avoided

        # But wider SL = bigger loss when it does hit
        remaining_loss = float(would_still_stop['pnl_f'].sum())
        wider_penalty = remaining_loss * (mult - 1) * 0.5 if not would_still_stop.empty else 0

        hypothetical_pnl = remaining_loss + wider_penalty

        scenarios.append({
            'multiplier': f'{mult}x',
            'sl_distance': f'{hypothetical_sl_pct:.1f}%',
            'trades_saved': len(would_survive),
            'actual_pnl': round(actual_sl_pnl, 4),
            'hypothetical_pnl': round(hypothetical_pnl, 4),
            'improvement': round(hypothetical_pnl - actual_sl_pnl, 4),
        })

    return scenarios


def generate_report(df: pd.DataFrame, open_positions: pd.DataFrame,
                    hours: int, redis_client=None) -> str:
    """Generate the full morning report."""
    lines = []
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

    lines.append("=" * 70)
    lines.append("  CRYONIX STRATEGY LAB -- MORNING REPORT")
    lines.append(f"  Period: last {hours}h | Generated: {now}")
    lines.append("=" * 70)

    if df.empty:
        lines.append("\n  No closed trades in this period.\n")
        return '\n'.join(lines)

    df = df.copy()
    df['pnl_f'] = df['pnl'].astype(float)

    # --- SECTION 1: Overview ---
    total_pnl = float(df['pnl_f'].sum())
    total_trades = len(df)
    wins = int((df['pnl_f'] > 0).sum())
    losses = int((df['pnl_f'] <= 0).sum())
    win_rate = wins / total_trades * 100

    lines.append(f"\n  1. OVERVIEW")
    lines.append(f"  Trades: {total_trades} | Wins: {wins} | Losses: {losses}")
    lines.append(f"  Win Rate: {win_rate:.0f}% | Net P&L: ${total_pnl:.4f}")
    lines.append(f"  Best: ${float(df['pnl_f'].max()):.4f} | Worst: ${float(df['pnl_f'].min()):.4f}")

    # --- SECTION 2: Pattern breakdown ---
    lines.append(f"\n  2. PATTERN PERFORMANCE")
    pattern_data = []
    for pattern in df['pattern'].unique():
        subset = df[df['pattern'] == pattern]
        p_pnl = float(subset['pnl_f'].sum())
        p_wins = int((subset['pnl_f'] > 0).sum())
        p_wr = p_wins / len(subset) * 100
        pattern_data.append([
            pattern, len(subset), f'{p_wr:.0f}%', f'${p_pnl:.4f}',
            f'${float(subset["pnl_f"].mean()):.4f}'
        ])
    pattern_data.sort(key=lambda x: float(x[3].replace('$', '')), reverse=True)
    lines.append(tabulate(pattern_data,
                          headers=['Pattern', 'N', 'Win%', 'Total', 'Avg'],
                          tablefmt='simple'))

    # --- SECTION 3: Exit analysis ---
    exit_analysis = analyze_exits(df)
    if exit_analysis:
        lines.append(f"\n  3. EXIT ANALYSIS")
        exit_data = []
        for exit_type in ['SL', 'TP', 'TRAILING', 'OTHER', 'UNKNOWN']:
            stats = exit_analysis.get(exit_type)
            if not stats:
                continue
            exit_data.append([
                exit_type, stats['count'], f"${stats['total_pnl']:.4f}",
                f"${stats['avg_pnl']:.4f}", f"{stats['avg_distance_pct']:.1f}%"
            ])
        lines.append(tabulate(exit_data,
                              headers=['Exit', 'N', 'Total P&L', 'Avg P&L', 'Avg Dist'],
                              tablefmt='simple'))

        # SL diagnosis
        sl = exit_analysis.get('SL', {})
        if sl:
            sl_rate = sl['count'] / total_trades * 100
            if sl_rate > 50:
                lines.append(f"\n  NOTE: {sl_rate:.0f}% of exits are stop-losses "
                             f"(avg distance {sl['avg_distance_pct']:.1f}%)")
                if sl['avg_distance_pct'] < 2.0:
                    lines.append(f"  >> Stops may be too tight. Consider widening to 2.5-3x ATR.")

    # --- SECTION 4: What-if scenarios ---
    lines.append(f"\n  4. WHAT-IF: STOP-LOSS DISTANCE")
    scenarios = run_whatif_sl(df, [0.5, 0.75, 1.0, 1.5, 2.0, 3.0])
    if scenarios:
        scenario_data = [[
            s['multiplier'], s['sl_distance'], s['trades_saved'],
            f"${s['actual_pnl']:.4f}", f"${s['hypothetical_pnl']:.4f}",
            f"${s['improvement']:+.4f}"
        ] for s in scenarios]
        lines.append(tabulate(scenario_data,
                              headers=['SL Mult', 'Distance', 'Saved',
                                       'Actual', 'Hypothetical', 'Delta'],
                              tablefmt='simple'))

        best = max(scenarios, key=lambda s: s['improvement'])
        if best['improvement'] > 0:
            lines.append(f"\n  >> Best scenario: {best['multiplier']} SL "
                         f"({best['sl_distance']}) would improve by "
                         f"${best['improvement']:+.4f}")
    else:
        lines.append("  No SL exits to analyze.")

    # --- SECTION 5: Open positions ---
    if not open_positions.empty:
        lines.append(f"\n  5. OPEN POSITIONS ({len(open_positions)})")
        open_data = []
        utcnow = datetime.now(timezone.utc)
        old_count = 0
        for _, pos in open_positions.iterrows():
            ts = pos['timestamp']
            if hasattr(ts, 'tzinfo') and ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            age_hours = (utcnow - ts).total_seconds() / 3600
            if age_hours > 12:
                old_count += 1
            open_data.append([
                pos['symbol'], pos['pattern'],
                f"${float(pos['entry_price']):.4f}",
                f"{float(pos['confidence'])*100:.0f}%",
                f"{age_hours:.1f}h"
            ])
        lines.append(tabulate(open_data,
                              headers=['Symbol', 'Pattern', 'Entry', 'Conf', 'Age'],
                              tablefmt='simple'))

        if old_count > 0:
            lines.append(f"\n  WARNING: {old_count} positions older than 12h -- "
                         f"consider manual review")
    else:
        lines.append(f"\n  5. OPEN POSITIONS: None")

    # --- SECTION 6: Scanner missed opportunities ---
    if redis_client:
        try:
            scanner_raw = redis_client.get('scanner:top_movers')
            if scanner_raw:
                scanner = json.loads(scanner_raw)
                traded_symbols = set(df['symbol'].unique())
                gainers = scanner.get('gainers', [])
                big_movers = [g for g in gainers if g.get('change_24h', 0) >= 5]
                missed = [g for g in big_movers
                          if g['symbol'] not in traded_symbols]

                if missed:
                    lines.append(f"\n  6. MISSED OPPORTUNITIES (GainerScanner)")
                    missed_data = [[
                        m['symbol'],
                        f"+{m.get('change_1h', 0):.1f}%",
                        f"+{m.get('change_24h', 0):.1f}%",
                        f"{m.get('vol_ratio', 0):.1f}x vol"
                    ] for m in missed[:5]]
                    lines.append(tabulate(missed_data,
                                          headers=['Symbol', '1h', '24h', 'Volume'],
                                          tablefmt='simple'))
                else:
                    lines.append(f"\n  6. MISSED OPPORTUNITIES: None (traded all big movers)")
        except Exception:
            pass

    # --- SECTION 7: Action items ---
    lines.append(f"\n  {'='*60}")
    lines.append(f"  ACTION ITEMS")
    lines.append(f"  {'='*60}")

    actions = []

    # Negative EV patterns with enough data
    for pattern in df['pattern'].unique():
        subset = df[df['pattern'] == pattern]
        p_pnl = float(subset['pnl_f'].sum())
        p_wr = int((subset['pnl_f'] > 0).sum()) / len(subset) * 100
        if p_pnl < 0 and len(subset) >= 3 and p_wr < 40:
            actions.append(
                f"REDUCE {pattern}: {p_wr:.0f}% win rate over {len(subset)} trades, "
                f"P&L ${p_pnl:.4f}. Raise confidence threshold or add filters."
            )

    # SL too tight
    sl = exit_analysis.get('SL', {})
    if sl and sl['count'] / total_trades > 0.5:
        actions.append(
            f"WIDEN STOPS: {sl['count']}/{total_trades} trades exit via SL "
            f"(avg {sl.get('avg_distance_pct', 0):.1f}%). "
            f"Try 2.5x ATR instead of 2x in quant.py."
        )

    # Too many open positions
    if not open_positions.empty and len(open_positions) > 8:
        actions.append(
            f"REDUCE EXPOSURE: {len(open_positions)} open positions. "
            f"Consider lowering MAX_OPEN_POSITIONS or MAX_TRADES_PER_DAY."
        )

    # Overtrading
    trades_per_day = total_trades / max(hours / 24, 0.1)
    if trades_per_day > 8:
        actions.append(
            f"REDUCE FREQUENCY: {trades_per_day:.0f} trades/day. "
            f"High for micro-capital. Lower MAX_TRADES_PER_DAY."
        )

    if not actions:
        actions.append("No urgent actions. Performance within acceptable range.")

    for i, action in enumerate(actions, 1):
        lines.append(f"  {i}. {action}")

    lines.append("")
    return '\n'.join(lines)


def main():
    parser = argparse.ArgumentParser(description='Strategy Lab: Morning Report')
    parser.add_argument('--hours', type=int, default=24, help='Lookback hours (default: 24)')
    parser.add_argument('--save', type=str, help='Save report to file')
    args = parser.parse_args()

    pg = get_pg()
    r = get_redis()

    try:
        df = fetch_trades(pg, args.hours)
        open_pos = fetch_open_positions(pg)
        report = generate_report(df, open_pos, args.hours, redis_client=r)

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
