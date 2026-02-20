#!/usr/bin/env python3
"""
Baseline Mechanism — Freeze Mode + Performance Snapshots

Freezes AI Brain and Evolution Engine mutations to measure clean baseline
performance, then compares baseline vs post-baseline periods.

Usage:
  python3 scripts/strategy-lab/baseline.py freeze      # Freeze + snapshot
  python3 scripts/strategy-lab/baseline.py unfreeze    # Unfreeze + end snapshot
  python3 scripts/strategy-lab/baseline.py status      # Show current state
  python3 scripts/strategy-lab/baseline.py compare <id> # Compare periods

Cron: manual only (not scheduled)
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta

import tomlkit
import requests

sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg, get_redis

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TOML_PATH = os.path.join(PROJECT_ROOT, 'cryonix.toml')
LOCK_FILE = os.path.join(PROJECT_ROOT, '.baseline-frozen')
BASELINES_DIR = os.path.join(PROJECT_ROOT, 'baselines')

TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_EVOLUTION_BOT_TOKEN', '')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID', '')


def telegram_send(text):
    """Send message via Telegram bot."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print(f'[TELEGRAM] No token/chat_id, skipping notification')
        return
    try:
        requests.post(
            f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage',
            json={
                'chat_id': TELEGRAM_CHAT_ID,
                'text': text[:4096],
                'parse_mode': 'HTML',
                'disable_web_page_preview': True,
            },
            timeout=10,
        )
    except Exception as e:
        print(f'[TELEGRAM] Send failed: {e}')


def load_toml():
    """Load cryonix.toml as tomlkit doc."""
    with open(TOML_PATH, 'r') as f:
        return tomlkit.parse(f.read())


def save_toml(doc):
    """Save tomlkit doc back to cryonix.toml."""
    with open(TOML_PATH, 'w') as f:
        f.write(tomlkit.dumps(doc))


def ensure_baselines_dir(baseline_id):
    """Create baselines/{id}/ directory if needed."""
    path = os.path.join(BASELINES_DIR, baseline_id)
    os.makedirs(path, exist_ok=True)
    return path


def take_snapshot(pg, since=None):
    """Take a performance snapshot from Postgres.

    Args:
        pg: Postgres connection
        since: If provided, only count trades after this timestamp (ISO string)

    Returns:
        dict with performance metrics
    """
    cur = pg.cursor()

    # Overall metrics
    time_filter = ""
    if since:
        time_filter = f"AND timestamp > '{since}'"

    cur.execute(f"""
        SELECT
            COUNT(*) as trade_count,
            COUNT(*) FILTER (WHERE pnl > 0) as wins,
            COUNT(*) FILTER (WHERE pnl <= 0) as losses,
            COALESCE(SUM(pnl), 0) as total_pnl,
            COALESCE(AVG(pnl), 0) as avg_pnl,
            COALESCE(AVG(pnl) FILTER (WHERE pnl > 0), 0) as avg_win,
            COALESCE(AVG(pnl) FILTER (WHERE pnl <= 0), 0) as avg_loss,
            COALESCE(MAX(pnl), 0) as best_trade,
            COALESCE(MIN(pnl), 0) as worst_trade
        FROM trades
        WHERE status = 'CLOSED' AND pnl IS NOT NULL
        {time_filter}
    """)
    row = cur.fetchone()
    cols = [desc[0] for desc in cur.description]
    overall = dict(zip(cols, row))
    # Convert Decimal to float for JSON serialization
    overall = {k: float(v) if v is not None else 0.0 for k, v in overall.items()}

    win_count = overall.get('wins', 0)
    trade_count = overall.get('trade_count', 0)
    overall['win_rate'] = round((win_count / trade_count * 100), 1) if trade_count > 0 else 0.0

    # Per-pattern breakdown
    cur.execute(f"""
        SELECT
            pattern,
            COUNT(*) as trades,
            COUNT(*) FILTER (WHERE pnl > 0) as wins,
            COALESCE(SUM(pnl), 0) as total_pnl,
            COALESCE(AVG(pnl), 0) as avg_pnl
        FROM trades
        WHERE status = 'CLOSED' AND pnl IS NOT NULL
          AND pattern IS NOT NULL AND pattern != ''
        {time_filter}
        GROUP BY pattern
        ORDER BY total_pnl DESC
    """)
    pattern_rows = cur.fetchall()
    pattern_cols = [desc[0] for desc in cur.description]
    patterns = []
    for pr in pattern_rows:
        p = dict(zip(pattern_cols, pr))
        p = {k: float(v) if isinstance(v, (int, float)) or (hasattr(v, '__float__')) else v for k, v in p.items()}
        p['win_rate'] = round((p['wins'] / p['trades'] * 100), 1) if p['trades'] > 0 else 0.0
        patterns.append(p)

    cur.close()

    return {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'since': since,
        'overall': overall,
        'patterns': patterns,
    }


