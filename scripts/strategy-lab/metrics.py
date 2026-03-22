#!/usr/bin/env python3
"""
Cryonix Metrics — Alpha Decay Rate + Edge Capture Ratio

Runs as a cron job every 6 hours. Computes:
1. Alpha Decay: Is our strategy's edge dying?
2. Edge Capture Ratio: How much of available market edge do we capture?

Writes results to Redis for dashboard + alerting.

Usage: python3 scripts/strategy-lab/metrics.py
"""

import json
import os
import sys
import time
from datetime import datetime, timedelta

import psycopg2
import redis

# ── Config ────────────────────────────────────────────────────────────────────

POSTGRES_URL = os.environ.get('POSTGRES_URL', 'postgres://postgres:password@localhost:5432/cryonix')
KV_URL = os.environ.get('KV_URL', 'redis://localhost:6379')

ALPHA_DECAY_PERIODS = 4       # Compare last 4 calibration snapshots
ALPHA_DECAY_ALERT_PCT = -30   # Alert if EV drops >30% in 14 days
ECR_LOOKBACK_DAYS = 14        # 14-day window for ECR calculation


def get_pg():
    return psycopg2.connect(POSTGRES_URL)


def get_redis():
    return redis.from_url(KV_URL, decode_responses=True)


# ── Alpha Decay Rate ──────────────────────────────────────────────────────────

def compute_alpha_decay(pg, r):
    """
    Alpha Decay = trend of pattern EV over time.
    Uses calibration_history snapshots (written by calibrate.py every 6h).

    αD = (EV_recent - EV_oldest) / days_between
    If αD < -30%/14d → strategy is dying.
    """
    cur = pg.cursor()
    cur.execute("""
        SELECT snapshot_date, patterns
        FROM calibration_history
        WHERE run_type = 'pattern_ev'
          AND snapshot_date::date > NOW() - INTERVAL '30 days'
        ORDER BY snapshot_date DESC
        LIMIT %s
    """, (ALPHA_DECAY_PERIODS,))

    rows = cur.fetchall()
    if len(rows) < 2:
        print('[METRICS] Alpha Decay: insufficient data (need 2+ calibration snapshots)')
        return None

    # Extract EV per pattern per snapshot
    pattern_evs = {}  # pattern -> [(date, ev)]
    for snapshot_date_raw, patterns_json in rows:
        if not patterns_json:
            continue
        # Parse snapshot_date (may be string or date)
        if isinstance(snapshot_date_raw, str):
            try:
                snapshot_date = datetime.strptime(snapshot_date_raw[:10], '%Y-%m-%d')
            except ValueError:
                continue
        else:
            snapshot_date = snapshot_date_raw

        patterns = patterns_json if isinstance(patterns_json, dict) else json.loads(patterns_json)
        for pattern_key, stats in patterns.items():
            ev = stats.get('ev', 0)
            if pattern_key not in pattern_evs:
                pattern_evs[pattern_key] = []
            pattern_evs[pattern_key].append((snapshot_date, ev))

    # Compute decay per pattern
    decay_results = {}
    for pattern, data_points in pattern_evs.items():
        if len(data_points) < 2:
            continue

        # Sort by date ascending
        data_points.sort(key=lambda x: x[0])

        oldest_date, oldest_ev = data_points[0]
        newest_date, newest_ev = data_points[-1]

        try:
            days_between = max(abs((newest_date - oldest_date).days), 1)
        except TypeError:
            days_between = 14  # fallback

        # Absolute decay
        ev_change = newest_ev - oldest_ev

        # Relative decay (% change per 14 days)
        if abs(oldest_ev) > 0.001:
            decay_pct_14d = (ev_change / abs(oldest_ev)) * 100 * (14 / days_between)
        else:
            decay_pct_14d = 0

        trend = 'stable'
        if decay_pct_14d < -10:
            trend = 'declining'
        elif decay_pct_14d < -30:
            trend = 'dying'
        elif decay_pct_14d > 10:
            trend = 'improving'

        decay_results[pattern] = {
            'ev_oldest': round(oldest_ev, 4),
            'ev_newest': round(newest_ev, 4),
            'ev_change': round(ev_change, 4),
            'decay_pct_14d': round(decay_pct_14d, 1),
            'trend': trend,
            'data_points': len(data_points),
            'days_span': days_between,
        }

        emoji = '💀' if trend == 'dying' else '📉' if trend == 'declining' else '📈' if trend == 'improving' else '➡️'
        print(f'[ALPHA-DECAY] {emoji} {pattern}: EV {oldest_ev:.4f} → {newest_ev:.4f} ({decay_pct_14d:+.1f}%/14d) [{trend}]')

    # Store in Redis
    r.set('metrics:alpha_decay', json.dumps({
        'patterns': decay_results,
        'timestamp': time.time(),
        'periods': len(rows),
    }), ex=86400)  # 24h TTL

    # Alert on dying strategies
    dying = [p for p, d in decay_results.items() if d['trend'] == 'dying']
    if dying:
        print(f'[ALPHA-DECAY] ⚠️ DYING STRATEGIES: {", ".join(dying)}')

    return decay_results


