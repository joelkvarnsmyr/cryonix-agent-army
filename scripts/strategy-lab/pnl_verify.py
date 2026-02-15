#!/usr/bin/env python3
"""
Strategy Lab: P&L Verification

Compares Postgres trade history P&L against actual Binance balance changes.
Detects discrepancies, orphaned positions, and inconsistencies between
Postgres, Redis, and the exchange.

Usage:
  python3 scripts/strategy-lab/pnl_verify.py [--days 7] [--json] [--verbose]
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

from tabulate import tabulate

sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg, get_redis

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
STARTING_BALANCE = 42.0  # approximate seed capital in USDC
QUOTE_CURRENCY = "USDC"


# ---------------------------------------------------------------------------
# 1. Postgres P&L Summary
# ---------------------------------------------------------------------------
def fetch_pnl_summary(pg, days: int, verbose: bool = False) -> dict:
    """Sum closed trade P&L, count wins/losses within lookback window."""
    cur = pg.cursor()
    cur.execute("""
        SELECT
            COUNT(*)                                        AS total,
            COALESCE(SUM(pnl), 0)                           AS total_pnl,
            COUNT(*) FILTER (WHERE pnl > 0)                 AS wins,
            COUNT(*) FILTER (WHERE pnl <= 0)                AS losses,
            COALESCE(MAX(pnl), 0)                           AS best,
            COALESCE(MIN(pnl), 0)                           AS worst,
            COALESCE(AVG(pnl), 0)                           AS avg_pnl
        FROM trades
        WHERE status = 'CLOSED'
          AND pnl IS NOT NULL
          AND timestamp > NOW() - INTERVAL '%s days'
    """ % int(days))
    row = cur.fetchone()
    cols = [d[0] for d in cur.description]
    summary = dict(zip(cols, row))

    # Estimate fees from reasoning or metadata if available
    cur.execute("""
        SELECT COALESCE(SUM(
            CASE WHEN reasoning ILIKE '%%fee%%' THEN 0 ELSE 0 END
        ), 0) AS total_fees
        FROM trades
        WHERE status = 'CLOSED'
          AND timestamp > NOW() - INTERVAL '%s days'
    """ % int(days))
    # Binance spot fee ~0.1% per side; estimate from trade volume
    cur.execute("""
        SELECT COALESCE(SUM(ABS(quantity * entry_price) + ABS(quantity * exit_price)), 0)
        FROM trades
        WHERE status = 'CLOSED'
          AND pnl IS NOT NULL
          AND timestamp > NOW() - INTERVAL '%s days'
    """ % int(days))
    total_volume = float(cur.fetchone()[0])
    estimated_fees = total_volume * 0.001  # 0.1% taker fee both sides

    summary['estimated_fees'] = round(estimated_fees, 6)
    summary['total_volume'] = round(total_volume, 4)

    if verbose:
        cur.execute("""
            SELECT id, symbol, side, pnl, entry_price, exit_price, quantity, timestamp
            FROM trades
            WHERE status = 'CLOSED'
              AND pnl IS NOT NULL
              AND timestamp > NOW() - INTERVAL '%s days'
            ORDER BY timestamp DESC
        """ % int(days))
        trade_cols = [d[0] for d in cur.description]
        summary['trades'] = [dict(zip(trade_cols, r)) for r in cur.fetchall()]

    cur.close()
    return summary


# ---------------------------------------------------------------------------
# 2. Binance Balance Snapshot
# ---------------------------------------------------------------------------
def fetch_binance_balances(verbose: bool = False) -> dict:
    """Fetch current balances from Binance via CCXT."""
    try:
        import ccxt
    except ImportError:
        return {"error": "ccxt not installed (pip install ccxt)"}

    api_key = os.environ.get('BINANCE_API_KEY')
    api_secret = os.environ.get('BINANCE_API_SECRET')
    if not api_key or not api_secret:
        return {"error": "BINANCE_API_KEY / BINANCE_API_SECRET not set"}

    try:
        exchange = ccxt.binance({
            'apiKey': api_key,
            'secret': api_secret,
            'enableRateLimit': True,
        })
        balance = exchange.fetch_balance()
    except ccxt.BaseError as e:
        return {"error": f"Binance API error: {e}"}
    except Exception as e:
        return {"error": f"Unexpected error: {e}"}

    # USDC balance
    usdc = float(balance.get(QUOTE_CURRENCY, {}).get('total', 0) or 0)

    # Non-dust crypto holdings (value > $0.01)
    holdings = []
    total_crypto_value = 0.0
    for currency, amounts in balance.get('total', {}).items():
        amt = float(amounts or 0)
        if amt <= 0 or currency == QUOTE_CURRENCY:
            continue
        # Fetch ticker to get USD value
        pair = f"{currency}/{QUOTE_CURRENCY}"
        try:
            ticker = exchange.fetch_ticker(pair)
            price = float(ticker.get('last', 0) or 0)
        except Exception:
            price = 0.0
        value = amt * price
        if value < 0.01:
            continue
        total_crypto_value += value
        holdings.append({
            'currency': currency,
            'amount': amt,
            'price': price,
            'value': round(value, 4),
            'pair': pair,
        })

    return {
        'usdc_balance': round(usdc, 4),
        'crypto_value': round(total_crypto_value, 4),
        'total_value': round(usdc + total_crypto_value, 4),
        'holdings': sorted(holdings, key=lambda h: h['value'], reverse=True),
        'error': None,
    }


# ---------------------------------------------------------------------------
# 3. Comparison
# ---------------------------------------------------------------------------
def compare_pnl(pg_summary: dict, binance: dict) -> dict:
    """Compare expected balance (DB) against actual balance (Binance)."""
    if binance.get('error'):
        return {'error': binance['error']}

    total_pnl = float(pg_summary.get('total_pnl', 0))
    estimated_fees = float(pg_summary.get('estimated_fees', 0))
    expected = STARTING_BALANCE + total_pnl - estimated_fees
    actual = binance['total_value']
    discrepancy = actual - expected
    pct = (abs(discrepancy) / expected * 100) if expected != 0 else 0.0

    if pct > 5:
        severity = 'CRITICAL'
    elif pct > 1:
        severity = 'WARNING'
    else:
        severity = 'OK'

    return {
        'starting_balance': STARTING_BALANCE,
        'db_pnl': round(total_pnl, 6),
        'estimated_fees': round(estimated_fees, 6),
        'expected_balance': round(expected, 4),
        'actual_balance': round(actual, 4),
        'discrepancy': round(discrepancy, 4),
        'discrepancy_pct': round(pct, 2),
        'severity': severity,
        'error': None,
    }


# ---------------------------------------------------------------------------
# 4. Orphaned Position Check
# ---------------------------------------------------------------------------
def fetch_db_open_positions(pg) -> list[dict]:
    """Fetch positions marked as open/FILLED in Postgres."""
    cur = pg.cursor()
    cur.execute("""
        SELECT id, symbol, side, quantity, entry_price, timestamp
        FROM trades
        WHERE status = 'FILLED'
        ORDER BY timestamp
    """)
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, r)) for r in cur.fetchall()]
    cur.close()
    return rows


def fetch_redis_positions(redis_client) -> list[dict]:
    """Fetch open positions stored in Redis."""
    try:
        raw = redis_client.get('positions:open')
        if not raw:
            return []
        data = json.loads(raw)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def check_orphaned(db_positions: list, redis_positions: list,
                   binance_holdings: list) -> dict:
    """Cross-reference DB, Redis, and Binance for orphaned positions."""
    db_symbols = {p['symbol'] for p in db_positions}
    redis_symbols = {p.get('symbol', '') for p in redis_positions}
    binance_symbols = {h['pair'] for h in binance_holdings}

    # DB says open but Binance has nothing
    db_no_binance = db_symbols - binance_symbols
    # Binance has holding but DB has no open record
    binance_no_db = binance_symbols - db_symbols
    # Redis vs DB mismatches
    redis_no_db = redis_symbols - db_symbols
    db_no_redis = db_symbols - redis_symbols

    return {
        'db_open_count': len(db_positions),
        'redis_open_count': len(redis_positions),
        'binance_holding_count': len(binance_holdings),
        'db_symbols': sorted(db_symbols),
        'redis_symbols': sorted(redis_symbols),
        'binance_symbols': sorted(binance_symbols),
        'db_no_binance': sorted(db_no_binance),
        'binance_no_db': sorted(binance_no_db),
        'redis_no_db': sorted(redis_no_db),
        'db_no_redis': sorted(db_no_redis),
    }


# ---------------------------------------------------------------------------
# 5. Report
# ---------------------------------------------------------------------------
def print_report(pg_summary: dict, binance: dict, comparison: dict,
                 orphaned: dict, days: int, verbose: bool):
    """Print formatted verification report to stdout."""
    now = datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')

    print("=" * 70)
    print("  CRYONIX P&L VERIFICATION REPORT")
    print(f"  Lookback: {days} days | Generated: {now}")
    print("=" * 70)

    # --- Section 1: Postgres P&L ---
    print(f"\n  1. POSTGRES TRADE HISTORY (last {days}d)")
    print(f"  {'-'*50}")
    total = int(pg_summary.get('total', 0))
    wins = int(pg_summary.get('wins', 0))
    losses = int(pg_summary.get('losses', 0))
    win_rate = (wins / total * 100) if total > 0 else 0.0
    pnl_data = [
        ['Closed trades', total],
        ['Wins / Losses', f"{wins} / {losses}"],
        ['Win rate', f"{win_rate:.1f}%"],
        ['Total P&L', f"${float(pg_summary.get('total_pnl', 0)):.6f}"],
        ['Best trade', f"${float(pg_summary.get('best', 0)):.6f}"],
        ['Worst trade', f"${float(pg_summary.get('worst', 0)):.6f}"],
        ['Avg trade', f"${float(pg_summary.get('avg_pnl', 0)):.6f}"],
        ['Total volume', f"${pg_summary.get('total_volume', 0):.4f}"],
        ['Est. fees (0.1%)', f"${pg_summary.get('estimated_fees', 0):.6f}"],
    ]
    print(tabulate(pnl_data, tablefmt='simple'))

    if verbose and pg_summary.get('trades'):
        print(f"\n  Trade details:")
        trade_rows = []
        for t in pg_summary['trades']:
            trade_rows.append([
                t['id'], t['symbol'], t['side'],
                f"${float(t['pnl']):.6f}",
                f"${float(t['entry_price']):.4f}",
                f"${float(t['exit_price']):.4f}",
                str(t['timestamp'])[:19],
            ])
        print(tabulate(trade_rows,
                       headers=['ID', 'Symbol', 'Side', 'P&L',
                                'Entry', 'Exit', 'Time'],
                       tablefmt='simple'))

    # --- Section 2: Binance Balance ---
    print(f"\n  2. BINANCE BALANCE SNAPSHOT")
    print(f"  {'-'*50}")
    if binance.get('error'):
        print(f"  ERROR: {binance['error']}")
    else:
        bal_data = [
            ['USDC balance', f"${binance['usdc_balance']:.4f}"],
            ['Crypto value', f"${binance['crypto_value']:.4f}"],
            ['Total portfolio', f"${binance['total_value']:.4f}"],
        ]
        print(tabulate(bal_data, tablefmt='simple'))

        if binance.get('holdings') and verbose:
            print(f"\n  Holdings:")
            hold_rows = [[
                h['currency'], f"{h['amount']:.6f}",
                f"${h['price']:.6f}", f"${h['value']:.4f}"
            ] for h in binance['holdings']]
            print(tabulate(hold_rows,
                           headers=['Asset', 'Amount', 'Price', 'Value'],
                           tablefmt='simple'))

    # --- Section 3: Comparison ---
    print(f"\n  3. P&L COMPARISON")
    print(f"  {'-'*50}")
    if comparison.get('error'):
        print(f"  ERROR: {comparison['error']}")
    else:
        sev = comparison['severity']
        marker = '  ' if sev == 'OK' else f'  [{sev}] '
        cmp_data = [
            ['Starting balance', f"${comparison['starting_balance']:.2f}"],
            ['+ DB P&L', f"${comparison['db_pnl']:.6f}"],
            ['- Est. fees', f"${comparison['estimated_fees']:.6f}"],
            ['= Expected balance', f"${comparison['expected_balance']:.4f}"],
            ['Actual balance', f"${comparison['actual_balance']:.4f}"],
            [f'{marker}Discrepancy',
             f"${comparison['discrepancy']:+.4f} ({comparison['discrepancy_pct']:.2f}%)"],
        ]
        print(tabulate(cmp_data, tablefmt='simple'))

        if sev == 'CRITICAL':
            print(f"\n  ** CRITICAL: Discrepancy > 5% -- investigate immediately **")
        elif sev == 'WARNING':
            print(f"\n  ** WARNING: Discrepancy > 1% -- review recent trades **")

    # --- Section 4: Orphaned Positions ---
    print(f"\n  4. POSITION CROSS-CHECK")
    print(f"  {'-'*50}")
    source_data = [
        ['Postgres (FILLED)', orphaned['db_open_count'],
         ', '.join(orphaned['db_symbols']) or 'none'],
        ['Redis (positions:open)', orphaned['redis_open_count'],
         ', '.join(orphaned['redis_symbols']) or 'none'],
        ['Binance (holdings)', orphaned['binance_holding_count'],
         ', '.join(orphaned['binance_symbols']) or 'none'],
    ]
    print(tabulate(source_data,
                   headers=['Source', 'Count', 'Symbols'],
                   tablefmt='simple'))

    issues = []
    if orphaned['db_no_binance']:
        issues.append(f"  DB open but NO Binance holding: "
                      f"{', '.join(orphaned['db_no_binance'])}")
    if orphaned['binance_no_db']:
        issues.append(f"  Binance holding but NO DB record:  "
                      f"{', '.join(orphaned['binance_no_db'])}")
    if orphaned['redis_no_db']:
        issues.append(f"  Redis position but NO DB record:   "
                      f"{', '.join(orphaned['redis_no_db'])}")
    if orphaned['db_no_redis']:
        issues.append(f"  DB open but NOT in Redis:          "
                      f"{', '.join(orphaned['db_no_redis'])}")

    if issues:
        print(f"\n  ORPHAN ALERTS:")
        for issue in issues:
            print(issue)
    else:
        print(f"\n  No orphaned positions detected.")

    print("")


def build_json_output(pg_summary: dict, binance: dict, comparison: dict,
                      orphaned: dict, days: int) -> dict:
    """Build JSON-serializable output dict."""
    def sanitize(obj):
        """Make values JSON-serializable."""
        if isinstance(obj, dict):
            return {k: sanitize(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [sanitize(v) for v in obj]
        if hasattr(obj, 'isoformat'):
            return obj.isoformat()
        if isinstance(obj, (int, float, str, bool, type(None))):
            return obj
        return str(obj)

    return sanitize({
        'generated_at': datetime.now(timezone.utc).isoformat(),
        'lookback_days': days,
        'postgres': {
            'total_trades': int(pg_summary.get('total', 0)),
            'wins': int(pg_summary.get('wins', 0)),
            'losses': int(pg_summary.get('losses', 0)),
            'total_pnl': float(pg_summary.get('total_pnl', 0)),
            'estimated_fees': float(pg_summary.get('estimated_fees', 0)),
            'total_volume': float(pg_summary.get('total_volume', 0)),
        },
        'binance': {
            'usdc_balance': binance.get('usdc_balance', 0),
            'crypto_value': binance.get('crypto_value', 0),
            'total_value': binance.get('total_value', 0),
            'holdings': binance.get('holdings', []),
            'error': binance.get('error'),
        },
        'comparison': comparison,
        'orphaned_positions': orphaned,
    })


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(
        description='Strategy Lab: P&L Verification')
    parser.add_argument('--days', type=int, default=7,
                        help='Lookback window in days (default: 7)')
    parser.add_argument('--json', action='store_true',
                        help='Output JSON instead of formatted table')
    parser.add_argument('--verbose', action='store_true',
                        help='Show detailed trade and holding breakdown')
    args = parser.parse_args()

    pg = get_pg()
    redis_client = get_redis()

    try:
        # 1. Postgres P&L
        pg_summary = fetch_pnl_summary(pg, args.days, verbose=args.verbose)

        # 2. Binance balances
        binance = fetch_binance_balances(verbose=args.verbose)

        # 3. Comparison
        comparison = compare_pnl(pg_summary, binance)

        # 4. Orphaned positions
        db_positions = fetch_db_open_positions(pg)
        redis_positions = fetch_redis_positions(redis_client)
        binance_holdings = binance.get('holdings', []) if not binance.get('error') else []
        orphaned = check_orphaned(db_positions, redis_positions, binance_holdings)

        # 5. Output
        if args.json:
            output = build_json_output(
                pg_summary, binance, comparison, orphaned, args.days)
            print(json.dumps(output, indent=2))
        else:
            print_report(pg_summary, binance, comparison, orphaned,
                         args.days, args.verbose)

    finally:
        pg.close()
        redis_client.close()


if __name__ == '__main__':
    main()