def get_trade_count_since(pg, since_iso):
    """Get number of closed trades since a given ISO timestamp."""
    cur = pg.cursor()
    cur.execute("""
        SELECT COUNT(*) FROM trades
        WHERE status = 'CLOSED' AND pnl IS NOT NULL
          AND timestamp > %s
    """, (since_iso,))
    count = cur.fetchone()[0]
    cur.close()
    return count


# === Subcommands ===

def cmd_freeze(pg):
    """Freeze mutations and take start snapshot."""
    doc = load_toml()

    if doc.get('baseline', {}).get('frozen', False):
        current_id = doc['baseline'].get('baseline_id', '?')
        print(f'[BASELINE] Already frozen (baseline {current_id}). Unfreeze first.')
        sys.exit(1)

    now = datetime.now(timezone.utc)
    baseline_id = f'baseline_{now.strftime("%Y%m%d_%H%M%S")}'

    # Take start snapshot
    snapshot = take_snapshot(pg)
    snapshot['baseline_id'] = baseline_id

    # Save snapshot
    snap_dir = ensure_baselines_dir(baseline_id)
    start_path = os.path.join(snap_dir, 'start.json')
    with open(start_path, 'w') as f:
        json.dump(snapshot, f, indent=2)

    # Update cryonix.toml
    if 'baseline' not in doc:
        doc.add('baseline', tomlkit.table())
    doc['baseline']['frozen'] = True
    doc['baseline']['frozen_at'] = now.isoformat()
    doc['baseline']['frozen_by'] = 'baseline.py'
    doc['baseline']['baseline_id'] = baseline_id
    save_toml(doc)

    # Create lock file (survives git pulls)
    with open(LOCK_FILE, 'w') as f:
        f.write(baseline_id)

    overall = snapshot['overall']
    print(f'[BASELINE] FROZEN — {baseline_id}')
    print(f'  Start snapshot: {overall["trade_count"]} trades, '
          f'win rate {overall["win_rate"]}%, '
          f'total P&L ${overall["total_pnl"]:.2f}')
    print(f'  Saved to: {start_path}')
    print(f'  AI Brain + Evolution Engine will skip runs until unfreeze.')

    telegram_send(
        f'🧊 <b>BASELINE FROZEN</b>\n\n'
        f'ID: <code>{baseline_id}</code>\n'
        f'AI Brain + Evolution Engine paused.\n'
        f'Calibration still runs (read-only).\n\n'
        f'📊 Start snapshot:\n'
        f'  Trades: {overall["trade_count"]}\n'
        f'  Win rate: {overall["win_rate"]}%\n'
        f'  Total P&L: ${overall["total_pnl"]:.2f}\n'
        f'  Avg P&L: ${overall["avg_pnl"]:.4f}\n\n'
        f'Unfreeze: <code>python3 scripts/strategy-lab/baseline.py unfreeze</code>'
    )


def cmd_unfreeze(pg):
    """Unfreeze mutations and take end snapshot."""
    doc = load_toml()

    if not doc.get('baseline', {}).get('frozen', False):
        print('[BASELINE] Not frozen. Nothing to unfreeze.')
        sys.exit(1)

    baseline_id = doc['baseline'].get('baseline_id', '?')
    frozen_at = doc['baseline'].get('frozen_at', '')

    # Take end snapshot (trades since freeze only)
    snapshot = take_snapshot(pg, since=frozen_at)
    snapshot['baseline_id'] = baseline_id
    snapshot['frozen_at'] = frozen_at
    snapshot['unfrozen_at'] = datetime.now(timezone.utc).isoformat()

    # Calculate freeze duration
    if frozen_at:
        freeze_start = datetime.fromisoformat(frozen_at)
        duration = datetime.now(timezone.utc) - freeze_start
        hours = duration.total_seconds() / 3600
        snapshot['duration_hours'] = round(hours, 1)
    else:
        hours = 0
        snapshot['duration_hours'] = 0

    # Save snapshot
    snap_dir = ensure_baselines_dir(baseline_id)
    end_path = os.path.join(snap_dir, 'end.json')
    with open(end_path, 'w') as f:
        json.dump(snapshot, f, indent=2)

    # Update cryonix.toml
    doc['baseline']['frozen'] = False
    save_toml(doc)

    # Remove lock file
    if os.path.exists(LOCK_FILE):
        os.remove(LOCK_FILE)

    overall = snapshot['overall']
    print(f'[BASELINE] UNFROZEN — {baseline_id}')
    print(f'  Duration: {hours:.1f} hours')
    print(f'  Baseline trades: {overall["trade_count"]}')
    print(f'  Win rate: {overall["win_rate"]}%')
    print(f'  Total P&L: ${overall["total_pnl"]:.2f}')
    print(f'  Saved to: {end_path}')
    print(f'  AI Brain + Evolution Engine will resume on next cron run.')

    telegram_send(
        f'🔓 <b>BASELINE UNFROZEN</b>\n\n'
        f'ID: <code>{baseline_id}</code>\n'
        f'Duration: {hours:.1f} hours\n\n'
        f'📊 Baseline period results:\n'
        f'  Trades: {overall["trade_count"]}\n'
        f'  Win rate: {overall["win_rate"]}%\n'
        f'  Total P&L: ${overall["total_pnl"]:.2f}\n'
        f'  Avg P&L: ${overall["avg_pnl"]:.4f}\n'
        f'  Best: ${overall["best_trade"]:.4f}\n'
        f'  Worst: ${overall["worst_trade"]:.4f}\n\n'
        f'AI Brain + Evolution Engine resumed.\n'
        f'Compare: <code>python3 scripts/strategy-lab/baseline.py compare {baseline_id}</code>'
    )


