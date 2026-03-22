#!/usr/bin/env python3
"""
Edge Machine Metrics — Alpha Decay, Mutation Fitness, Capital Velocity, ECR.

Run: python3 scripts/strategy-lab/edge_metrics.py
Cron: every 6h alongside calibration

Reads: Postgres (calibration_history, trades, position_history)
Writes: Redis metrics:alpha_decay, metrics:mutation_fitness, metrics:capital_velocity, metrics:ecr
"""

import os, sys, json, time
import numpy as np
from datetime import datetime, timedelta

import psycopg2
import redis

POSTGRES_URL = os.environ.get('POSTGRES_URL', 'postgres://postgres:password@localhost:5432/cryonix')
KV_URL = os.environ.get('KV_URL', 'redis://localhost:6379')

def get_pg():
    return psycopg2.connect(POSTGRES_URL)

def get_redis():
    return redis.from_url(KV_URL, decode_responses=True)

# -- Alpha Decay Rate ----------------------------------------------------

def compute_alpha_decay(pg, r):
    """
    Linear regression on EV per pattern over last N calibration snapshots.
    aD = slope of EV trend. If aD < -0.3 over 14 days -> strategy dying.
    """
    cur = pg.cursor()
    cur.execute("""
        SELECT snapshot_date, patterns
        FROM calibration_history
        WHERE run_type = 'calibration'
        ORDER BY snapshot_date DESC
        LIMIT 14
    """)
    rows = cur.fetchall()
    if len(rows) < 3:
        print(f'[ALPHA-DECAY] Not enough snapshots ({len(rows)}), need 3+')
        return

    # Build per-pattern time series
    pattern_series: dict[str, list[tuple[float, float]]] = {}
    # Determine base date from the oldest snapshot
    oldest_date = rows[-1][0]
    if isinstance(oldest_date, str):
        base_date = datetime.strptime(oldest_date, '%Y-%m-%d')
    else:
        base_date = datetime.combine(oldest_date, datetime.min.time()) if not isinstance(oldest_date, datetime) else oldest_date

    for date_val, patterns_json in rows:
        if not patterns_json:
            continue
        patterns = patterns_json if isinstance(patterns_json, dict) else json.loads(patterns_json)
        if isinstance(date_val, str):
            snap_date = datetime.strptime(date_val, '%Y-%m-%d')
        elif isinstance(date_val, datetime):
            snap_date = date_val
        else:
            snap_date = datetime.combine(date_val, datetime.min.time())
        day_offset = (snap_date - base_date).days

        for pattern_name, data in patterns.items():
            if not isinstance(data, dict):
                continue
            ev = None
            wr = data.get('winRate', data.get('win_rate', 0))
            avg_win = data.get('avgWin', data.get('avg_win', 0))
            avg_loss = data.get('avgLoss', data.get('avg_loss', 0))
            trades = data.get('trades', 0)
            if trades >= 3 and wr is not None:
                ev = (wr / 100) * abs(avg_win) - (1 - wr / 100) * abs(avg_loss)
            if ev is not None:
                pattern_series.setdefault(pattern_name, []).append((day_offset, ev))

    # Compute slope for each pattern
    result = {}
    for pattern, series in pattern_series.items():
        if len(series) < 3:
            continue
        x = np.array([s[0] for s in series])
        y = np.array([s[1] for s in series])
        if x.std() == 0:
            continue
        slope = np.polyfit(x, y, 1)[0]
        trend = 'declining' if slope < -0.001 else 'improving' if slope > 0.001 else 'stable'
        result[pattern] = {
            'slope': round(float(slope), 6),
            'trend': trend,
            'periods': len(series),
            'latestEv': round(float(y[0]), 4),  # Most recent
        }

    r.set('metrics:alpha_decay', json.dumps({
        'patterns': result,
        'timestamp': int(time.time() * 1000),
    }), ex=86400)

    declining = [p for p, d in result.items() if d['trend'] == 'declining']
    print(f'[ALPHA-DECAY] {len(result)} patterns analyzed. Declining: {declining or "none"}')
    return result


# -- Mutation Fitness Score -----------------------------------------------

def compute_mutation_fitness(pg, r):
    """
    Sharpe-like ratio per config_version. Compares consecutive versions.
    MFS > 0 = mutation helped. MFS < 0 three times -> auto-revert candidate.
    """
    cur = pg.cursor()
    # Get trades grouped by config_version (last 30 days)
    cur.execute("""
        SELECT config_version,
               COUNT(*) as trades,
               AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) as win_rate,
               AVG(pnl) as avg_pnl,
               STDDEV(pnl) as std_pnl,
               MIN(timestamp) as first_trade,
               MAX(timestamp) as last_trade
        FROM trades
        WHERE timestamp > NOW() - INTERVAL '30 days'
          AND status = 'CLOSED'
          AND config_version IS NOT NULL
        GROUP BY config_version
        HAVING COUNT(*) >= 3
        ORDER BY MIN(timestamp) ASC
    """)
    versions = cur.fetchall()
    if len(versions) < 2:
        print(f'[MFS] Not enough config versions ({len(versions)}), need 2+')
        return

    results = []
    for i, (cv, trades, wr, avg_pnl, std_pnl, first, last) in enumerate(versions):
        sharpe = float(avg_pnl / std_pnl) if std_pnl and std_pnl > 0 else 0
        results.append({
            'configVersion': cv,
            'trades': trades,
            'winRate': round(float(wr) * 100, 1),
            'avgPnl': round(float(avg_pnl), 6),
            'sharpe': round(sharpe, 3),
        })

    # Compare consecutive versions
    comparisons = []
    for i in range(1, len(results)):
        prev = results[i - 1]
        curr = results[i]
        delta_sharpe = curr['sharpe'] - prev['sharpe']
        comparisons.append({
            'from': prev['configVersion'],
            'to': curr['configVersion'],
            'deltaSharpe': round(delta_sharpe, 3),
            'improved': delta_sharpe > 0,
        })

    r.set('metrics:mutation_fitness', json.dumps({
        'versions': results,
        'comparisons': comparisons,
        'timestamp': int(time.time() * 1000),
    }), ex=86400)

    improvements = sum(1 for c in comparisons if c['improved'])
    print(f'[MFS] {len(comparisons)} mutations compared. {improvements}/{len(comparisons)} improved.')
    return results


