#!/usr/bin/env python3
"""
Strategy Lab: Self-Calibration — Prediction Accuracy Tracker

Compares yesterday's signal predictions against actual outcomes to measure
how well our pattern detectors and filters are performing.

Metrics produced:
  - Per-pattern hit rate (predicted direction vs actual)
  - Acted hit rate vs skipped hit rate (filter effectiveness)
  - Overall filter effectiveness score
  - Opportunity cost analysis for skipped signals

Writes results to:
  - Redis key 'calibration:accuracy' (TTL 48h)
  - stdout as formatted tables (for human review)
  - Optional: JSON output for piping

Usage:
  python3 scripts/strategy-lab/self_calibrate.py [--hours 24] [--json] [--verbose] [--no-redis]
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone, timedelta

from tabulate import tabulate

sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg, get_redis

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
DIRECTION_THRESHOLD_PCT = 0.5  # must move >0.5% to count as "would have won"
REDIS_TTL = 48 * 3600         # 48 hours
TRADE_MATCH_WINDOW_SEC = 300   # match signal→trade within 5 min window


# ---------------------------------------------------------------------------
# 1. Fetch Signals
# ---------------------------------------------------------------------------
def fetch_signals(pg, hours: int, verbose: bool = False) -> list[dict]:
    """Fetch all signals from the lookback window."""
    cur = pg.cursor()
    cur.execute("""
        SELECT
            id, symbol, action, confidence, pattern,
            entry_price, executed, timestamp, metadata
        FROM signals
        WHERE timestamp > NOW() - INTERVAL '%s hours'
        ORDER BY timestamp DESC
    """ % int(hours))
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close()
    if verbose:
        print(f"  [debug] Fetched {len(rows)} signals from last {hours}h")
    return rows


# ---------------------------------------------------------------------------
# 2. Fetch Trades in the lookback window & match to signals
# ---------------------------------------------------------------------------
def fetch_trades(pg, hours: int, verbose: bool = False) -> list[dict]:
    """Fetch all trades within the lookback window."""
    cur = pg.cursor()
    cur.execute("""
        SELECT
            id, symbol, side, entry_price, exit_price,
            pnl, status, quantity, pattern, timestamp
        FROM trades
        WHERE timestamp > NOW() - INTERVAL '%s hours'
        ORDER BY timestamp DESC
    """ % int(hours))
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close()
    if verbose:
        print(f"  [debug] Fetched {len(rows)} trades from last {hours}h")
    return rows


def match_signals_to_trades(signals: list[dict], trades: list[dict]) -> dict:
    """
    Match signals to trades by symbol + side/action + timestamp proximity.
    Returns dict keyed by signal id → trade dict (or None).
    """
    # Index trades by (symbol, side) for faster lookup
    trade_index = defaultdict(list)
    for t in trades:
        key = (t['symbol'], t['side'])
        trade_index[key].append(t)

    matched = {}
    used_trade_ids = set()

    for sig in signals:
        key = (sig['symbol'], sig['action'])
        candidates = trade_index.get(key, [])
        best_trade = None
        best_delta = timedelta.max

        for t in candidates:
            if t['id'] in used_trade_ids:
                continue
            delta = abs(t['timestamp'] - sig['timestamp'])
            if delta < best_delta and delta.total_seconds() <= TRADE_MATCH_WINDOW_SEC:
                best_delta = delta
                best_trade = t

        if best_trade:
            matched[sig['id']] = best_trade
            used_trade_ids.add(best_trade['id'])
        else:
            matched[sig['id']] = None

    return matched


# ---------------------------------------------------------------------------
# 3. Fetch current prices for skipped signals
# ---------------------------------------------------------------------------
def fetch_current_prices(symbols: list, verbose: bool = False) -> dict:
    """Fetch current prices from Binance via CCXT for the given symbols."""
    if not symbols:
        return {}

    try:
        import ccxt
    except ImportError:
        if verbose:
            print("  [warn] ccxt not installed — skipping live price checks")
        return {}

    api_key = os.environ.get('BINANCE_API_KEY')
    api_secret = os.environ.get('BINANCE_API_SECRET')
    if not api_key or not api_secret:
        if verbose:
            print("  [warn] BINANCE_API_KEY/SECRET not set — skipping live price checks")
        return {}

    try:
        exchange = ccxt.binance({
            'apiKey': api_key,
            'secret': api_secret,
            'enableRateLimit': True,
        })
        prices = {}
        unique_symbols = list(set(symbols))
        for sym in unique_symbols:
            try:
                ticker = exchange.fetch_ticker(sym)
                prices[sym] = float(ticker.get('last', 0) or 0)
            except Exception:
                if verbose:
                    print(f"  [warn] Could not fetch price for {sym}")
        return prices
    except Exception as e:
        if verbose:
            print(f"  [warn] CCXT error: {e}")
        return {}


# ---------------------------------------------------------------------------
# 4. Classify signal outcomes
# ---------------------------------------------------------------------------
def classify_signal(signal: dict, trade: dict | None,
                    current_prices: dict) -> dict:
    """
    Classify a signal's outcome.

    Returns dict with:
      acted: bool
      outcome: 'win' | 'loss' | 'would_have_won' | 'would_have_lost' | 'inconclusive'
      correct_direction: bool | None
      pnl: float | None
    """
    action = (signal.get('action') or '').upper()
    entry_price = float(signal.get('entry_price') or 0)
    # A signal is "acted on" if a trade was matched OR executed flag is set
    acted = trade is not None or bool(signal.get('executed'))

    # Acted signal with a matched closed trade
    if acted and trade and trade.get('status') == 'CLOSED' and trade.get('pnl') is not None:
        pnl = float(trade['pnl'])
        correct = pnl > 0
        return {
            'acted': True,
            'outcome': 'win' if correct else 'loss',
            'correct_direction': correct,
            'pnl': pnl,
        }

    # Acted signal with still-open trade
    if acted and trade and trade.get('status') == 'FILLED':
        return {
            'acted': True,
            'outcome': 'inconclusive',
            'correct_direction': None,
            'pnl': None,
        }

    # Acted but no matching trade found (edge case)
    if acted and not trade:
        return {
            'acted': True,
            'outcome': 'inconclusive',
            'correct_direction': None,
            'pnl': None,
        }

    # Signal was skipped (executed=false) — check hypothetical
    symbol = signal.get('symbol', '')
    current_price = current_prices.get(symbol)

    if not current_price or entry_price <= 0:
        return {
            'acted': False,
            'outcome': 'inconclusive',
            'correct_direction': None,
            'pnl': None,
        }

    move_pct = (current_price - entry_price) / entry_price * 100

    if action == 'BUY':
        if move_pct > DIRECTION_THRESHOLD_PCT:
            return {'acted': False, 'outcome': 'would_have_won',
                    'correct_direction': True, 'pnl': None}
        elif move_pct < -DIRECTION_THRESHOLD_PCT:
            return {'acted': False, 'outcome': 'would_have_lost',
                    'correct_direction': False, 'pnl': None}
    elif action == 'SELL':
        if move_pct < -DIRECTION_THRESHOLD_PCT:
            return {'acted': False, 'outcome': 'would_have_won',
                    'correct_direction': True, 'pnl': None}
        elif move_pct > DIRECTION_THRESHOLD_PCT:
            return {'acted': False, 'outcome': 'would_have_lost',
                    'correct_direction': False, 'pnl': None}

    return {
        'acted': False,
        'outcome': 'inconclusive',
        'correct_direction': None,
        'pnl': None,
    }


# ---------------------------------------------------------------------------
# 5. Compute metrics
# ---------------------------------------------------------------------------
def compute_metrics(signals: list, signal_trade_map: dict,
                    current_prices: dict) -> dict:
    """
    Compute per-pattern and overall accuracy metrics.

    Returns {
      'patterns': { pattern_name: { ... metrics ... }, ... },
      'symbols': { symbol: { ... metrics ... }, ... },
      'overall': { ... aggregate metrics ... },
    }
    """
    pattern_buckets = defaultdict(list)
    symbol_buckets = defaultdict(list)
    all_results = []

    for sig in signals:
        trade = signal_trade_map.get(sig['id'])
        result = classify_signal(sig, trade, current_prices)
        result['signal'] = sig

        all_results.append(result)

        # Group by pattern(s) — comma-separated in DB
        patterns_str = sig.get('pattern') or ''
        patterns = [p.strip() for p in patterns_str.split(',') if p.strip()]
        if not patterns:
            patterns = ['UNKNOWN']
        for pat in patterns:
            pattern_buckets[pat].append(result)

        # Group by symbol
        symbol_buckets[sig.get('symbol', 'UNKNOWN')].append(result)

    pattern_metrics = {}
    for pat, results in pattern_buckets.items():
        pattern_metrics[pat] = _bucket_metrics(results)

    symbol_metrics = {}
    for sym, results in symbol_buckets.items():
        symbol_metrics[sym] = _bucket_metrics(results)

    overall = _bucket_metrics(all_results)

    return {
        'patterns': pattern_metrics,
        'symbols': symbol_metrics,
        'overall': overall,
    }


def _bucket_metrics(results: list) -> dict:
    """Compute accuracy metrics for a bucket of classified results."""
    total = len(results)
    acted = [r for r in results if r['acted']]
    skipped = [r for r in results if not r['acted']]

    # Overall direction accuracy (excluding inconclusive)
    directional = [r for r in results if r['correct_direction'] is not None]
    hits = sum(1 for r in directional if r['correct_direction'])
    hit_rate = (hits / len(directional) * 100) if directional else 0.0

    # Acted accuracy
    acted_directional = [r for r in acted if r['correct_direction'] is not None]
    acted_hits = sum(1 for r in acted_directional if r['correct_direction'])
    acted_hit_rate = (acted_hits / len(acted_directional) * 100) if acted_directional else 0.0

    # Skipped accuracy (opportunity cost)
    skipped_directional = [r for r in skipped if r['correct_direction'] is not None]
    skipped_hits = sum(1 for r in skipped_directional if r['correct_direction'])
    skipped_hit_rate = (skipped_hits / len(skipped_directional) * 100) if skipped_directional else 0.0

    # Filter effectiveness: positive = filters help, negative = filtering too much
    filter_effectiveness = (acted_hit_rate - skipped_hit_rate) if (
        acted_directional and skipped_directional) else None

    # P&L for acted trades
    acted_pnls = [r['pnl'] for r in acted if r['pnl'] is not None]
    total_pnl = sum(acted_pnls) if acted_pnls else 0.0
    avg_pnl = (total_pnl / len(acted_pnls)) if acted_pnls else 0.0

    # Outcome counts
    outcome_counts = defaultdict(int)
    for r in results:
        outcome_counts[r['outcome']] += 1

    return {
        'total_signals': total,
        'acted_count': len(acted),
        'skipped_count': len(skipped),
        'hit_rate': round(hit_rate, 1),
        'acted_hit_rate': round(acted_hit_rate, 1),
        'skipped_hit_rate': round(skipped_hit_rate, 1),
        'filter_effectiveness': round(filter_effectiveness, 1) if filter_effectiveness is not None else None,
        'total_pnl': round(total_pnl, 6),
        'avg_pnl': round(avg_pnl, 6),
        'wins': outcome_counts.get('win', 0),
        'losses': outcome_counts.get('loss', 0),
        'would_have_won': outcome_counts.get('would_have_won', 0),
        'would_have_lost': outcome_counts.get('would_have_lost', 0),
        'inconclusive': outcome_counts.get('inconclusive', 0),
    }


# ---------------------------------------------------------------------------
# 6. Write to Redis
# ---------------------------------------------------------------------------
def write_to_redis(redis_client, metrics: dict, hours: int):
    """Write accuracy metrics to Redis with 48h TTL."""
    payload = {
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'lookback_hours': hours,
        'overall': metrics['overall'],
        'patterns': metrics['patterns'],
        'symbols': metrics['symbols'],
    }
    redis_client.set('calibration:accuracy', json.dumps(payload), ex=REDIS_TTL)
    return payload


# ---------------------------------------------------------------------------
# 7. Report
# ---------------------------------------------------------------------------
def print_report(metrics: dict, hours: int, verbose: bool = False):
    """Print formatted self-calibration report to stdout."""
    overall = metrics['overall']
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

    print("\n" + "=" * 70)
    print("  SELF-CALIBRATION REPORT — Signal Prediction Accuracy")
    print(f"  Period: last {hours}h | Generated: {now}")
    print("=" * 70)

    # --- Overall ---
    print(f"\n  1. OVERALL METRICS")
    print(f"  {'-'*50}")
    overview_data = [
        ['Total signals', overall['total_signals']],
        ['Acted on', f"{overall['acted_count']} ({_pct(overall['acted_count'], overall['total_signals'])}%)"],
        ['Skipped/Expired', f"{overall['skipped_count']} ({_pct(overall['skipped_count'], overall['total_signals'])}%)"],
        ['', ''],
        ['Overall hit rate', f"{overall['hit_rate']}%"],
        ['Acted hit rate', f"{overall['acted_hit_rate']}%"],
        ['Skipped hit rate', f"{overall['skipped_hit_rate']}%"],
        ['Filter effectiveness', _format_effectiveness(overall['filter_effectiveness'])],
        ['', ''],
        ['Wins (traded)', overall['wins']],
        ['Losses (traded)', overall['losses']],
        ['Would have won (skipped)', overall['would_have_won']],
        ['Would have lost (skipped)', overall['would_have_lost']],
        ['Inconclusive', overall['inconclusive']],
        ['', ''],
        ['Total P&L (acted)', f"${overall['total_pnl']:.6f}"],
        ['Avg P&L per trade', f"${overall['avg_pnl']:.6f}"],
    ]
    print(tabulate(overview_data, tablefmt='simple'))

    # --- Per-pattern ---
    patterns = metrics.get('patterns', {})
    if patterns:
        print(f"\n  2. PER-PATTERN ACCURACY")
        print(f"  {'-'*50}")
        pat_data = []
        for pat, m in sorted(patterns.items(), key=lambda x: x[1]['total_signals'], reverse=True):
            pat_data.append([
                pat,
                m['total_signals'],
                m['acted_count'],
                m['skipped_count'],
                f"{m['hit_rate']}%",
                f"{m['acted_hit_rate']}%",
                f"{m['skipped_hit_rate']}%",
                _format_effectiveness(m['filter_effectiveness']),
            ])
        headers = ['Pattern', 'Signals', 'Acted', 'Skipped',
                    'Hit%', 'Act%', 'Skip%', 'Filter']
        print(tabulate(pat_data, headers=headers, tablefmt='simple'))

    # --- Per-symbol (verbose only) ---
    symbols = metrics.get('symbols', {})
    if verbose and symbols:
        print(f"\n  3. PER-SYMBOL ACCURACY")
        print(f"  {'-'*50}")
        sym_data = []
        for sym, m in sorted(symbols.items(), key=lambda x: x[1]['total_signals'], reverse=True):
            sym_data.append([
                sym,
                m['total_signals'],
                m['acted_count'],
                m['skipped_count'],
                f"{m['hit_rate']}%",
                f"{m['acted_hit_rate']}%",
                f"{m['skipped_hit_rate']}%",
            ])
        headers = ['Symbol', 'Signals', 'Acted', 'Skipped', 'Hit%', 'Act%', 'Skip%']
        print(tabulate(sym_data, headers=headers, tablefmt='simple'))

    # --- Recommendations ---
    section_num = 4 if verbose else 3
    print(f"\n  {section_num}. RECOMMENDATIONS")
    print(f"  {'-'*50}")
    recs = _generate_recommendations(metrics)
    if recs:
        for i, rec in enumerate(recs, 1):
            print(f"  {i}. {rec}")
    else:
        print("  No actionable recommendations at this time.")

    print("")


def _pct(part: int, total: int) -> str:
    """Format percentage safely."""
    return f"{part / total * 100:.0f}" if total > 0 else "0"


def _format_effectiveness(val) -> str:
    """Format filter effectiveness score."""
    if val is None:
        return "N/A"
    sign = "+" if val > 0 else ""
    label = "filters help" if val > 0 else "over-filtering" if val < 0 else "neutral"
    return f"{sign}{val:.1f}pp ({label})"


def _generate_recommendations(metrics: dict) -> list[str]:
    """Generate actionable recommendations from the metrics."""
    recs = []
    overall = metrics['overall']

    # Check filter effectiveness
    fe = overall.get('filter_effectiveness')
    if fe is not None:
        if fe < -5:
            recs.append(
                f"LOOSEN FILTERS: Skipped signals hit rate ({overall['skipped_hit_rate']}%) "
                f"exceeds acted ({overall['acted_hit_rate']}%) by {abs(fe):.1f}pp — "
                f"we're filtering out good signals.")
        elif fe > 10:
            recs.append(
                f"FILTERS WORKING WELL: Acted accuracy ({overall['acted_hit_rate']}%) "
                f"beats skipped ({overall['skipped_hit_rate']}%) by {fe:.1f}pp.")

    # Patterns with low accuracy
    for pat, m in metrics.get('patterns', {}).items():
        if m['total_signals'] >= 5 and m['hit_rate'] < 40:
            recs.append(
                f"REDUCE {pat}: Only {m['hit_rate']}% hit rate over "
                f"{m['total_signals']} signals — consider raising confidence threshold.")

    # Patterns where skipped > acted
    for pat, m in metrics.get('patterns', {}).items():
        fe_pat = m.get('filter_effectiveness')
        if fe_pat is not None and fe_pat < -10 and m['skipped_count'] >= 3:
            recs.append(
                f"REVIEW {pat}: Skipped signals ({m['skipped_hit_rate']}%) outperform "
                f"acted ({m['acted_hit_rate']}%) by {abs(fe_pat):.1f}pp — revisit filter logic.")

    # High skip rate
    if overall['total_signals'] > 0:
        skip_pct = overall['skipped_count'] / overall['total_signals'] * 100
        if skip_pct > 80:
            recs.append(
                f"HIGH SKIP RATE: {skip_pct:.0f}% of signals skipped. "
                f"Consider whether signal generation or filters need adjustment.")

    return recs


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description='Strategy Lab: Self-Calibration — Prediction Accuracy')
    parser.add_argument('--hours', type=int, default=24,
                        help='Lookback window in hours (default: 24)')
    parser.add_argument('--json', action='store_true',
                        help='Output JSON instead of formatted table')
    parser.add_argument('--verbose', action='store_true',
                        help='Show per-symbol breakdown and debug info')
    parser.add_argument('--no-redis', action='store_true',
                        help='Skip writing to Redis')
    args = parser.parse_args()

    pg = get_pg()
    try:
        # 1. Fetch signals
        signals = fetch_signals(pg, args.hours, verbose=args.verbose)
        print(f"Fetched {len(signals)} signals from last {args.hours}h")

        if not signals:
            print("No signals found in the lookback window.")
            return

        # 2. Fetch trades and match to signals
        trades = fetch_trades(pg, args.hours, verbose=args.verbose)
        signal_trade_map = match_signals_to_trades(signals, trades)
        matched_count = sum(1 for v in signal_trade_map.values() if v is not None)
        if args.verbose:
            print(f"  [debug] Matched {matched_count} signals to trades")

        # 3. Fetch current prices for skipped signals
        skipped_symbols = [
            s['symbol'] for s in signals
            if not s.get('executed')
        ]
        current_prices = fetch_current_prices(
            skipped_symbols, verbose=args.verbose)
        if args.verbose:
            print(f"  [debug] Fetched prices for {len(current_prices)} symbols")

        # 4. Compute metrics
        metrics = compute_metrics(signals, signal_trade_map, current_prices)

        # 5. Write to Redis
        if not args.no_redis:
            r = get_redis()
            try:
                write_to_redis(r, metrics, args.hours)
                print(f"Wrote calibration:accuracy to Redis (TTL {REDIS_TTL // 3600}h)")
            finally:
                r.close()

        # 6. Output
        if args.json:
            output = {
                'generated_at': datetime.now(timezone.utc).isoformat(),
                'lookback_hours': args.hours,
                'overall': metrics['overall'],
                'patterns': metrics['patterns'],
                'symbols': metrics['symbols'],
            }
            print(json.dumps(output, indent=2))
        else:
            print_report(metrics, args.hours, verbose=args.verbose)

    finally:
        pg.close()


if __name__ == '__main__':
    main()