def cmd_status(pg):
    """Show current baseline state."""
    doc = load_toml()
    baseline = doc.get('baseline', {})
    frozen = baseline.get('frozen', False)

    if not frozen:
        print('[BASELINE] Status: UNFROZEN (mutations active)')
        # Show last baseline if any
        if os.path.isdir(BASELINES_DIR):
            dirs = sorted(os.listdir(BASELINES_DIR), reverse=True)
            if dirs:
                print(f'  Last baseline: {dirs[0]}')
        return

    baseline_id = baseline.get('baseline_id', '?')
    frozen_at = baseline.get('frozen_at', '')

    # Duration
    if frozen_at:
        freeze_start = datetime.fromisoformat(frozen_at)
        duration = datetime.now(timezone.utc) - freeze_start
        hours = duration.total_seconds() / 3600
    else:
        hours = 0

    # Trade count since freeze
    trade_count = get_trade_count_since(pg, frozen_at) if frozen_at else 0

    print(f'[BASELINE] Status: FROZEN')
    print(f'  Baseline ID: {baseline_id}')
    print(f'  Frozen at: {frozen_at}')
    print(f'  Duration: {hours:.1f} hours')
    print(f'  Trades since freeze: {trade_count}')
    print(f'  AI Brain: PAUSED')
    print(f'  Evolution: PAUSED')
    print(f'  Calibration: RUNNING (read-only)')