# ── Edge Capture Ratio ────────────────────────────────────────────────────────

def compute_ecr(pg, r):
    """
    Edge Capture Ratio = realized_PnL / theoretical_max_PnL

    Theoretical max = if we captured every positive 15m candle move
    across all watchlist symbols. This is the "perfect trader" benchmark.

    ECR of 1-2% is typical for a good quant fund.
    ECR increasing = system learning.
    ECR decreasing = market changing faster than we adapt.
    """
    cur = pg.cursor()

    # Get realized PnL for the period
    cur.execute("""
        SELECT COALESCE(SUM(pnl), 0) as realized_pnl,
               COUNT(*) as trade_count
        FROM position_history
        WHERE closed_at IS NOT NULL
          AND closed_at > NOW() - INTERVAL '%s days'
    """ % ECR_LOOKBACK_DAYS)

    realized_pnl, trade_count = cur.fetchone()
    realized_pnl = float(realized_pnl)

    # Get theoretical max from market data
    # We approximate: for each symbol, sum of all positive 15m candle returns
    # Using the signals table as a proxy for market activity
    cur.execute("""
        SELECT DISTINCT
            s1.symbol,
            s1.confidence,
            s1.timestamp
        FROM signals s1
        WHERE s1.timestamp > NOW() - INTERVAL '%s days'
        ORDER BY s1.timestamp DESC
        LIMIT 1000
    """ % ECR_LOOKBACK_DAYS)

    signal_count = cur.rowcount

    # Simplified ECR: use position_history to estimate theoretical max
    # Perfect trader would have caught every positive move
    cur.execute("""
        SELECT symbol,
               entry_price,
               COALESCE((metadata->>'highWaterMark')::numeric, entry_price) as hwm,
               pnl,
               quantity
        FROM position_history
        WHERE closed_at IS NOT NULL
          AND closed_at > NOW() - INTERVAL '%s days'
          AND metadata->>'highWaterMark' IS NOT NULL
    """ % ECR_LOOKBACK_DAYS)

    rows = cur.fetchall()

    # Theoretical max: if we sold at HWM every time
    theoretical_max = 0
    for symbol, entry_price, hwm, pnl, quantity in rows:
        entry_price = float(entry_price)
        hwm = float(hwm)
        quantity = float(quantity)
        if hwm > entry_price:
            theoretical_max += (hwm - entry_price) * quantity

    # Add opportunity cost: signals we rejected
    # (This will be enhanced when Kill Rate data matures)

    if theoretical_max > 0:
        ecr = (realized_pnl / theoretical_max) * 100
    else:
        ecr = 0

    result = {
        'ecr_pct': round(ecr, 2),
        'realized_pnl': round(realized_pnl, 4),
        'theoretical_max_pnl': round(theoretical_max, 4),
        'trade_count': trade_count,
        'signal_count': signal_count,
        'lookback_days': ECR_LOOKBACK_DAYS,
        'timestamp': time.time(),
    }

    r.set('metrics:ecr', json.dumps(result), ex=86400)

    direction = '📈' if ecr > 0 else '📉'
    print(f'[ECR] {direction} Edge Capture Ratio: {ecr:.2f}%')
    print(f'  Realized: ${realized_pnl:.4f} | Theoretical max: ${theoretical_max:.4f}')
    print(f'  Trades: {trade_count} | Signals: {signal_count} | Period: {ECR_LOOKBACK_DAYS}d')

    return result


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    print('=' * 50)
    print('  CRYONIX METRICS — Alpha Decay + ECR')
    print(f'  {datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")}')
    print('=' * 50)

    pg = get_pg()
    r = get_redis()

    try:
        decay = compute_alpha_decay(pg, r)
        ecr = compute_ecr(pg, r)

        print('\n' + '=' * 50)
        if decay:
            dying = [p for p, d in decay.items() if d['trend'] in ('dying', 'declining')]
            if dying:
                print(f'⚠️  ATTENTION: {len(dying)} pattern(s) declining: {", ".join(dying)}')
        if ecr:
            print(f'📊 ECR: {ecr["ecr_pct"]:.2f}% ({"improving" if ecr["ecr_pct"] > 0 else "negative"})')
        print('=' * 50)

    finally:
        pg.close()
        r.close()


if __name__ == '__main__':
    main()
