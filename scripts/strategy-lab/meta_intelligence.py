#!/usr/bin/env python3
"""
Meta-Intelligence Layer: persist ephemeral metrics to Postgres.

Runs every 6h (like calibrate.py). Computes and persists:
  1. Alpha decay ratio per pattern (7d WR / 30d WR) -> alpha_decay_snapshots
  2. Mutation fitness scores per evolution run -> mutation_fitness_scores
  3. Kill rate trend (daily summary) -> Redis list

Usage:
  python3 scripts/strategy-lab/meta_intelligence.py [--json]
"""
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg, get_redis


def compute_alpha_decay(pg, r):
    """Compute decay_ratio per pattern from calibration_history snapshots."""
    cur = pg.cursor()

    # Get latest snapshot
    cur.execute("""
        SELECT snapshot_date, patterns
        FROM calibration_history
        WHERE run_type = 'calibration' AND patterns IS NOT NULL
        ORDER BY snapshot_date DESC LIMIT 1
    """)
    latest = cur.fetchone()
    if not latest:
        print("[DECAY] No calibration snapshots found, skipping")
        cur.close()
        return

    latest_date, latest_patterns = latest
    if isinstance(latest_patterns, str):
        latest_patterns = json.loads(latest_patterns)

    # Get ~7d ago snapshot
    cur.execute("""
        SELECT snapshot_date, patterns
        FROM calibration_history
        WHERE run_type = 'calibration' AND patterns IS NOT NULL
          AND snapshot_date <= (CURRENT_DATE - INTERVAL '6 days')
        ORDER BY snapshot_date DESC LIMIT 1
    """)
    row_7d = cur.fetchone()

    # Get ~30d ago snapshot
    cur.execute("""
        SELECT snapshot_date, patterns
        FROM calibration_history
        WHERE run_type = 'calibration' AND patterns IS NOT NULL
          AND snapshot_date <= (CURRENT_DATE - INTERVAL '28 days')
        ORDER BY snapshot_date DESC LIMIT 1
    """)
    row_30d = cur.fetchone()

    patterns_7d = {}
    patterns_30d = {}
    if row_7d:
        p = row_7d[1]
        patterns_7d = json.loads(p) if isinstance(p, str) else p
    if row_30d:
        p = row_30d[1]
        patterns_30d = json.loads(p) if isinstance(p, str) else p

    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    decay_details = {}
    inserted = 0

    for pattern, data in latest_patterns.items():
        wr_current = data.get('winRate', 0)
        ev_current = data.get('ev', 0)
        trades = data.get('trades', 0)

        wr_7d = patterns_7d.get(pattern, {}).get('winRate')
        ev_7d = patterns_7d.get(pattern, {}).get('ev')
        wr_30d = patterns_30d.get(pattern, {}).get('winRate')
        ev_30d = patterns_30d.get(pattern, {}).get('ev')

        # decay_ratio = wr_7d / wr_30d (how much alpha has decayed)
        decay_ratio = None
        if wr_7d is not None and wr_30d is not None and wr_30d > 0:
            decay_ratio = round(wr_7d / wr_30d, 3)

        # Trend classification
        trend = 'stable'
        if decay_ratio is not None:
            if decay_ratio < 0.85:
                trend = 'decaying'
            elif decay_ratio > 1.15:
                trend = 'improving'

        # Slope: simple (ev_current - ev_7d) as proxy for 14d slope
        slope_14d = None
        if ev_7d is not None and ev_current is not None:
            slope_14d = round(ev_current - ev_7d, 6)

        decay_details[pattern] = {
            'pattern': pattern,
            'wr_current': wr_current,
            'wr_7d': wr_7d,
            'wr_30d': wr_30d,
            'ev_current': ev_current,
            'ev_7d': ev_7d,
            'ev_30d': ev_30d,
            'decay_ratio': decay_ratio,
            'trend': trend,
            'slope_14d': slope_14d,
            'trades': trades,
        }

        # Upsert into alpha_decay_snapshots
        try:
            cur.execute("""
                INSERT INTO alpha_decay_snapshots
                    (snapshot_date, pattern, ev_current, ev_7d_ago, ev_30d_ago,
                     slope_14d, trend, wr_current, wr_7d_ago, decay_ratio, data_points)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (snapshot_date, pattern) DO UPDATE SET
                    ev_current = EXCLUDED.ev_current,
                    ev_7d_ago = EXCLUDED.ev_7d_ago,
                    ev_30d_ago = EXCLUDED.ev_30d_ago,
                    slope_14d = EXCLUDED.slope_14d,
                    trend = EXCLUDED.trend,
                    wr_current = EXCLUDED.wr_current,
                    wr_7d_ago = EXCLUDED.wr_7d_ago,
                    decay_ratio = EXCLUDED.decay_ratio,
                    data_points = EXCLUDED.data_points,
                    created_at = NOW()
            """, [today, pattern, ev_current, ev_7d, ev_30d,
                  slope_14d, trend, wr_current, wr_7d, decay_ratio, trades])
            inserted += 1
        except Exception as e:
            print(f"[DECAY] Failed to insert {pattern}: {e}")

    pg.commit()
    cur.close()

    # Write detailed breakdown to Redis
    r.set('metrics:alpha_decay_detailed', json.dumps(decay_details), ex=86400)
    print(f"[DECAY] Persisted {inserted} patterns to alpha_decay_snapshots ({today})")
    print(f"[DECAY] Wrote metrics:alpha_decay_detailed to Redis ({len(decay_details)} patterns)")

    return decay_details


