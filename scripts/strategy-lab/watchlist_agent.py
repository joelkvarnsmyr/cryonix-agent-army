#!/usr/bin/env python3
"""
Watchlist Agent — Autonomous Symbol Rotation

Evaluates current symbol performance, discovers candidates via CCXT + CMC,
calls Grok for selection, writes new symbol_whitelist to cryonix.toml,
commits, restarts engine, logs to Postgres + Telegram.

Usage:
  python3 scripts/strategy-lab/watchlist_agent.py [--dry-run]

Cron: 0 5 * * 2,5  (Tuesday + Friday 05:00 UTC)
"""
import argparse
import json
import os
import subprocess
import sys
import time
import tomlkit
import httpx
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(__file__))
from db import get_pg, get_redis

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
TOML_PATH = os.path.join(PROJECT_ROOT, 'cryonix.toml')
GROK_API_URL = 'https://api.x.ai/v1/chat/completions'
GROK_MODEL = 'grok-3-mini'

TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_EVOLUTION_BOT_TOKEN', '')
TELEGRAM_CHAT_ID   = os.environ.get('TELEGRAM_CHAT_ID', '')
XAI_API_KEY        = os.environ.get('XAI_API_KEY', '')

DOCKER_COMPOSE_FILE = os.path.join(PROJECT_ROOT, 'docker-compose.prod.yml')

# Fallback candidate pool used when CCXT market fetch fails.
# Mirrors CMCScout's TRACKED_SYMBOLS — update both if adding new coins.
TRACKED_SYMBOLS_USDC = [
    'BTC/USDC', 'ETH/USDC', 'SOL/USDC', 'XRP/USDC', 'BNB/USDC',
    'ADA/USDC', 'AVAX/USDC', 'DOGE/USDC', 'DOT/USDC', 'LINK/USDC',
    'MATIC/USDC', 'UNI/USDC', 'ATOM/USDC', 'INJ/USDC', 'ARB/USDC',
    'NEAR/USDC', 'SUI/USDC', 'RENDER/USDC', 'OP/USDC', 'APT/USDC',
    'PEPE/USDC', 'WIF/USDC', 'BONK/USDC', 'JUP/USDC', 'TIA/USDC',
]


# ── Config helpers ────────────────────────────────────────────────────────────

def load_toml():
    with open(TOML_PATH, 'r') as f:
        raw = f.read()
    return tomlkit.parse(raw), raw


def get_watchlist_config(cfg: dict) -> dict:
    wl = cfg.get('watchlist', {})
    return {
        'max_symbols':                  wl.get('max_symbols', 15),
        'max_symbols_hard_cap':         wl.get('max_symbols_hard_cap', 50),
        'min_trades_before_removal':    wl.get('min_trades_before_removal', 5),
        'min_days_on_watchlist':        wl.get('min_days_on_watchlist', 14),
        'candidate_pool_cmc_rank_limit':wl.get('candidate_pool_cmc_rank_limit', 150),
        'candidate_min_volume_usd':     wl.get('candidate_min_volume_usd', 5_000_000),
        'fear_greed_skip_below':        wl.get('fear_greed_skip_below', 15),
        'fear_greed_skip_above':        wl.get('fear_greed_skip_above', 85),
    }


# ── Pure functions ────────────────────────────────────────────────────────────

def score_candidate(cmc: dict, rank_limit: int = 150) -> float:
    """Score a candidate symbol 0-100 based on CMC data."""
    rank    = cmc.get('rank', rank_limit)
    vol     = cmc.get('volume_24h', 0)
    fdv_mc  = cmc.get('fdv_mc_ratio', 10.0)
    trend   = cmc.get('percent_change_7d', 0.0)

    rank_score    = max(0.0, (1 - rank / rank_limit)) * 40
    volume_score  = min(vol / 50_000_000, 1.0) * 30
    dilution_score = 20 if fdv_mc < 2.0 else (10 if fdv_mc < 4.0 else 0)
    trend_score   = max(0.0, min(trend / 20.0, 1.0)) * 10
    return round(rank_score + volume_score + dilution_score + trend_score, 1)


