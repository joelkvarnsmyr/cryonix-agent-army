#!/usr/bin/env python3
"""
Strategy Lab: Signal Calibration Engine

Calculates Expected Value (EV), win rates, and confidence weights
for each pattern type based on historical trade data.

Writes results to:
  - Redis key 'calibration:patterns' (used by auto-trade EV filter)
  - stdout as formatted table (for human review)
  - Optional: JSON output for piping

Usage:
  python3 scripts/strategy-lab/calibrate.py [--days 30] [--min-trades 3] [--json]
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


def fetch_closed_trades(pg, days: int) -> pd.DataFrame:
    """Fetch all closed trades within the lookback window."""
    cur = pg.cursor()
    cur.execute("""
        SELECT
            id, symbol, side, pattern, confidence,
            entry_price, exit_price, pnl,
            reasoning, timestamp
        FROM trades
        WHERE status = 'CLOSED'
          AND pnl IS NOT NULL
          AND pattern IS NOT NULL
          AND pattern != ''
          AND timestamp > NOW() - INTERVAL '%s days'
        ORDER BY timestamp DESC
    """ % int(days))

    columns = [desc[0] for desc in cur.description]
    rows = cur.fetchall()
    cur.close()
    return pd.DataFrame(rows, columns=columns)


def calculate_pattern_metrics(df: pd.DataFrame, min_trades: int) -> pd.DataFrame:
    """Calculate per-pattern performance metrics."""
    if df.empty:
        return pd.DataFrame()

    df = df.copy()
    df['pnl'] = df['pnl'].astype(float)
    df['confidence'] = df['confidence'].astype(float)

    # Handle compound patterns (e.g., "BOLLINGER_SQUEEZE + RSI_OVERSOLD")
    # Keep compound as-is AND expand sub-patterns
    rows = []
    for _, trade in df.iterrows():
        patterns = [p.strip() for p in str(trade['pattern']).split('+')]
        rows.append(trade)
        if len(patterns) > 1:
            for p in patterns:
                row = trade.copy()
                row['pattern'] = p
                rows.append(row)

    expanded = pd.DataFrame(rows)

    metrics = expanded.groupby('pattern').agg(
        trades=('pnl', 'count'),
        wins=('pnl', lambda x: (x > 0).sum()),
        losses=('pnl', lambda x: (x <= 0).sum()),
        total_pnl=('pnl', 'sum'),
        avg_pnl=('pnl', 'mean'),
        avg_win=('pnl', lambda x: x[x > 0].mean() if (x > 0).any() else 0.0),
        avg_loss=('pnl', lambda x: x[x <= 0].mean() if (x <= 0).any() else 0.0),
        best_trade=('pnl', 'max'),
        worst_trade=('pnl', 'min'),
        avg_confidence=('confidence', 'mean'),
    ).reset_index()

    # Derived metrics
    metrics['win_rate'] = (metrics['wins'] / metrics['trades'] * 100).round(1)
    metrics['ev'] = (
        (metrics['win_rate'] / 100 * metrics['avg_win']) -
        ((100 - metrics['win_rate']) / 100 * metrics['avg_loss'].abs())
    ).round(6)

    # Profit factor: gross wins / gross losses
    gross_wins = metrics['avg_win'].abs() * metrics['wins']
    gross_losses = metrics['avg_loss'].abs() * metrics['losses']
    metrics['profit_factor'] = (gross_wins / gross_losses.replace(0, float('nan'))).round(2)

    # Confidence weight: normalized 0-1 based on EV and sample size
    max_ev = metrics['ev'].max() if metrics['ev'].max() > 0 else 1
    sample_factor = (metrics['trades'] / metrics['trades'].max()).clip(0.1, 1.0)
    ev_factor = (metrics['ev'] / max_ev).clip(0, 1.0)
    metrics['weight'] = (ev_factor * 0.7 + sample_factor * 0.3).round(3)
    metrics.loc[metrics['ev'] < 0, 'weight'] = 0.0

    metrics['sufficient_data'] = metrics['trades'] >= min_trades

    return metrics.sort_values('ev', ascending=False)


def write_to_redis(r, metrics: pd.DataFrame) -> dict:
    """Write calibration data to Redis (same schema as /api/calibration)."""
    calibration = {}
    for _, row in metrics.iterrows():
        calibration[row['pattern']] = {
            'pattern': row['pattern'],
            'trades': int(row['trades']),
            'wins': int(row['wins']),
            'winRate': float(row['win_rate']),
            'avgWin': round(float(row['avg_win']), 6),
            'avgLoss': round(float(row['avg_loss']), 6),
            'ev': round(float(row['ev']), 4),
            'totalPnl': round(float(row['total_pnl']), 6),
            'weight': float(row['weight']),
            'profitFactor': float(row['profit_factor']) if pd.notna(row['profit_factor']) else 0,
            'sufficientData': bool(row['sufficient_data']),
        }

    r.set('calibration:patterns', json.dumps(calibration), ex=86400)
    return calibration


def print_report(metrics: pd.DataFrame):
    """Print a formatted calibration report."""
    print("\n" + "=" * 70)
    print("  SIGNAL CALIBRATION REPORT")
    print(f"  Generated: {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print("=" * 70)

    if metrics.empty:
        print("\n  No closed trades found.\n")
        return

    table_data = []
    for _, r in metrics.iterrows():
        status = "OK" if r['sufficient_data'] else "LOW-N"
        ev_marker = "+" if r['ev'] > 0 else "-" if r['ev'] < 0 else " "

        table_data.append([
            r['pattern'],
            int(r['trades']),
            f"{r['win_rate']}%",
            f"${r['total_pnl']:.4f}",
            f"{ev_marker}${abs(r['ev']):.4f}",
            f"{r['weight']:.2f}",
            f"{r['profit_factor']:.1f}x" if pd.notna(r['profit_factor']) else "N/A",
            status,
        ])

    headers = ['Pattern', 'Trades', 'Win%', 'Total P&L', 'EV/trade', 'Weight', 'PF', 'Status']
    print(tabulate(table_data, headers=headers, tablefmt='simple'))

    # Recommendations
    print("\n  RECOMMENDATIONS:")
    neg_ev = metrics[metrics['ev'] < 0]
    pos_ev = metrics[(metrics['ev'] > 0) & metrics['sufficient_data']]

    if not neg_ev.empty:
        for _, r in neg_ev.iterrows():
            print(f"  [REDUCE] {r['pattern']}: EV=${r['ev']:.4f}, "
                  f"win rate {r['win_rate']}% -- consider raising confidence threshold or disabling")

    if not pos_ev.empty:
        best = pos_ev.iloc[0]
        print(f"  [BOOST]  {best['pattern']}: EV=${best['ev']:.4f}, "
              f"win rate {best['win_rate']}% -- top performer, consider increasing allocation")

    low_data = metrics[~metrics['sufficient_data']]
    if not low_data.empty:
        print(f"  [INFO]   {len(low_data)} patterns have insufficient data (<min trades). "
              f"Metrics unreliable: {', '.join(low_data['pattern'].tolist())}")

    print("")


def main():
    parser = argparse.ArgumentParser(description='Strategy Lab: Signal Calibration')
    parser.add_argument('--days', type=int, default=30, help='Lookback window in days (default: 30)')
    parser.add_argument('--min-trades', type=int, default=3, help='Min trades for reliable metrics (default: 3)')
    parser.add_argument('--json', action='store_true', help='Output JSON instead of table')
    parser.add_argument('--no-redis', action='store_true', help='Skip writing to Redis')
    args = parser.parse_args()

    pg = get_pg()
    try:
        df = fetch_closed_trades(pg, args.days)
        print(f"Fetched {len(df)} closed trades from last {args.days} days")

        metrics = calculate_pattern_metrics(df, args.min_trades)

        if not args.no_redis:
            r = get_redis()
            calibration = write_to_redis(r, metrics)
            r.close()
            print(f"Wrote {len(calibration)} patterns to Redis calibration:patterns")

            # Persist daily snapshot to calibration_history
            try:
                pg_hist = get_pg()
                cur = pg_hist.cursor()
                today = datetime.now().strftime('%Y-%m-%d')
                overall = {
                    'total_trades': sum(p.get('trades', 0) for p in calibration.values()),
                    'avg_ev': round(sum(p.get('ev', 0) for p in calibration.values()) / max(len(calibration), 1), 4),
                    'positive_ev_patterns': sum(1 for p in calibration.values() if p.get('ev', 0) > 0),
                    'negative_ev_patterns': sum(1 for p in calibration.values() if p.get('ev', 0) < 0),
                }
                cur.execute("""
                    INSERT INTO calibration_history (run_type, snapshot_date, patterns, overall, created_at)
                    VALUES ('calibration', %s, %s, %s, NOW())
                    ON CONFLICT (snapshot_date, run_type) DO UPDATE
                    SET patterns = EXCLUDED.patterns, overall = EXCLUDED.overall, created_at = NOW()
                """, [today, json.dumps(calibration), json.dumps(overall)])
                pg_hist.commit()
                cur.close()
                pg_hist.close()
                print(f"[CALIBRATION] Saved daily snapshot to calibration_history ({today})")
            except Exception as e:
                print(f"[CALIBRATION] Failed to persist to Postgres: {e}")

        if args.json:
            result = {}
            for _, row in metrics.iterrows():
                result[row['pattern']] = {
                    'trades': int(row['trades']),
                    'win_rate': float(row['win_rate']),
                    'ev': round(float(row['ev']), 4),
                    'weight': float(row['weight']),
                    'total_pnl': round(float(row['total_pnl']), 4),
                }
            print(json.dumps(result, indent=2))
        else:
            print_report(metrics)

    finally:
        pg.close()


if __name__ == '__main__':
    main()
