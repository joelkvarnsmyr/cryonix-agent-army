# Claude Code Strategy Lab — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a read-only analytical layer ("Strategy Lab") that sits beside Cryonix, analyzes trading performance, and generates actionable parameter recommendations — without ever touching execution.

**Architecture:** Two standalone scripts that connect to the live Postgres database. Script 1 fixes and enhances the existing calibration pipeline (it's broken — Redis is empty despite a 6h cron). Script 2 is a new "morning report" generator that runs what-if scenarios on last night's trades. Both output to stdout/file and optionally Telegram.

**Tech Stack:** Python 3.11 (available on VM), psycopg2/asyncpg for Postgres, direct Redis via redis-py, pandas for analysis. No Node.js dependency — these are standalone analysis scripts.

---

## Context: What Exists vs What We're Building

### Already exists (infrastructure we leverage):
- Postgres `trades` table with all closed/open trades, P&L, pattern, entry/exit prices, timestamps
- Postgres `position_history` table with full trade lifecycle metadata
- Redis `scanner:top_movers` with GainerScanner data
- `/api/calibration` endpoint (POST recalculates EV, GET returns cached data)
- Cron: `0 */6 * * * bash scripts/run_calibration.sh` — calls the calibration API
- Cron: `*/15 * * * * curl POST /api/x-sentiment` — polls sentiment
- `.env` file with `POSTGRES_URL`, `KV_URL`

### What's broken (discovered during analysis):
- `calibration:patterns` Redis key is **empty** — the 6h cron job runs but data doesn't persist
- `x-sentiment:latest` Redis key is **empty** — the 15min cron hits the API but results aren't sticking
- Root cause likely: the cron curls `https://cryonix.kvarnsmyr.se/api/calibration` which goes through Caddy → Docker web container. If the web container was restarted (it was, 19 min ago), the Drizzle DB connection or Redis connection may fail silently inside the container.

### What we're building (new):
1. **`scripts/strategy-lab/calibrate.py`** — Standalone Python calibration that writes directly to Redis, bypassing the flaky API route. Enhanced with deeper EV analysis, pattern correlation, and a confidence weight table.
2. **`scripts/strategy-lab/morning-report.py`** — What-if scenario engine that analyzes last 24h trades and generates a briefing with concrete parameter change proposals.
3. **`scripts/strategy-lab/run.sh`** — Wrapper that runs both scripts and optionally sends results to Telegram.

---

## Task 1: Setup Strategy Lab directory and dependencies

**Files:**
- Create: `scripts/strategy-lab/requirements.txt`
- Create: `scripts/strategy-lab/__init__.py`
- Create: `scripts/strategy-lab/db.py`

**Step 1: Create directory structure and requirements**

```
scripts/strategy-lab/
  requirements.txt
  __init__.py
  db.py              # shared DB/Redis connection helper
  calibrate.py       # Task 2
  morning_report.py  # Task 3
  run.sh             # Task 4
```

`requirements.txt`:
```
psycopg2-binary>=2.9
redis>=5.0
pandas>=2.0
tabulate>=0.9
python-dotenv>=1.0
```

**Step 2: Write the shared database helper**

`db.py` connects to Postgres and Redis using env vars from `~/cryonix/.env`:

```python
"""Shared database connections for Strategy Lab scripts."""
import os
import psycopg2
import redis as redis_lib
from dotenv import load_dotenv

# Load .env from project root
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '..', '.env'))

def get_pg():
    """Get a Postgres connection. Caller must close."""
    url = os.environ.get('POSTGRES_URL')
    if not url:
        # Fallback: construct from individual vars or default
        password = os.environ.get('POSTGRES_PASSWORD', 'password')
        url = f'postgresql://postgres:{password}@localhost:5432/cryonix'
    return psycopg2.connect(url)

def get_redis():
    """Get a Redis connection. Caller must close."""
    url = os.environ.get('KV_URL', 'redis://localhost:6379')
    return redis_lib.from_url(url, decode_responses=True)
```

**Step 3: Install dependencies**

Run: `pip install psycopg2-binary redis pandas tabulate python-dotenv`
Expected: Successful installation

**Step 4: Verify connections work**

Run: `cd /home/azureuser/cryonix && python3 -c "from scripts.strategy_lab.db import get_pg, get_redis; pg=get_pg(); r=get_redis(); print('PG:', pg.status); print('Redis:', r.ping()); pg.close(); r.close()"`
Expected: `PG: 1` and `Redis: True`

**Step 5: Commit**

```bash
git add scripts/strategy-lab/
git commit -m "feat(strategy-lab): add directory structure and DB helper"
```

---

## Task 2: Signal Calibration Engine (`calibrate.py`)

**Files:**
- Create: `scripts/strategy-lab/calibrate.py`

This replaces the flaky `/api/calibration` cron with a standalone Python script that:
1. Queries Postgres directly (no HTTP dependency)
2. Calculates richer metrics than the existing API
3. Writes `calibration:patterns` to Redis with the same schema (backwards compatible)
4. Also generates a `calibration_weights.json` file that can be imported

**Step 1: Write calibrate.py**

```python
#!/usr/bin/env python3
"""
Strategy Lab: Signal Calibration Engine

Calculates Expected Value (EV), win rates, and confidence weights
for each pattern type based on historical trade data.

Writes results to:
  - Redis key 'calibration:patterns' (used by auto-trade EV filter)
  - stdout as formatted table (for human review)
  - Optional: calibration_weights.json file

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

# Allow running as script
sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg, get_redis


def fetch_closed_trades(pg, days: int) -> pd.DataFrame:
    """Fetch all closed trades within the lookback window."""
    query = """
        SELECT
            id, symbol, side, pattern, confidence,
            entry_price, exit_price, pnl,
            reasoning, timestamp,
            EXTRACT(EPOCH FROM (
                COALESCE(
                    (SELECT timestamp FROM trades t2
                     WHERE t2.symbol = t.symbol AND t2.status = 'CLOSED'
                     AND t2.id = t.id),
                    NOW()
                ) - t.timestamp
            )) / 3600.0 as hold_hours
        FROM trades t
        WHERE status = 'CLOSED'
          AND pnl IS NOT NULL
          AND pattern IS NOT NULL
          AND pattern != ''
          AND timestamp > NOW() - INTERVAL '%s days'
        ORDER BY timestamp DESC
    """ % days  # Safe: days is an int from argparse

    df = pd.read_sql(query, pg)
    return df


def calculate_pattern_metrics(df: pd.DataFrame, min_trades: int) -> pd.DataFrame:
    """Calculate per-pattern performance metrics."""
    if df.empty:
        return pd.DataFrame()

    # Handle compound patterns (e.g., "BOLLINGER_SQUEEZE + RSI_OVERSOLD")
    # Count each sub-pattern individually AND the compound together
    rows = []
    for _, trade in df.iterrows():
        patterns = [p.strip() for p in str(trade['pattern']).split('+')]
        # Add as compound pattern
        rows.append(trade)
        # Also add each sub-pattern if compound
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
        avg_win=('pnl', lambda x: x[x > 0].mean() if (x > 0).any() else 0),
        avg_loss=('pnl', lambda x: x[x <= 0].mean() if (x <= 0).any() else 0),
        best_trade=('pnl', 'max'),
        worst_trade=('pnl', 'min'),
        avg_confidence=('confidence', 'mean'),
        avg_hold_hours=('hold_hours', 'mean'),
    ).reset_index()

    # Calculate derived metrics
    metrics['win_rate'] = (metrics['wins'] / metrics['trades'] * 100).round(1)
    metrics['ev'] = (
        (metrics['win_rate'] / 100 * metrics['avg_win']) -
        ((100 - metrics['win_rate']) / 100 * metrics['avg_loss'].abs())
    ).round(6)
    metrics['profit_factor'] = (
        metrics['avg_win'].abs() * metrics['wins'] /
        (metrics['avg_loss'].abs() * metrics['losses']).replace(0, float('nan'))
    ).round(2)

    # Confidence weight: normalized score 0-1 based on EV and sample size
    # Higher EV + more trades = higher weight
    # Negative EV = weight approaches 0
    max_ev = metrics['ev'].max() if metrics['ev'].max() > 0 else 1
    sample_factor = (metrics['trades'] / metrics['trades'].max()).clip(0.1, 1.0)
    ev_factor = (metrics['ev'] / max_ev).clip(0, 1.0)
    metrics['weight'] = (ev_factor * 0.7 + sample_factor * 0.3).round(3)
    # Negative EV patterns get weight 0
    metrics.loc[metrics['ev'] < 0, 'weight'] = 0.0

    # Filter by minimum trades
    metrics['sufficient_data'] = metrics['trades'] >= min_trades

    return metrics.sort_values('ev', ascending=False)


def write_to_redis(r, metrics: pd.DataFrame):
    """Write calibration data to Redis in the same format as /api/calibration."""
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
    """Print a formatted calibration report to stdout."""
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
                  f"win rate {r['win_rate']}% — consider raising confidence threshold or disabling")

    if not pos_ev.empty:
        best = pos_ev.iloc[0]
        print(f"  [BOOST]  {best['pattern']}: EV=${best['ev']:.4f}, "
              f"win rate {best['win_rate']}% — top performer, consider increasing allocation")

    low_data = metrics[~metrics['sufficient_data']]
    if not low_data.empty:
        print(f"  [INFO]   {len(low_data)} patterns have insufficient data (<min trades). "
              f"Metrics unreliable: {', '.join(low_data['pattern'].tolist())}")

    print("")


def main():
    parser = argparse.ArgumentParser(description='Strategy Lab: Signal Calibration')
    parser.add_argument('--days', type=int, default=30, help='Lookback window in days (default: 30)')
    parser.add_argument('--min-trades', type=int, default=3, help='Minimum trades for reliable metrics (default: 3)')
    parser.add_argument('--json', action='store_true', help='Output JSON to stdout instead of table')
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

        if args.json:
            # JSON output for piping
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
```

**Step 2: Test that it runs against live data**

Run: `cd /home/azureuser/cryonix && python3 scripts/strategy-lab/calibrate.py --days 7`
Expected: Table output showing pattern metrics for the 11 closed trades, Redis updated

**Step 3: Verify Redis was populated**

Run: `docker exec $(docker ps -q -f name=redis) redis-cli GET calibration:patterns | python3 -m json.tool | head -20`
Expected: JSON object with pattern data (no longer empty)

**Step 4: Commit**

```bash
git add scripts/strategy-lab/calibrate.py
git commit -m "feat(strategy-lab): add signal calibration engine with EV + weights"
```

---

## Task 3: Morning Report / What-If Engine (`morning_report.py`)

**Files:**
- Create: `scripts/strategy-lab/morning_report.py`

This is the core "strategy lab" script. It:
1. Fetches last 24h closed trades
2. Analyzes actual exit performance (SL/TP/trailing breakdown)
3. Runs what-if scenarios: "what if SL was X instead of Y?"
4. Compares ATR multipliers for SL/TP
5. Generates a briefing with concrete parameter suggestions

**Step 1: Write morning_report.py**

```python
#!/usr/bin/env python3
"""
Strategy Lab: Morning Report & What-If Engine

Analyzes last 24h trading performance and runs counterfactual scenarios:
- What if stop-loss was wider/tighter?
- What if take-profit was different?
- What if we used a different ATR multiplier?
- Which exits were optimal vs suboptimal?

Usage:
  python3 scripts/strategy-lab/morning_report.py [--hours 24]
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


def fetch_trades(pg, hours: int) -> pd.DataFrame:
    """Fetch closed trades with full metadata."""
    query = """
        SELECT
            t.id, t.symbol, t.side, t.pattern, t.confidence,
            t.entry_price, t.exit_price, t.pnl,
            t.reasoning, t.timestamp, t.status,
            t.quantity
        FROM trades t
        WHERE t.status = 'CLOSED'
          AND t.pnl IS NOT NULL
          AND t.timestamp > NOW() - INTERVAL '%s hours'
        ORDER BY t.timestamp DESC
    """ % hours

    return pd.read_sql(query, pg)


def fetch_open_positions(pg) -> pd.DataFrame:
    """Fetch currently open positions."""
    query = """
        SELECT symbol, side, entry_price, confidence, pattern, timestamp, quantity
        FROM trades
        WHERE status = 'FILLED'
        ORDER BY timestamp
    """
    return pd.read_sql(query, pg)


def classify_exit(reasoning: str) -> str:
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
    for exit_type in ['SL', 'TP', 'TRAILING', 'OTHER']:
        subset = df[df['exit_type'] == exit_type]
        if subset.empty:
            continue
        result[exit_type] = {
            'count': len(subset),
            'total_pnl': round(subset['pnl_f'].sum(), 4),
            'avg_pnl': round(subset['pnl_f'].mean(), 4),
            'avg_distance_pct': round(subset['sl_distance_pct'].mean(), 2),
            'symbols': subset['symbol'].tolist(),
        }

    return result


def run_whatif_sl(df: pd.DataFrame, multipliers: list) -> list:
    """
    What-if scenario: different stop-loss distances.

    For each SL trade, simulate what would have happened with wider/tighter SL.
    We approximate by checking if a wider SL would have avoided the exit
    (assuming the trade would have eventually hit TP or recovered).

    This is a simplified model — real backtesting would need candle-level data.
    """
    if df.empty:
        return []

    df = df.copy()
    df['exit_type'] = df['reasoning'].apply(classify_exit)
    df['entry'] = df['entry_price'].astype(float)
    df['exit'] = df['exit_price'].astype(float)
    df['pnl_f'] = df['pnl'].astype(float)

    sl_trades = df[df['exit_type'] == 'SL']
    if sl_trades.empty:
        return []

    # Current actual SL distance
    sl_trades = sl_trades.copy()
    sl_trades['actual_sl_pct'] = ((sl_trades['entry'] - sl_trades['exit']).abs() / sl_trades['entry'] * 100)
    avg_actual_sl = sl_trades['actual_sl_pct'].mean()

    scenarios = []
    for mult in multipliers:
        hypothetical_sl_pct = avg_actual_sl * mult
        # With wider SL, some SL exits would NOT have triggered
        # Approximate: trades where actual distance < hypothetical distance would survive
        would_survive = sl_trades[sl_trades['actual_sl_pct'] < hypothetical_sl_pct]
        would_still_stop = sl_trades[sl_trades['actual_sl_pct'] >= hypothetical_sl_pct]

        # Surviving trades: assume they'd recover to breakeven on average
        # (conservative assumption — reality depends on market)
        saved_pnl = would_survive['pnl_f'].sum()  # This loss would be avoided
        remaining_loss = would_still_stop['pnl_f'].sum()

        # But wider SL means bigger loss when it DOES hit
        wider_loss_adjustment = 0
        if not would_still_stop.empty:
            wider_loss_adjustment = would_still_stop['pnl_f'].sum() * (mult - 1) * 0.5

        hypothetical_pnl = remaining_loss + wider_loss_adjustment
        actual_sl_pnl = sl_trades['pnl_f'].sum()

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
    lines.append("  CRYONIX STRATEGY LAB — MORNING REPORT")
    lines.append(f"  Period: last {hours}h | Generated: {now}")
    lines.append("=" * 70)

    if df.empty:
        lines.append("\n  No closed trades in this period.\n")
        return '\n'.join(lines)

    df = df.copy()
    df['pnl_f'] = df['pnl'].astype(float)

    # --- SECTION 1: Overview ---
    total_pnl = df['pnl_f'].sum()
    total_trades = len(df)
    wins = (df['pnl_f'] > 0).sum()
    losses = (df['pnl_f'] <= 0).sum()
    win_rate = wins / total_trades * 100

    lines.append(f"\n  OVERVIEW")
    lines.append(f"  Total Trades: {total_trades} | Wins: {wins} | Losses: {losses}")
    lines.append(f"  Win Rate: {win_rate:.0f}% | Net P&L: ${total_pnl:.4f}")
    lines.append(f"  Best Trade: ${df['pnl_f'].max():.4f} | Worst: ${df['pnl_f'].min():.4f}")

    # --- SECTION 2: Pattern breakdown ---
    lines.append(f"\n  PATTERN PERFORMANCE")
    pattern_data = []
    for pattern in df['pattern'].unique():
        subset = df[df['pattern'] == pattern]
        p_pnl = subset['pnl_f'].sum()
        p_wins = (subset['pnl_f'] > 0).sum()
        p_wr = p_wins / len(subset) * 100
        pattern_data.append([
            pattern, len(subset), f'{p_wr:.0f}%', f'${p_pnl:.4f}',
            f'${subset["pnl_f"].mean():.4f}'
        ])
    lines.append(tabulate(pattern_data,
                          headers=['Pattern', 'N', 'Win%', 'Total', 'Avg'],
                          tablefmt='simple'))

    # --- SECTION 3: Exit analysis ---
    exit_analysis = analyze_exits(df)
    if exit_analysis:
        lines.append(f"\n  EXIT ANALYSIS")
        exit_data = []
        for exit_type, stats in exit_analysis.items():
            exit_data.append([
                exit_type, stats['count'], f"${stats['total_pnl']:.4f}",
                f"${stats['avg_pnl']:.4f}", f"{stats['avg_distance_pct']:.1f}%"
            ])
        lines.append(tabulate(exit_data,
                              headers=['Exit Type', 'N', 'Total P&L', 'Avg P&L', 'Avg Distance'],
                              tablefmt='simple'))

        # SL diagnosis
        sl = exit_analysis.get('SL', {})
        if sl:
            sl_rate = sl['count'] / total_trades * 100
            if sl_rate > 60 and sl.get('avg_distance_pct', 99) < 2.0:
                lines.append(f"\n  WARNING: SL rate is {sl_rate:.0f}% with avg distance "
                             f"{sl['avg_distance_pct']:.1f}% — stops may be too tight")

    # --- SECTION 4: What-if scenarios ---
    lines.append(f"\n  WHAT-IF SCENARIOS: Stop-Loss Distance")
    scenarios = run_whatif_sl(df, [0.5, 0.75, 1.0, 1.5, 2.0, 3.0])
    if scenarios:
        scenario_data = [[
            s['multiplier'], s['sl_distance'], s['trades_saved'],
            f"${s['actual_pnl']:.4f}", f"${s['hypothetical_pnl']:.4f}",
            f"${s['improvement']:+.4f}"
        ] for s in scenarios]
        lines.append(tabulate(scenario_data,
                              headers=['SL Mult', 'Distance', 'Trades Saved',
                                       'Actual P&L', 'Hypothetical', 'Delta'],
                              tablefmt='simple'))

        # Find best scenario
        best = max(scenarios, key=lambda s: s['improvement'])
        if best['improvement'] > 0:
            lines.append(f"\n  SUGGESTION: Using {best['multiplier']} SL distance "
                         f"({best['sl_distance']}) could improve P&L by "
                         f"${best['improvement']:+.4f}")
    else:
        lines.append("  No SL exits to analyze — cannot run what-if scenarios.")

    # --- SECTION 5: Open positions risk ---
    if not open_positions.empty:
        lines.append(f"\n  OPEN POSITIONS ({len(open_positions)})")
        open_data = []
        for _, pos in open_positions.iterrows():
            age_hours = (datetime.now(timezone.utc) - pos['timestamp'].replace(
                tzinfo=timezone.utc)).total_seconds() / 3600
            open_data.append([
                pos['symbol'], pos['pattern'], f"${float(pos['entry_price']):.4f}",
                f"{float(pos['confidence'])*100:.0f}%", f"{age_hours:.1f}h"
            ])
        lines.append(tabulate(open_data,
                              headers=['Symbol', 'Pattern', 'Entry', 'Conf', 'Age'],
                              tablefmt='simple'))

        old_positions = open_positions[
            (datetime.now(timezone.utc) - open_positions['timestamp'].dt.tz_localize(
                timezone.utc)).dt.total_seconds() / 3600 > 12
        ]
        if not old_positions.empty:
            lines.append(f"\n  WARNING: {len(old_positions)} positions older than 12h — "
                         f"consider manual review")

    # --- SECTION 6: Scanner context ---
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
                    lines.append(f"\n  MISSED OPPORTUNITIES (GainerScanner)")
                    for m in missed[:5]:
                        lines.append(f"    {m['symbol']}: +{m['change_24h']:.1f}% (24h) "
                                     f"— not traded")
        except Exception:
            pass

    # --- SECTION 7: Concrete recommendations ---
    lines.append(f"\n  {'='*60}")
    lines.append(f"  ACTION ITEMS")
    lines.append(f"  {'='*60}")

    actions = []

    # Negative EV patterns
    for pattern in df['pattern'].unique():
        subset = df[df['pattern'] == pattern]
        p_pnl = subset['pnl_f'].sum()
        p_wr = (subset['pnl_f'] > 0).sum() / len(subset) * 100
        if p_pnl < 0 and len(subset) >= 3 and p_wr < 40:
            actions.append(f"REDUCE {pattern}: {p_wr:.0f}% win rate over {len(subset)} trades, "
                           f"total P&L ${p_pnl:.4f}. Raise confidence threshold from 65% to 80%.")

    # SL too tight
    sl = exit_analysis.get('SL', {})
    if sl and sl['count'] / total_trades > 0.5:
        actions.append(f"WIDEN SL: {sl['count']}/{total_trades} trades exit via stop-loss "
                       f"(avg distance {sl.get('avg_distance_pct', 0):.1f}%). "
                       f"Try 2.5x ATR instead of 2x ATR in quant.py.")

    # Overtrading
    trades_per_day = total_trades / (hours / 24)
    if trades_per_day > 8:
        actions.append(f"REDUCE FREQUENCY: {trades_per_day:.0f} trades/day is high for $17 capital. "
                       f"Lower MAX_TRADES_PER_DAY from 6 to 4.")

    if not actions:
        actions.append("No urgent actions. System performing within acceptable parameters.")

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
```

**Step 2: Run the morning report**

Run: `cd /home/azureuser/cryonix && python3 scripts/strategy-lab/morning_report.py --hours 48`
Expected: Full formatted report with all 7 sections

**Step 3: Test with file output**

Run: `cd /home/azureuser/cryonix && python3 scripts/strategy-lab/morning_report.py --hours 48 --save /tmp/morning-report.txt && cat /tmp/morning-report.txt | head -30`
Expected: Report saved and readable

**Step 4: Commit**

```bash
git add scripts/strategy-lab/morning_report.py
git commit -m "feat(strategy-lab): add morning report with what-if scenarios"
```

---

## Task 4: Runner script and cron setup

**Files:**
- Create: `scripts/strategy-lab/run.sh`

**Step 1: Write the runner script**

```bash
#!/bin/bash
# Strategy Lab: Run calibration + morning report
# Intended to run daily at 06:00 UTC (after overnight trading)

set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$DIR/../.." && pwd)"
LOG_DIR="$PROJECT_ROOT/logs/strategy-lab"
DATE=$(date -u +%Y-%m-%d)

mkdir -p "$LOG_DIR"

echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Strategy Lab starting..."

# Step 1: Run calibration (updates Redis)
echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Running calibration..."
python3 "$DIR/calibrate.py" --days 30 --min-trades 2 2>&1 | tee "$LOG_DIR/calibration-$DATE.log"

# Step 2: Run morning report
echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Generating morning report..."
python3 "$DIR/morning_report.py" --hours 24 --save "$LOG_DIR/report-$DATE.txt" 2>&1 | tee -a "$LOG_DIR/report-$DATE.log"

echo "[$(date -u '+%Y-%m-%d %H:%M:%S')] Strategy Lab complete."
echo "Report saved to: $LOG_DIR/report-$DATE.txt"
```

**Step 2: Make executable and test**

Run: `chmod +x /home/azureuser/cryonix/scripts/strategy-lab/run.sh && /home/azureuser/cryonix/scripts/strategy-lab/run.sh`
Expected: Both scripts run successfully, logs in `logs/strategy-lab/`

**Step 3: Add to crontab (06:00 UTC daily)**

```bash
# Add to existing crontab:
# 0 6 * * * cd /home/azureuser/cryonix && bash scripts/strategy-lab/run.sh >> /tmp/strategy-lab.log 2>&1
```

Note: Do NOT add automatically — present the cron line to the user for manual approval.

**Step 4: Commit**

```bash
git add scripts/strategy-lab/run.sh
git commit -m "feat(strategy-lab): add runner script for daily execution"
```

---

## Task 5: Replace flaky calibration cron

**Files:**
- Modify: user's crontab

**Step 1: Verify the new calibration works better than the old one**

Run both and compare:
```bash
# Old (API route via HTTP):
curl -s -X POST https://cryonix.kvarnsmyr.se/api/calibration | python3 -m json.tool | head -5

# New (direct Python):
python3 /home/azureuser/cryonix/scripts/strategy-lab/calibrate.py --days 30 --json | head -5

# Check Redis was populated:
docker exec $(docker ps -q -f name=redis) redis-cli TTL calibration:patterns
```

Expected: New script succeeds and Redis has data. Old API route may return empty/error.

**Step 2: Update crontab to use new calibration**

Present the user with the proposed change:
```
# OLD (replace this):
0 */6 * * * cd /home/azureuser/cryonix && bash scripts/run_calibration.sh >> /tmp/calibration-cron.log 2>&1

# NEW:
0 */6 * * * cd /home/azureuser/cryonix && python3 scripts/strategy-lab/calibrate.py --days 30 >> /tmp/calibration-cron.log 2>&1
```

**Step 3: Commit all remaining changes**

```bash
git add -A scripts/strategy-lab/
git commit -m "feat(strategy-lab): complete v1 — calibration engine + morning report"
```

---

## Summary of deliverables

| Script | Purpose | Schedule |
|--------|---------|----------|
| `calibrate.py` | Calculate EV/weights per pattern, write to Redis | Every 6h (replaces old cron) |
| `morning_report.py` | What-if scenarios, exit analysis, recommendations | Daily at 06:00 UTC |
| `run.sh` | Runs both scripts, saves logs | Daily at 06:00 UTC |
| `db.py` | Shared DB/Redis connection helper | (library) |

## How it integrates with existing Cryonix

```
                    EXISTING                          NEW (Strategy Lab)
                    --------                          ------------------

  Cryonix Engine    Auto-Trader    Copilot Evolution   Strategy Lab
  (Python, 10s)    (Node, 30s)    (Node, nightly)     (Python, daily)
       |                |               |                    |
       |  signals       |  execute      |  mutate code       |  analyze only
       v                v               v                    v
  Redis:pending    Binance API     quant.py edits     Redis:calibration
                                                      + stdout report
                                                      + logs/strategy-lab/

  WRITES to Redis   READS Redis     READS Postgres     READS Postgres
  WRITES to PG      WRITES to PG    WRITES code        WRITES Redis (calibration)
                    READS Redis     DEPLOYS Docker      NEVER touches code/execution
```

**Key principle:** Strategy Lab READS the same data as everyone else, WRITES only to the calibration Redis key (which auto-trade already reads), and generates reports. It never modifies source code or executes trades.