def apply_guardrails(
    add: list,
    remove: list,
    current: list,
    symbol_stats: dict,
    max_changes: int,
    hard_cap: int,
    min_symbols: int,
    valid_symbols: set,
) -> dict:
    """Apply code-level guardrails to Grok's proposed changes."""
    skipped_removals = []

    # Drop removals that aren't eligible or not in current list
    clean_remove = []
    for sym in remove:
        if sym not in current:
            continue
        stats = symbol_stats.get(sym, {})
        if not stats.get('removal_eligible', False):
            skipped_removals.append(sym)
            continue
        clean_remove.append(sym)

    # Drop adds that aren't valid Binance symbols
    clean_add = [s for s in add if s in valid_symbols and s not in current]

    # Enforce max_changes (removes first since they're higher priority)
    total = clean_remove + clean_add
    if len(total) > max_changes:
        allowed = total[:max_changes]
        clean_remove = [s for s in clean_remove if s in allowed]
        clean_add    = [s for s in clean_add    if s in allowed]

    # Enforce hard_cap
    new_count = len(current) - len(clean_remove) + len(clean_add)
    while new_count > hard_cap and clean_add:
        clean_add.pop()
        new_count -= 1

    # Enforce min_symbols
    while (len(current) - len(clean_remove) + len(clean_add)) < min_symbols and clean_remove:
        restored = clean_remove.pop()
        skipped_removals.append(restored)

    return {
        'add':              clean_add,
        'remove':           clean_remove,
        'skipped_removals': skipped_removals,
    }


def format_telegram_message(
    status: str,
    added: list,
    removed: list,
    skipped: list,
    symbols_after: list,
    fear_greed: int,
    regime: str,
    reasoning: str,
    symbol_stats: dict = None,
    error_step: str = '',
) -> str:
    if status == 'skipped':
        label = 'Extreme Fear' if fear_greed < 15 else 'Extreme Greed'
        return (
            f'⏭️ <b>Watchlist-körning skippad</b>\n'
            f'Orsak: Fear/Greed {fear_greed} ({label}) — utanför säkert fönster [15, 85]'
        )
    if status == 'failed':
        step_line = f'Steg: {error_step}\n' if error_step else ''
        return (
            f'❌ <b>Watchlist-agent misslyckades</b>\n'
            f'{step_line}'
            f'Fel: {reasoning}\n'
            f'Watchlist oförändrad.'
        )
    if status == 'no_changes':
        return (
            f'✅ <b>Watchlist granskad — inga ändringar</b>\n'
            f'Alla {len(symbols_after)} symboler presterar acceptabelt. '
            f'Nästa körning om 3-4 dagar.'
        )

    lines = ['🔄 <b>Watchlist uppdaterad</b>\n']
    if added:
        lines.append(f'➕ Tillagda ({len(added)}): {", ".join(added)}')
    if removed:
        removed_parts = []
        for sym in removed:
            if symbol_stats and sym in symbol_stats:
                s = symbol_stats[sym]
                removed_parts.append(
                    f'{sym} ({s.get("trades",0)} trades, '
                    f'${s.get("total_pnl_usd",0):+.2f}, '
                    f'{s.get("win_rate",0)*100:.0f}% WR)'
                )
            else:
                removed_parts.append(sym)
        lines.append(f'➖ Borttagna ({len(removed)}): {", ".join(removed_parts)}')
    if skipped:
        lines.append(f'⏭️ Ville ta bort (ej eligible): {", ".join(skipped)}')
    lines.append(f'📊 Ny lista: {len(symbols_after)} symboler')
    lines.append(f'\nFear/Greed: {fear_greed} | Regime: {regime}')
    if reasoning:
        lines.append(f'Motivering: {reasoning[:400]}')
    return '\n'.join(lines)


# ── Data collection functions ─────────────────────────────────────────────────