def compute_mutation_fitness(pg, r):
    """Compute fitness scores for recent evolution runs."""
    cur = pg.cursor()

    # Get evolution runs from last 48h
    cur.execute("""
        SELECT id, run_id, config_version, changes_made, created_at
        FROM evolution_runs
        WHERE created_at > NOW() - INTERVAL '48 hours'
        ORDER BY created_at DESC
    """)
    runs = cur.fetchall()
    if not runs:
        print("[FITNESS] No evolution runs in last 48h, skipping")
        cur.close()
        return

    # Get market regime from Redis
    regime = 'unknown'
    try:
        regime_raw = r.get('market:regime')
        if regime_raw:
            regime = regime_raw
    except Exception:
        pass

    scored = 0
    for row in runs:
        run_db_id, run_id, config_version_post, changes_made, created_at = row

        if not run_id:
            continue

        # Parse changes_made to find the pre-config version
        config_version_pre = None
        if changes_made:
            try:
                changes = json.loads(changes_made) if isinstance(changes_made, str) else changes_made
                # config_version from config_changes table for this run
            except Exception:
                pass

        # If we don't have pre version, look at config_changes
        if not config_version_pre:
            cur.execute("""
                SELECT config_version FROM config_changes
                WHERE created_at < %s AND config_version IS NOT NULL
                ORDER BY created_at DESC LIMIT 1
            """, [created_at])
            pre_row = cur.fetchone()
            if pre_row:
                config_version_pre = pre_row[0]

        # Get trade stats for pre config version
        pre_stats = _get_config_trade_stats(cur, config_version_pre) if config_version_pre else None
        post_stats = _get_config_trade_stats(cur, config_version_post) if config_version_post else None

        pre_trades = pre_stats['trades'] if pre_stats else 0
        post_trades = post_stats['trades'] if post_stats else 0
        pre_wr = pre_stats['wr'] if pre_stats else None
        post_wr = post_stats['wr'] if post_stats else None
        pre_sharpe = pre_stats['sharpe'] if pre_stats else None
        post_sharpe = post_stats['sharpe'] if post_stats else None
        pre_avg_pnl = pre_stats['avg_pnl'] if pre_stats else None
        post_avg_pnl = post_stats['avg_pnl'] if post_stats else None

        # fitness_score = post_sharpe - pre_sharpe
        fitness_score = None
        if post_sharpe is not None and pre_sharpe is not None:
            fitness_score = round(post_sharpe - pre_sharpe, 4)

        try:
            cur.execute("""
                INSERT INTO mutation_fitness_scores
                    (run_id, config_version_pre, config_version_post, regime,
                     pre_trades, post_trades, pre_wr, post_wr,
                     pre_sharpe, post_sharpe, pre_avg_pnl, post_avg_pnl,
                     fitness_score, evaluation_window_hours)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 48)
            """, [run_id, config_version_pre, config_version_post, regime,
                  pre_trades, post_trades, pre_wr, post_wr,
                  pre_sharpe, post_sharpe, pre_avg_pnl, post_avg_pnl,
                  fitness_score])
            scored += 1
        except Exception as e:
            # Likely duplicate run_id, skip
            pg.rollback()
            print(f"[FITNESS] Skipped run {run_id}: {e}")
            continue

    pg.commit()
    cur.close()
    print(f"[FITNESS] Scored {scored}/{len(runs)} evolution runs (regime: {regime})")


