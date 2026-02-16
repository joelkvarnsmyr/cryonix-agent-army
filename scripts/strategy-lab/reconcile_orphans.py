#!/usr/bin/env python3
"""
Strategy Lab: Orphan Position Reconciliation

Connects to Postgres, Redis, and Binance to find positions that exist
in the system's internal state (DB/Redis) but not on the exchange.
Guides the user through interactively cleaning up this corrupted state.

Usage:
  python3 scripts/strategy-lab/reconcile_orphans.py
"""

import os
import sys
import json
from typing import List, Dict, Any

# Ensure correct path for imports
sys.path.insert(0, os.path.dirname(__file__))
try:
    from db import get_pg, get_redis
except ImportError:
    print("❌ Could not import db.py. Make sure you are running from the project root.")
    sys.exit(1)

try:
    import ccxt
    from tabulate import tabulate
except ImportError:
    print("❌ Missing dependencies. Please run: pip install ccxt tabulate")
    sys.exit(1)

# --- State Fetching Functions ---

def fetch_redis_positions(redis_client) -> List[Dict[str, Any]]:
    """Fetch open positions stored in the 'positions:open' Redis key."""
    print("🔍 Fetching open positions from Redis ('positions:open')...")
    try:
        raw = redis_client.get('positions:open')
        if not raw:
            print("  - No positions found in Redis.")
            return []
        data = json.loads(raw)
        print(f"  - Found {len(data)} positions in Redis.")
        return data if isinstance(data, list) else []
    except Exception as e:
        print(f"  - ❌ Error fetching from Redis: {e}")
        return []

def fetch_postgres_positions(pg_conn) -> List[Dict[str, Any]]:
    """Fetch positions marked as 'FILLED' from the Postgres 'trades' table."""
    print("🔍 Fetching 'FILLED' positions from Postgres...")
    try:
        with pg_conn.cursor(cursor_factory=pg.cursors.DictCursor) as cur:
            cur.execute("""
                SELECT id, symbol, side, quantity, entry_price, timestamp, pattern
                FROM trades
                WHERE status = 'FILLED'
                ORDER BY timestamp
            """)
            rows = cur.fetchall()
            print(f"  - Found {len(rows)} 'FILLED' trades in Postgres.")
            return [dict(row) for row in rows]
    except Exception as e:
        print(f"  - ❌ Error fetching from Postgres: {e}")
        return []

def fetch_binance_holdings() -> Dict[str, float]:
    """Fetch all non-dust balances from Binance."""
    print("🔍 Fetching live holdings from Binance...")
    api_key = os.environ.get('BINANCE_API_KEY')
    api_secret = os.environ.get('BINANCE_API_SECRET')
    if not api_key or not api_secret:
        print("  - ❌ BINANCE_API_KEY / BINANCE_API_SECRET not set in .env file.")
        print("  - Cannot connect to Binance. Please set them to run a full reconciliation.")
        return {}

    try:
        exchange = ccxt.binance({'apiKey': api_key, 'secret': api_secret})
        balance = exchange.fetch_balance()
        
        holdings = {}
        for currency, amounts in balance.get('total', {}).items():
            amt = float(amounts or 0)
            if amt <= 0.00001:  # Ignore dust
                continue
            # Store base asset, not the pair (e.g., 'BTC' from 'BTC/USDC')
            if currency not in ['USDC', 'USDT', 'USD']:
                 holdings[currency] = amt
        
        print(f"  - Found {len(holdings)} non-dust assets on Binance.")
        return holdings
    except Exception as e:
        print(f"  - ❌ Error fetching from Binance: {e}")
        return {}

# --- Reconciliation Logic ---