def cmd_compare(pg, baseline_id):
    """Compare baseline period vs post-baseline period."""
    snap_dir = os.path.join(BASELINES_DIR, baseline_id)

    # Load start + end snapshots
    start_path = os.path.join(snap_dir, 'start.json')
    end_path = os.path.join(snap_dir, 'end.json')

    if not os.path.exists(start_path):
        print(f'[BASELINE] No start snapshot found for {baseline_id}')
        sys.exit(1)
    if not os.path.exists(end_path):
        print(f'[BASELINE] No end snapshot found for {baseline_id}. Run unfreeze first.')
        sys.exit(1)

    with open(start_path) as f:
        start = json.load(f)
    with open(end_path) as f:
        end = json.load(f)

    frozen_at = end.get('frozen_at', '')
    unfrozen_at = end.get('unfrozen_at', '')
    duration_hours = end.get('duration_hours', 0)

    # Query post-baseline trades (same duration window after unfreeze)
    if unfrozen_at and duration_hours > 0:
        unfreeze_dt = datetime.fromisoformat(unfrozen_at)
        post_end = unfreeze_dt + timedelta(hours=duration_hours)
        now = datetime.now(timezone.utc)

        if post_end > now:
            remaining = (post_end - now).total_seconds() / 3600
            print(f'[BASELINE] Post-baseline window not complete yet.')
            print(f'  {remaining:.1f} hours remaining until full comparison is available.')
            print(f'  Showing partial post-baseline data...\n')

        cur = pg.cursor()
        cur.execute("""
            SELECT
                COUNT(*) as trade_count,
                COUNT(*) FILTER (WHERE pnl > 0) as wins,
                COUNT(*) FILTER (WHERE pnl <= 0) as losses,
                COALESCE(SUM(pnl), 0) as total_pnl,
                COALESCE(AVG(pnl), 0) as avg_pnl,
                COALESCE(MAX(pnl), 0) as best_trade,
                COALESCE(MIN(pnl), 0) as worst_trade
            FROM trades
            WHERE status = 'CLOSED' AND pnl IS NOT NULL
              AND timestamp > %s
              AND timestamp <= %s
        """, (unfrozen_at, post_end.isoformat()))
        row = cur.fetchone()
        cols = [desc[0] for desc in cur.description]
        post = dict(zip(cols, row))
        post = {k: float(v) if v is not None else 0.0 for k, v in post.items()}
        post_trades = post.get('trade_count', 0)
        post['win_rate'] = round((post['wins'] / post_trades * 100), 1) if post_trades > 0 else 0.0
        cur.close()
    else:
        post = None

    # Print comparison
    baseline_overall = end['overall']

    print(f'╔══════════════════════════════════════════════════════════════╗')
    print(f'║  BASELINE COMPARISON: {baseline_id:<38}║')
    print(f'╚══════════════════════════════════════════════════════════════╝')
    print()
    print(f'  Frozen:   {frozen_at}')
    print(f'  Unfrozen: {unfrozen_at}')
    print(f'  Duration: {duration_hours} hours')
    print()

    # Table header
    header = f'  {"Metric":<20} {"Baseline":>12} {"Post-Baseline":>14} {"Delta":>10}'
    print(header)
    print(f'  {"─" * 58}')

    def fmt_row(label, base_val, post_val, is_pct=False, is_dollar=True):
        if is_pct:
            b = f'{base_val:.1f}%'
            p = f'{post_val:.1f}%' if post_val is not None else '—'
            d = f'{post_val - base_val:+.1f}%' if post_val is not None else '—'
        elif is_dollar:
            b = f'${base_val:.4f}'
            p = f'${post_val:.4f}' if post_val is not None else '—'
            d = f'${post_val - base_val:+.4f}' if post_val is not None else '—'
        else:
            b = f'{base_val}'
            p = f'{post_val}' if post_val is not None else '—'
            d = f'{post_val - base_val:+}' if post_val is not None else '—'
        print(f'  {label:<20} {b:>12} {p:>14} {d:>10}')

    post_overall = post if post else {}

    fmt_row('Trades', baseline_overall['trade_count'],
            post_overall.get('trade_count'), is_dollar=False, is_pct=False)
    fmt_row('Win Rate', baseline_overall['win_rate'],
            post_overall.get('win_rate'), is_pct=True)
    fmt_row('Total P&L', baseline_overall['total_pnl'],
            post_overall.get('total_pnl'))
    fmt_row('Avg P&L', baseline_overall['avg_pnl'],
            post_overall.get('avg_pnl'))
    fmt_row('Best Trade', baseline_overall['best_trade'],
            post_overall.get('best_trade'))
    fmt_row('Worst Trade', baseline_overall['worst_trade'],
            post_overall.get('worst_trade'))

    print()

    if not post:
        print('  Post-baseline data not available (no unfreeze timestamp or duration).')
    elif post_overall.get('trade_count', 0) == 0:
        print('  No post-baseline trades yet.')

    # Pattern breakdown for baseline period
    if end.get('patterns'):
        print()
        print(f'  Baseline Pattern Breakdown:')
        print(f'  {"Pattern":<35} {"Trades":>7} {"Win%":>7} {"P&L":>10}')
        print(f'  {"─" * 61}')
        for p in end['patterns']:
            pnl_str = f'${p["total_pnl"]:.4f}'
            print(f'  {p["pattern"]:<35} {p["trades"]:>7} {p["win_rate"]:>6.1f}% {pnl_str:>10}')


def main():
    parser = argparse.ArgumentParser(
        description='Baseline Mechanism — Freeze Mode + Performance Snapshots'
    )
    subparsers = parser.add_subparsers(dest='command', help='Available commands')

    subparsers.add_parser('freeze', help='Freeze mutations + take start snapshot')
    subparsers.add_parser('unfreeze', help='Unfreeze mutations + take end snapshot')
    subparsers.add_parser('status', help='Show current freeze state')

    compare_parser = subparsers.add_parser('compare', help='Compare baseline vs post-baseline')
    compare_parser.add_argument('baseline_id', help='Baseline ID (e.g., baseline_20260220_143000)')

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    pg = get_pg()

    try:
        if args.command == 'freeze':
            cmd_freeze(pg)
        elif args.command == 'unfreeze':
            cmd_unfreeze(pg)
        elif args.command == 'status':
            cmd_status(pg)
        elif args.command == 'compare':
            cmd_compare(pg, args.baseline_id)
    finally:
        pg.close()


if __name__ == '__main__':
    main()