def collect_symbol_stats(pg, current_symbols: list, wl_cfg: dict) -> dict:
    """Query position_history for per-symbol performance (last 30 days)."""
    cur = pg.cursor()
    cur.execute("""
        SELECT
            symbol,
            COUNT(*) AS trades,
            ROUND(100.0 * COUNT(*) FILTER (WHERE pnl::numeric > 0) / COUNT(*), 1) AS win_rate,
            ROUND(SUM(pnl::numeric), 4) AS total_pnl_usd,
            ROUND(AVG(pnl_percent::numeric), 2) AS avg_pnl_pct,
            MIN(opened_at) AS first_trade_at
        FROM position_history
        WHERE opened_at > NOW() - INTERVAL '30 days'
          AND close_reason NOT IN ('SOLD_DUST', 'SOLD_STAGNATION')
        GROUP BY symbol
    """)
    cols = [d[0] for d in cur.description]
    rows = [dict(zip(cols, row)) for row in cur.fetchall()]

    min_trades  = wl_cfg['min_trades_before_removal']
    min_days    = wl_cfg['min_days_on_watchlist']
    stats = {}

    for row in rows:
        sym = row['symbol']
        trades = int(row['trades'])
        first_trade = row['first_trade_at']
        days_on = (datetime.now(timezone.utc) - first_trade.replace(tzinfo=timezone.utc)).days if first_trade else 0
        stats[sym] = {
            'symbol':           sym,
            'trades':           trades,
            'win_rate':         round(float(row['win_rate'] or 0) / 100, 3),
            'total_pnl_usd':    float(row['total_pnl_usd'] or 0),
            'avg_pnl_pct':      float(row['avg_pnl_pct'] or 0),
            'days_on_watchlist': days_on,
            'removal_eligible': trades >= min_trades and days_on >= min_days,
        }

    # Symbols on watchlist with no trades get a stub (protected from removal)
    for sym in current_symbols:
        if sym not in stats:
            stats[sym] = {
                'symbol': sym, 'trades': 0, 'win_rate': 0.0,
                'total_pnl_usd': 0.0, 'avg_pnl_pct': 0.0,
                'days_on_watchlist': 0, 'removal_eligible': False,
            }
    return stats


def discover_candidates(r, current_symbols: list, wl_cfg: dict) -> list:
    """Discover candidate symbols from CMC Redis data."""
    rank_limit  = wl_cfg['candidate_pool_cmc_rank_limit']
    min_volume  = wl_cfg['candidate_min_volume_usd']
    candidates  = []
    current_set = set(current_symbols)

    try:
        keys = r.keys('cmc:mcap:*')
    except Exception as e:
        print(f'[WATCHLIST] Redis CMC scan failed: {e}')
        return []

    for key in keys:
        try:
            raw = r.get(key)
            if not raw:
                continue
            data = json.loads(raw)
            rank    = int(data.get('rank', 9999))
            vol     = float(data.get('volume_24h', 0))
            fdv_mc  = float(data.get('fdv_mc_ratio', 99))

            if rank > rank_limit or vol < min_volume or fdv_mc > 10:
                continue

            base = key.split(':')[-1]
            symbol = f'{base}/USDC'

            if symbol in current_set:
                continue

            cmc_entry = {
                'symbol':            symbol,
                'rank':              rank,
                'volume_24h':        vol,
                'fdv_mc_ratio':      fdv_mc,
                'percent_change_7d': float(data.get('percent_change_7d', 0)),
                'market_cap':        float(data.get('market_cap', 0)),
            }
            cmc_entry['score'] = score_candidate(cmc_entry, rank_limit)
            candidates.append(cmc_entry)
        except Exception as e:
            print(f'[WATCHLIST] Failed to parse {key}: {e}')
            continue

    candidates.sort(key=lambda x: x['score'], reverse=True)
    return candidates[:20]


def get_market_regime(r) -> str:
    try:
        return r.get('market:regime') or 'unknown'
    except Exception:
        return 'unknown'


def get_fear_greed(r) -> int:
    try:
        raw = r.get('cmc:fear_greed')
        if raw:
            return int(json.loads(raw).get('value', 50))
    except Exception:
        pass
    return 50


def get_valid_binance_symbols() -> set:
    """Fetch all active USDC pairs from Binance via CCXT. Falls back to empty set."""
    try:
        import ccxt
        exchange = ccxt.binance({'options': {'defaultType': 'spot'}})
        markets = exchange.load_markets()
        return {s for s, m in markets.items() if '/USDC' in s and m.get('active')}
    except Exception as e:
        print(f'[WATCHLIST] CCXT market fetch failed: {e}')
        return set()


if __name__ == '__main__':
    pass