def reconcile_states(redis_pos, pg_pos, binance_holdings):
    """Compare states and identify orphans."""
    print("
[ANALYSIS] Comparing system state with Binance holdings...")
    
    # Consolidate internal state from Redis and Postgres
    internal_symbols = {p['symbol'].split('/')[0] for p in redis_pos}
    internal_symbols.update(p['symbol'].split('/')[0] for p in pg_pos)

    binance_symbols = set(binance_holdings.keys())

    orphans = internal_symbols - binance_symbols
    
    print(f"  - Internal system believes it holds: {', '.join(sorted(internal_symbols)) or 'None'}")
    print(f"  - Binance actually holds: {', '.join(sorted(binance_symbols)) or 'None'}")

    if not orphans:
        print("✅ No orphaned positions found. System state appears consistent with Binance.")
        return []

    print(f"⚠️ Found {len(orphans)} orphaned position(s): {', '.join(sorted(orphans))}")
    print("   These assets exist in the local database/Redis but not on the exchange.")
    
    # Return detailed info for the orphans
    orphan_details = []
    for symbol_base in orphans:
        # Find the full symbol pair (e.g., 'BTC/USDC')
        full_symbol = next((p['symbol'] for p in redis_pos if p['symbol'].startswith(symbol_base)), None)
        if not full_symbol:
            full_symbol = next((p['symbol'] for p in pg_pos if p['symbol'].startswith(symbol_base)), None)

        if full_symbol:
             orphan_details.append({'symbol': full_symbol})
             
    return orphan_details


async def perform_cleanup(orphans: List[Dict[str, Any]], redis_client, pg_conn):
    """Interactively guide user through cleaning up orphans."""
    if not orphans:
        return

    print("
--- INTERACTIVE CLEANUP ---")
    print("For each orphan, you will be asked to confirm its removal from the system's internal state.")
    print("This will NOT execute any trades on Binance.
")

    for orphan in orphans:
        symbol = orphan['symbol']
        print(f"Orphan: {symbol}")
        
        # Get user confirmation
        confirm = input(f"  -> Do you want to mark '{symbol}' as CLOSED in the database and remove it from Redis state? (y/n): ").lower()

        if confirm == 'y':
            print(f"  - Proceeding with cleanup for {symbol}...")
            
            # 1. Clean Redis
            try:
                raw_positions = await redis_client.get('positions:open')
                if raw_positions:
                    positions = json.loads(raw_positions)
                    original_count = len(positions)
                    positions_cleaned = [p for p in positions if p.get('symbol') != symbol]
                    
                    if len(positions_cleaned) < original_count:
                        await redis_client.set('positions:open', json.dumps(positions_cleaned))
                        print(f"  - ✅ Removed '{symbol}' from Redis 'positions:open'.")
                    else:
                        print(f"  - ⚪️ '{symbol}' not found in Redis 'positions:open'.")
            except Exception as e:
                print(f"  - ❌ Error cleaning Redis for '{symbol}': {e}")

            # 2. Clean Postgres
            try:
                with pg_conn.cursor() as cur:
                    # Find the trade to update
                    cur.execute("SELECT id FROM trades WHERE symbol = %s AND status = 'FILLED'", (symbol,))
                    trade_to_update = cur.fetchone()

                    if trade_to_update:
                        trade_id = trade_to_update[0]
                        # Mark as closed with a reason, don't delete
                        cur.execute("""
                            UPDATE trades
                            SET status = 'CLOSED',
                                reasoning = 'Orphan Reconciliation: position closed via script as it did not exist on exchange.',
                                pnl = 0,
                                exit_price = entry_price
                            WHERE id = %s
                        """, (trade_id,))
                        pg_conn.commit()
                        print(f"  - ✅ Marked trade for '{symbol}' (ID: {trade_id}) as 'CLOSED' in Postgres.")
                    else:
                        print(f"  - ⚪️ No 'FILLED' trade for '{symbol}' found in Postgres.")
            except Exception as e:
                pg_conn.rollback()
                print(f"  - ❌ Error cleaning Postgres for '{symbol}': {e}")
            
            print("-" * 20)
        else:
            print(f"  - Skipping cleanup for {symbol}.")


def main():
    """Main execution function."""
    print("="*50)
    print(" Cryonix Orphan Position Reconciliation Tool")
    print("="*50)
    print("This script will help you find and fix inconsistencies between the")
    print("system's internal state and your live Binance account.
")
    
    pg_conn = None
    redis_client = None
    
    try:
        # --- 1. Connect to services ---
        pg_conn = get_pg()
        redis_client = get_redis()
        print("
✅ Connected to Postgres and Redis.")

        # --- 2. Fetch state from all sources ---
        redis_positions = fetch_redis_positions(redis_client)
        pg_positions = fetch_postgres_positions(pg_conn)
        binance_holdings = fetch_binance_holdings()

        # --- 3. Identify orphans ---
        orphans_to_clean = reconcile_states(redis_positions, pg_positions, binance_holdings)

        # --- 4. Perform cleanup ---
        if orphans_to_clean:
            # Re-wrap in an async function to use await for redis
            import asyncio
            asyncio.run(perform_cleanup(orphans_to_clean, redis_client, pg_conn))
        
        print("
✅ Reconciliation process complete.")

    except Exception as e:
        print(f"
💥 An unexpected error occurred: {e}")
    finally:
        if pg_conn:
            pg_conn.close()
        if redis_client:
            redis_client.close()
        print("Disconnected from services.")

if __name__ == '__main__':
    main()