# -- Capital Velocity -----------------------------------------------------

def compute_capital_velocity(pg, r):
    """
    CV = total_traded_volume / avg_capital / period_days
    Low CV = money sitting idle. High CV = capital working.
    """
    cur = pg.cursor()
    cur.execute("""
        SELECT
            SUM(ABS(entry_price * quantity)) as total_volume,
            COUNT(*) as trade_count,
            MIN(timestamp) as first_trade,
            MAX(timestamp) as last_trade
        FROM trades
        WHERE timestamp > NOW() - INTERVAL '7 days'
          AND status = 'CLOSED'
    """)
    row = cur.fetchone()
    if not row or not row[0]:
        print('[CV] No closed trades in last 7 days')
        r.set('metrics:capital_velocity', json.dumps({
            'velocity': 0, 'volume': 0, 'trades': 0,
            'timestamp': int(time.time() * 1000),
        }), ex=86400)
        return

    total_volume = float(row[0])
    trade_count = row[1]
    first = row[2]
    last = row[3]

    # Get average capital (from portfolio or config)
    avg_capital = 50  # Cryonix capital (~$50 USDC deployed)
    try:
        capital_raw = r.get('risk:portfolio_state')
        if capital_raw:
            state = json.loads(capital_raw)
            avg_capital = max(float(state.get('totalValue', 50)), 1)
    except Exception:
        pass

    days = max(1, (last - first).total_seconds() / 86400) if first and last else 7
    velocity = total_volume / avg_capital / days

    r.set('metrics:capital_velocity', json.dumps({
        'velocity': round(velocity, 3),
        'volume': round(total_volume, 2),
        'trades': trade_count,
        'days': round(days, 1),
        'avgCapital': round(avg_capital, 2),
        'timestamp': int(time.time() * 1000),
    }), ex=86400)

    print(f'[CV] Velocity={velocity:.3f}x/day ({trade_count} trades, ${total_volume:.2f} vol, {days:.1f} days)')


# -- Edge Capture Ratio ---------------------------------------------------

def compute_ecr(pg, r):
    """
    ECR = realized_PnL / theoretical_max_PnL
    Theoretical max = perfect trader buying every dip, selling every peak (15m bars).
    ECR ~1% = good. ECR ~5% = exceptional. ECR increasing = system learning.
    """
    try:
        import ccxt
        exchange = ccxt.binance({'enableRateLimit': True})
    except ImportError:
        print('[ECR] ccxt not available, skipping')
        return

    symbols = ['BTC/USDC', 'ETH/USDC', 'SOL/USDC', 'BNB/USDC']
    total_theoretical = 0
    capital_per_symbol = 50 / len(symbols)  # Rough estimate

    for symbol in symbols:
        try:
            ohlcv = exchange.fetch_ohlcv(symbol, '15m', limit=672)  # ~7 days
            if len(ohlcv) < 10:
                continue
            # Theoretical max: sum all positive close-to-close moves
            max_return = sum(
                abs((ohlcv[i][4] - ohlcv[i-1][4]) / ohlcv[i-1][4])
                for i in range(1, len(ohlcv))
                if ohlcv[i][4] > ohlcv[i-1][4] and ohlcv[i-1][4] > 0
            )
            total_theoretical += capital_per_symbol * max_return
        except Exception as e:
            print(f'[ECR] Failed to fetch {symbol}: {e}')

    if total_theoretical <= 0:
        print('[ECR] No theoretical PnL data')
        return

    # Get realized PnL (last 7 days)
    cur = pg.cursor()
    cur.execute("""
        SELECT COALESCE(SUM(pnl), 0)
        FROM trades
        WHERE timestamp > NOW() - INTERVAL '7 days'
          AND status = 'CLOSED'
    """)
    realized = float(cur.fetchone()[0])

    ecr = (realized / total_theoretical) * 100 if total_theoretical > 0 else 0

    r.set('metrics:ecr', json.dumps({
        'ecr': round(ecr, 4),
        'realized': round(realized, 4),
        'theoretical': round(total_theoretical, 2),
        'period': '7d',
        'symbols': symbols,
        'timestamp': int(time.time() * 1000),
    }), ex=86400)

    # Store ECR history for trend sparkline (last 90 data points ~22 days at 6h intervals)
    r.lpush('metrics:ecr:history', json.dumps({
        'ecr': round(ecr, 4),
        'realized': round(realized, 4),
        'theoretical': round(total_theoretical, 2),
        'timestamp': int(time.time() * 1000),
    }))
    r.ltrim('metrics:ecr:history', 0, 89)

    print(f'[ECR] {ecr:.4f}% — realized ${realized:.4f} / theoretical ${total_theoretical:.2f} (7d)')


# -- Main -----------------------------------------------------------------

def main():
    print('=' * 50)
    print('  Edge Machine Metrics')
    print('=' * 50)

    pg = get_pg()
    r = get_redis()

    try:
        compute_alpha_decay(pg, r)
        compute_mutation_fitness(pg, r)
        compute_capital_velocity(pg, r)
        compute_ecr(pg, r)
    finally:
        pg.close()
        r.close()

    print('\nDone.')


if __name__ == '__main__':
    main()