def _get_config_trade_stats(cur, config_version):
    """Get trade statistics for a specific config version."""
    if not config_version:
        return None

    cur.execute("""
        SELECT
            COUNT(*) as trades,
            COALESCE(AVG(CASE WHEN pnl > 0 THEN 1.0 ELSE 0.0 END) * 100, 0) as wr,
            COALESCE(AVG(pnl), 0) as avg_pnl,
            COALESCE(STDDEV(pnl), 0) as std_pnl
        FROM trades
        WHERE config_version = %s AND status = 'CLOSED' AND pnl IS NOT NULL
    """, [config_version])
    row = cur.fetchone()
    if not row or row[0] == 0:
        return None

    trades, wr, avg_pnl, std_pnl = row
    # Sharpe-like ratio: avg_pnl / std_pnl (annualization not needed for comparison)
    sharpe = round(float(avg_pnl) / float(std_pnl), 4) if std_pnl and float(std_pnl) > 0 else 0.0

    return {
        'trades': int(trades),
        'wr': round(float(wr), 1),
        'avg_pnl': round(float(avg_pnl), 8),
        'sharpe': sharpe,
    }


def persist_kill_rate_trend(r):
    """Read current kill rate from Redis and append to trend list."""
    kill_rate_raw = r.get('metrics:kill_rate')
    if not kill_rate_raw:
        print("[KILLRATE] No metrics:kill_rate in Redis, skipping")
        return

    try:
        kill_rate = json.loads(kill_rate_raw) if isinstance(kill_rate_raw, str) else kill_rate_raw
    except Exception:
        kill_rate = {'value': kill_rate_raw}

    entry = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'data': kill_rate,
    }

    r.lpush('metrics:kill_rate_trend', json.dumps(entry))
    r.ltrim('metrics:kill_rate_trend', 0, 29)  # Keep last 30 entries
    print(f"[KILLRATE] Appended to metrics:kill_rate_trend (max 30 entries)")


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Meta-Intelligence Layer')
    parser.add_argument('--json', action='store_true', help='Output JSON summary')
    args = parser.parse_args()

    print("=" * 60)
    print("  META-INTELLIGENCE LAYER")
    print(f"  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print("=" * 60)

    pg = get_pg()
    r = get_redis()

    try:
        # 1. Alpha decay
        decay = compute_alpha_decay(pg, r)

        # 2. Mutation fitness
        compute_mutation_fitness(pg, r)

        # 3. Kill rate trend
        persist_kill_rate_trend(r)

        if args.json and decay:
            print(json.dumps(decay, indent=2))

    except Exception as e:
        print(f"[ERROR] Meta-intelligence failed: {e}")
        import traceback
        traceback.print_exc()
    finally:
        pg.close()
        r.close()

    print("\n[DONE] Meta-intelligence run complete")


if __name__ == '__main__':
    main()
