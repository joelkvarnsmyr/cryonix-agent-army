# Watchlist Agent Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an autonomous Python script that owns the symbol watchlist — evaluates current symbol performance, discovers new candidates, calls Grok for selection, and applies changes by writing `cryonix.toml` + restarting the engine.

**Architecture:** Standalone Python script in `scripts/strategy-lab/`, identical pattern to `ai_brain.py`. Uses `psycopg2` for Postgres, `redis` for CMC data, `ccxt` for market discovery, `tomlkit` for TOML writes, `httpx` for Grok + Telegram. Runs twice weekly via cron.

**Tech Stack:** Python 3.11, psycopg2, redis-py, ccxt, tomlkit, httpx, subprocess (git + docker)

**Spec:** `docs/superpowers/specs/2026-03-10-watchlist-agent-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/database/src/schema.ts` | Modify | Add `watchlistChanges` Drizzle table |
| `cryonix.toml` | Modify | Add `[watchlist]` config section |
| `scripts/strategy-lab/watchlist_agent.py` | Create | Main agent — all logic |
| `scripts/strategy-lab/tests/test_watchlist_agent.py` | Create | Unit tests for pure functions |

---

## Chunk 1: DB Schema + TOML Config

### Task 1: Add watchlist_changes table to schema + TOML config

**Files:**
- Modify: `packages/database/src/schema.ts`
- Modify: `cryonix.toml`

- [ ] **Step 1: Read existing schema to find insertion point**

```bash
grep -n "evolution_runs\|config_changes\|pgTable" packages/database/src/schema.ts | tail -20
```

Note the last table definition — add `watchlistChanges` after it.

- [ ] **Step 2: Add watchlistChanges table to schema.ts**

```typescript
// After the last existing table definition:
export const watchlistChanges = pgTable('watchlist_changes', {
  id:              serial('id').primaryKey(),
  runId:           varchar('run_id', { length: 20 }).notNull(),
  runAt:           timestamp('run_at').defaultNow(),
  symbolsBefore:   text('symbols_before').array().notNull(),
  symbolsAfter:    text('symbols_after').array().notNull(),
  added:           text('added').array(),
  removed:         text('removed').array(),
  skippedRemovals: text('skipped_removals').array(),
  fearGreed:       integer('fear_greed'),
  regime:          varchar('regime', { length: 20 }),
  grokReasoning:   text('grok_reasoning'),
  status:          varchar('status', { length: 20 }).default('applied'),
  error:           text('error'),
});
```

- [ ] **Step 3: Type-check schema**

```bash
cd packages/database && pnpm type-check 2>&1 | head -20
```

Expected: No TypeScript errors.

- [ ] **Step 4: Add [watchlist] section to cryonix.toml**

Find the end of the `[trading]` section in `cryonix.toml`. Add this new section after it (before `[patterns]` or similar):

```toml
[watchlist]
# Autonomous watchlist rotation — see scripts/strategy-lab/watchlist_agent.py
# Cron: 0 5 * * 2,5 (Tue + Fri 05:00 UTC)
max_symbols = 15
max_symbols_hard_cap = 50
min_trades_before_removal = 5
min_days_on_watchlist = 14
candidate_pool_cmc_rank_limit = 150
candidate_min_volume_usd = 5000000
fear_greed_skip_below = 15
fear_greed_skip_above = 85
```

- [ ] **Step 5: Verify TOML is valid**

```bash
python3 -c "import tomllib; tomllib.load(open('cryonix.toml','rb')); print('TOML OK')"
```

Expected: `TOML OK`

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/schema.ts cryonix.toml
git commit -m "feat(watchlist): add watchlist_changes schema and [watchlist] TOML config"
```

---

## Chunk 2: Data Collection

### Task 2: Symbol performance query + candidate discovery + scoring

**Files:**
- Create: `scripts/strategy-lab/watchlist_agent.py`
- Create: `scripts/strategy-lab/tests/test_watchlist_agent.py`

Context: `scripts/strategy-lab/db.py` provides `get_pg()` and `get_redis()`. `cryonix.toml` provides config. Pattern: see `ai_brain.py` for how to load TOML, connect to DB/Redis, send Telegram.

- [ ] **Step 1: Write failing tests for pure functions**

Create `scripts/strategy-lab/tests/__init__.py` (empty).

Create `scripts/strategy-lab/tests/test_watchlist_agent.py`:

```python
"""Tests for watchlist_agent pure functions."""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from unittest.mock import MagicMock, patch
import watchlist_agent as wa


# ── score_candidate ──────────────────────────────────────────────────────────

def test_score_candidate_high_rank_high_volume():
    cmc = {'rank': 10, 'volume_24h': 100_000_000, 'fdv_mc_ratio': 1.5, 'percent_change_7d': 10.0}
    score = wa.score_candidate(cmc, rank_limit=150)
    assert score > 70, f"Expected >70, got {score}"

def test_score_candidate_low_rank_penalized():
    cmc = {'rank': 149, 'volume_24h': 6_000_000, 'fdv_mc_ratio': 3.5, 'percent_change_7d': 0.0}
    score = wa.score_candidate(cmc, rank_limit=150)
    assert score < 30, f"Expected <30, got {score}"

def test_score_candidate_high_fdv_mc_zero_dilution_points():
    cmc = {'rank': 50, 'volume_24h': 20_000_000, 'fdv_mc_ratio': 5.0, 'percent_change_7d': 5.0}
    score_high_fdv = wa.score_candidate(cmc, rank_limit=150)
    cmc2 = {**cmc, 'fdv_mc_ratio': 1.0}
    score_low_fdv = wa.score_candidate(cmc2, rank_limit=150)
    assert score_low_fdv > score_high_fdv


# ── apply_guardrails ─────────────────────────────────────────────────────────

def make_stats(symbol, trades=10, win_rate=0.35, pnl=-3.0, days=20):
    return {
        'symbol': symbol,
        'trades': trades,
        'win_rate': win_rate,
        'total_pnl_usd': pnl,
        'removal_eligible': trades >= 5 and days >= 14,
    }

def test_guardrails_removes_ineligible_removals():
    stats = {'ADA/USDC': make_stats('ADA/USDC', days=5)}  # only 5 days, not eligible
    result = wa.apply_guardrails(
        add=[], remove=['ADA/USDC'],
        current=['BTC/USDC', 'ETH/USDC', 'ADA/USDC'],
        symbol_stats=stats,
        max_changes=5, hard_cap=50, min_symbols=10,
        valid_symbols={'BTC/USDC', 'ETH/USDC', 'ADA/USDC'},
    )
    assert 'ADA/USDC' not in result['remove']
    assert 'ADA/USDC' in result['skipped_removals']

def test_guardrails_respects_max_changes():
    stats = {f'SYM{i}/USDC': make_stats(f'SYM{i}/USDC') for i in range(10)}
    current = [f'SYM{i}/USDC' for i in range(10)]
    valid = set(current) | {'NEW1/USDC', 'NEW2/USDC', 'NEW3/USDC', 'NEW4/USDC'}
    result = wa.apply_guardrails(
        add=['NEW1/USDC', 'NEW2/USDC', 'NEW3/USDC', 'NEW4/USDC'],
        remove=['SYM0/USDC', 'SYM1/USDC', 'SYM2/USDC', 'SYM3/USDC'],
        current=current, symbol_stats=stats,
        max_changes=3, hard_cap=50, min_symbols=5,
        valid_symbols=valid,
    )
    assert len(result['add']) + len(result['remove']) <= 3

def test_guardrails_enforces_hard_cap():
    current = [f'SYM{i}/USDC' for i in range(48)]
    stats = {}
    valid = set(current) | {'NEW1/USDC', 'NEW2/USDC', 'NEW3/USDC', 'NEW4/USDC', 'NEW5/USDC'}
    result = wa.apply_guardrails(
        add=['NEW1/USDC', 'NEW2/USDC', 'NEW3/USDC', 'NEW4/USDC', 'NEW5/USDC'],
        remove=[], current=current, symbol_stats=stats,
        max_changes=5, hard_cap=50, min_symbols=10,
        valid_symbols=valid,
    )
    assert len(current) + len(result['add']) <= 50

def test_guardrails_rejects_unknown_symbols():
    current = ['BTC/USDC', 'ETH/USDC']
    result = wa.apply_guardrails(
        add=['FAKE/USDC'],  # not in valid_symbols
        remove=[], current=current, symbol_stats={},
        max_changes=5, hard_cap=50, min_symbols=1,
        valid_symbols={'BTC/USDC', 'ETH/USDC'},
    )
    assert 'FAKE/USDC' not in result['add']


# ── format_telegram_message ───────────────────────────────────────────────────

def test_format_telegram_applied():
    msg = wa.format_telegram_message(
        status='applied',
        added=['PEPE/USDC'],
        removed=['ADA/USDC'],
        skipped=[],
        symbols_after=['BTC/USDC', 'PEPE/USDC'],
        fear_greed=52,
        regime='trending',
        reasoning='ADA underperformed.',
    )
    assert 'PEPE/USDC' in msg
    assert 'ADA/USDC' in msg

def test_format_telegram_skipped():
    msg = wa.format_telegram_message(
        status='skipped',
        added=[], removed=[], skipped=[],
        symbols_after=[],
        fear_greed=10, regime='bearish', reasoning='',
    )
    assert 'skippad' in msg.lower() or 'skip' in msg.lower()

def test_format_telegram_failed_includes_step_and_error():
    msg = wa.format_telegram_message(
        status='failed',
        added=[], removed=[], skipped=[],
        symbols_after=[],
        fear_greed=50, regime='neutral', reasoning='Connection timeout',
        error_step='Grok-anrop (3 försök)',
    )
    assert 'Grok-anrop' in msg
    assert 'Connection timeout' in msg
    assert 'oförändrad' in msg.lower()

def test_format_telegram_no_changes_includes_next_run():
    msg = wa.format_telegram_message(
        status='no_changes',
        added=[], removed=[], skipped=[],
        symbols_after=['BTC/USDC', 'ETH/USDC'],
        fear_greed=50, regime='neutral', reasoning='',
    )
    assert '3-4 dagar' in msg
    assert '2 symboler' in msg

def test_format_telegram_applied_includes_symbol_stats():
    stats = {'ADA/USDC': make_stats('ADA/USDC', trades=7, win_rate=0.28, pnl=-2.50)}
    msg = wa.format_telegram_message(
        status='applied',
        added=['PEPE/USDC'], removed=['ADA/USDC'], skipped=[],
        symbols_after=['BTC/USDC', 'PEPE/USDC'],
        fear_greed=52, regime='trending', reasoning='ADA weak.',
        symbol_stats=stats,
    )
    assert '-$2.50' in msg or '-2.50' in msg
    assert '28%' in msg or '28.0%' in msg
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd scripts/strategy-lab && python3 -m pytest tests/test_watchlist_agent.py -v 2>&1 | head -30
```

Expected: `ModuleNotFoundError: No module named 'watchlist_agent'`

- [ ] **Step 3: Create watchlist_agent.py with the pure functions**

Create `scripts/strategy-lab/watchlist_agent.py`:

```python
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


# ── Config ────────────────────────────────────────────────────────────────────

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


# ── Pure functions (tested) ───────────────────────────────────────────────────

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
    """
    Apply code-level guardrails to Grok's proposed changes.
    Returns dict: {add, remove, skipped_removals}
    """
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
        # Keep removes first (more important: stop bleeding), then adds
        allowed = total[:max_changes]
        clean_remove = [s for s in clean_remove if s in allowed]
        clean_add    = [s for s in clean_add    if s in allowed]

    # Enforce hard_cap: trim adds if new total would exceed cap
    new_count = len(current) - len(clean_remove) + len(clean_add)
    while new_count > hard_cap and clean_add:
        clean_add.pop()
        new_count -= 1

    # Enforce min_symbols: restore removes if it would go too low
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
    symbol_stats: dict = None,   # needed for per-symbol stats in removed line
    error_step: str = '',        # e.g. "Grok-anrop (3 försök)"
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
```

- [ ] **Step 4: Run tests — expect them to pass for pure functions**

```bash
cd scripts/strategy-lab && python3 -m pytest tests/test_watchlist_agent.py -v 2>&1 | tail -20
```

Expected: All tests pass. If import errors from missing deps (`tomlkit`, `httpx`), install: `pip3 install tomlkit httpx ccxt psycopg2-binary redis python-dotenv`.

- [ ] **Step 5: Commit**

```bash
git add scripts/strategy-lab/watchlist_agent.py scripts/strategy-lab/tests/
git commit -m "feat(watchlist): add pure functions (score_candidate, apply_guardrails, format_telegram_message) with tests"
```

---

## Chunk 3: Data Collection Functions

### Task 3: Postgres + Redis + CCXT data collection

**Files:**
- Modify: `scripts/strategy-lab/watchlist_agent.py`

- [ ] **Step 1: Add collect_symbol_stats() to watchlist_agent.py**

Append to `watchlist_agent.py` after the pure functions:

```python
# ── Data collection ───────────────────────────────────────────────────────────

def collect_symbol_stats(pg, current_symbols: list, wl_cfg: dict) -> dict:
    """
    Query position_history for per-symbol performance (last 30 days).
    Returns dict keyed by symbol with stats + removal_eligible flag.
    """
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

    # Symbols on watchlist with no trades get a stub entry (protected from removal)
    for sym in current_symbols:
        if sym not in stats:
            stats[sym] = {
                'symbol': sym, 'trades': 0, 'win_rate': 0.0,
                'total_pnl_usd': 0.0, 'avg_pnl_pct': 0.0,
                'days_on_watchlist': 0, 'removal_eligible': False,
            }
    return stats


def discover_candidates(r, current_symbols: list, wl_cfg: dict) -> list:
    """
    Discover candidate symbols from CMC Redis data.
    Falls back to empty list if no CMC data available.
    Returns list of dicts sorted by score desc, excluding current watchlist.
    """
    rank_limit  = wl_cfg['candidate_pool_cmc_rank_limit']
    min_volume  = wl_cfg['candidate_min_volume_usd']
    candidates  = []
    current_set = set(current_symbols)

    # Scan all cmc:mcap:* keys in Redis
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

            if rank > rank_limit:
                continue
            if vol < min_volume:
                continue
            if fdv_mc > 10:
                continue

            # Build symbol name from Redis key: cmc:mcap:BTC -> BTC/USDC
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
    return candidates[:20]  # Top 20 for Grok


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
    """
    Fetch all active USDC pairs from Binance via CCXT.
    Falls back to empty set on failure (guardrails will skip unknown symbols).
    """
    try:
        import ccxt
        exchange = ccxt.binance({'options': {'defaultType': 'spot'}})
        markets = exchange.load_markets()
        return {s for s, m in markets.items() if '/USDC' in s and m.get('active')}
    except Exception as e:
        print(f'[WATCHLIST] CCXT market fetch failed: {e}')
        return set()
```

- [ ] **Step 2: Add integration test for collect_symbol_stats with mock PG**

Add to `scripts/strategy-lab/tests/test_watchlist_agent.py`:

```python
def test_collect_symbol_stats_marks_ineligible_new_symbol():
    """Symbols not in position_history should be marked removal_eligible=False."""
    mock_pg = MagicMock()
    mock_cur = MagicMock()
    mock_pg.cursor.return_value = mock_cur
    mock_cur.description = [('symbol',), ('trades',), ('win_rate',),
                             ('total_pnl_usd',), ('avg_pnl_pct',), ('first_trade_at',)]
    mock_cur.fetchall.return_value = []  # no trades at all

    wl_cfg = {
        'min_trades_before_removal': 5,
        'min_days_on_watchlist': 14,
        'candidate_pool_cmc_rank_limit': 150,
        'candidate_min_volume_usd': 5_000_000,
    }
    stats = wa.collect_symbol_stats(mock_pg, ['BTC/USDC', 'ETH/USDC'], wl_cfg)
    assert stats['BTC/USDC']['removal_eligible'] is False
    assert stats['ETH/USDC']['removal_eligible'] is False


def test_discover_candidates_filters_current_symbols():
    """Symbols already on the watchlist must not appear in candidates."""
    mock_r = MagicMock()
    mock_r.keys.return_value = ['cmc:mcap:BTC', 'cmc:mcap:PEPE']
    mock_r.get.side_effect = lambda key: json.dumps({
        'rank': 1 if 'BTC' in key else 30,
        'volume_24h': 50_000_000,
        'fdv_mc_ratio': 1.0,
        'percent_change_7d': 5.0,
        'market_cap': 1_000_000_000,
    })
    wl_cfg = {
        'candidate_pool_cmc_rank_limit': 150,
        'candidate_min_volume_usd': 5_000_000,
    }
    candidates = wa.discover_candidates(mock_r, ['BTC/USDC'], wl_cfg)
    symbols = [c['symbol'] for c in candidates]
    assert 'BTC/USDC' not in symbols
    assert 'PEPE/USDC' in symbols
```

- [ ] **Step 3: Run all tests**

```bash
cd scripts/strategy-lab && python3 -m pytest tests/test_watchlist_agent.py -v 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/strategy-lab/watchlist_agent.py scripts/strategy-lab/tests/test_watchlist_agent.py
git commit -m "feat(watchlist): add data collection functions (symbol_stats, discover_candidates)"
```

---

## Chunk 4: Grok Integration + Apply Logic

### Task 4: Grok call + TOML write + git + docker restart

**Files:**
- Modify: `scripts/strategy-lab/watchlist_agent.py`

- [ ] **Step 1: Add call_grok() function**

Append to `watchlist_agent.py`:

```python
# ── Grok ─────────────────────────────────────────────────────────────────────

def build_grok_prompt(
    current_symbols: list,
    symbol_stats: dict,
    candidates: list,
    wl_cfg: dict,
    fear_greed: int,
    regime: str,
) -> str:
    max_sym = wl_cfg['max_symbols']
    hard_cap = wl_cfg['max_symbols_hard_cap']

    stat_rows = []
    for sym in current_symbols:
        s = symbol_stats.get(sym, {})
        eligible = 'yes' if s.get('removal_eligible') else 'no'
        stat_rows.append(
            f"  {sym:<20} | trades={s.get('trades',0):>3} "
            f"| wr={s.get('win_rate',0)*100:>5.1f}% "
            f"| pnl=${s.get('total_pnl_usd',0):>+7.2f} "
            f"| eligible={eligible}"
        )

    cand_rows = []
    for c in candidates:
        cand_rows.append(
            f"  {c['symbol']:<20} | rank={c['rank']:>4} "
            f"| vol=${c['volume_24h']/1e6:>6.1f}M "
            f"| fdv_mc={c['fdv_mc_ratio']:.1f} "
            f"| 7d={c['percent_change_7d']:>+6.1f}% "
            f"| score={c['score']:.0f}"
        )

    return f"""WATCHLIST AGENT
Market: regime={regime}, fear_greed={fear_greed}

CURRENT SYMBOLS ({len(current_symbols)}):
{chr(10).join(stat_rows)}

CANDIDATES (not on watchlist, ranked by score):
{chr(10).join(cand_rows) if cand_rows else '  (no candidates found)'}

RULES:
- Target {max_sym} symbols, hard cap {hard_cap}
- Max 5 changes this run (adds + removes combined)
- Only remove symbols where eligible=yes AND (win_rate < 40% OR pnl < -2 USD)
- Prefer candidates: high volume, low FDV/MC ratio, top-100 CMC rank, score >= 30
- Do not add a symbol if its score < 30

Respond with JSON only (no markdown, no explanation outside JSON):
{{"add": ["X/USDC"], "remove": ["Y/USDC"], "reasoning": "one paragraph explaining decisions"}}"""


def call_grok(prompt: str) -> dict:
    """Call Grok with 3 retries. Returns parsed JSON or raises RuntimeError."""
    if not XAI_API_KEY:
        raise RuntimeError('XAI_API_KEY not set')

    for attempt in range(1, 4):
        try:
            resp = httpx.post(
                GROK_API_URL,
                headers={'Authorization': f'Bearer {XAI_API_KEY}', 'Content-Type': 'application/json'},
                json={
                    'model': GROK_MODEL,
                    'messages': [{'role': 'user', 'content': prompt}],
                    'temperature': 0.2,
                    'max_tokens': 1000,
                },
                timeout=60,
            )
            resp.raise_for_status()
            content = resp.json()['choices'][0]['message']['content'].strip()

            # Strip markdown code fences if present
            if content.startswith('```'):
                content = content.split('```')[1]
                if content.startswith('json'):
                    content = content[4:]

            parsed = json.loads(content)
            if not isinstance(parsed.get('add'), list) or not isinstance(parsed.get('remove'), list):
                raise ValueError('Missing add/remove arrays in Grok response')
            return parsed

        except Exception as e:
            print(f'[WATCHLIST] Grok attempt {attempt}/3 failed: {e}')
            if attempt < 3:
                time.sleep(30 * attempt)

    raise RuntimeError('Grok call failed after 3 attempts')
```

- [ ] **Step 2: Add apply_changes() function (TOML write + git + docker)**

```python
# ── Apply changes ─────────────────────────────────────────────────────────────

def write_toml_whitelist(new_symbols: list) -> None:
    """Write new symbol_whitelist to cryonix.toml using tomlkit (preserves formatting)."""
    cfg, _ = load_toml()
    arr = tomlkit.array()
    arr.multiline(True)
    for sym in sorted(new_symbols):
        arr.append(sym)
    cfg['trading']['symbol_whitelist'] = arr
    with open(TOML_PATH, 'w') as f:
        f.write(tomlkit.dumps(cfg))


def git_commit(added: list, removed: list) -> None:
    """Stage cryonix.toml and commit."""
    subprocess.run(['git', '-C', PROJECT_ROOT, 'add', 'cryonix.toml'], check=True)
    added_str   = ', '.join(added)   if added   else 'none'
    removed_str = ', '.join(removed) if removed else 'none'
    msg = (
        f'feat(watchlist): rotate symbols [+{len(added)}/-{len(removed)}]\n\n'
        f'Added: {added_str}\n'
        f'Removed: {removed_str}\n\n'
        f'Co-Authored-By: Claude <noreply@anthropic.com>'
    )
    subprocess.run(['git', '-C', PROJECT_ROOT, 'commit', '-m', msg], check=True)


def restart_engine() -> None:
    """Restart the engine Docker container."""
    subprocess.run(
        ['docker', 'compose', '-f', DOCKER_COMPOSE_FILE, 'restart', 'engine'],
        cwd=PROJECT_ROOT, check=True,
    )


def log_to_postgres(pg, run_id: str, data: dict) -> None:
    """Insert a watchlist_changes row."""
    cur = pg.cursor()
    cur.execute("""
        INSERT INTO watchlist_changes
          (run_id, symbols_before, symbols_after, added, removed,
           skipped_removals, fear_greed, regime, grok_reasoning, status, error)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
    """, (
        run_id,
        data['symbols_before'],
        data['symbols_after'],
        data.get('added', []),
        data.get('removed', []),
        data.get('skipped_removals', []),
        data.get('fear_greed'),
        data.get('regime'),
        data.get('grok_reasoning'),
        data['status'],
        data.get('error'),
    ))
    pg.commit()


def telegram_send(text: str) -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print(f'[TELEGRAM] Skipping: {text[:80]}')
        return
    try:
        httpx.post(
            f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage',
            json={'chat_id': TELEGRAM_CHAT_ID, 'text': text[:4096],
                  'parse_mode': 'HTML', 'disable_web_page_preview': True},
            timeout=10,
        )
    except Exception as e:
        print(f'[TELEGRAM] Failed: {e}')
```

- [ ] **Step 3: Add main() orchestrator**

```python
# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description='Watchlist Agent')
    parser.add_argument('--dry-run', action='store_true',
                        help='Compute changes but do not write TOML or restart engine')
    args = parser.parse_args()

    run_id = f'wl_{datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")}'
    print(f'[WATCHLIST] Starting run {run_id} (dry_run={args.dry_run})')

    # Load config
    cfg, _ = load_toml()

    # Baseline freeze check (same pattern as ai_brain.py)
    lock_file = os.path.join(PROJECT_ROOT, '.baseline-frozen')
    if os.path.exists(lock_file) or cfg.get('baseline', {}).get('frozen', False):
        baseline_id = cfg.get('baseline', {}).get('baseline_id', '?')
        print(f'[WATCHLIST] FROZEN — baseline {baseline_id} active. Skipping run.')
        return

    wl_cfg = get_watchlist_config(cfg)
    current_symbols = list(cfg.get('trading', {}).get('symbol_whitelist', []))

    pg = get_pg()
    r  = get_redis()

    try:
        # Check market conditions
        fear_greed = get_fear_greed(r)
        regime     = get_market_regime(r)
        print(f'[WATCHLIST] Fear/Greed={fear_greed}, Regime={regime}')

        if fear_greed < wl_cfg['fear_greed_skip_below'] or fear_greed > wl_cfg['fear_greed_skip_above']:
            print(f'[WATCHLIST] Market conditions extreme — skipping run')
            msg = format_telegram_message(
                status='skipped', added=[], removed=[], skipped=[],
                symbols_after=current_symbols, fear_greed=fear_greed,
                regime=regime, reasoning='',
            )
            telegram_send(msg)
            log_to_postgres(pg, run_id, {
                'status': 'skipped', 'symbols_before': current_symbols,
                'symbols_after': current_symbols, 'fear_greed': fear_greed,
                'regime': regime,
            })
            return

        # Collect data — degrade gracefully if Postgres query fails (add-only mode)
        print('[WATCHLIST] Collecting symbol stats...')
        symbol_stats = {}
        try:
            symbol_stats = collect_symbol_stats(pg, current_symbols, wl_cfg)
        except Exception as e:
            print(f'[WATCHLIST] WARNING: symbol stats query failed: {e} — proceeding in add-only mode (no removals)')
            # Mark all current symbols as ineligible for removal
            for sym in current_symbols:
                symbol_stats[sym] = {
                    'symbol': sym, 'trades': 0, 'win_rate': 0.0,
                    'total_pnl_usd': 0.0, 'avg_pnl_pct': 0.0,
                    'days_on_watchlist': 0, 'removal_eligible': False,
                }

        print('[WATCHLIST] Discovering candidates...')
        candidates = discover_candidates(r, current_symbols, wl_cfg)
        print(f'[WATCHLIST] Found {len(candidates)} candidates')

        print('[WATCHLIST] Fetching valid Binance symbols...')
        valid_symbols = get_valid_binance_symbols()
        if not valid_symbols:
            print('[WATCHLIST] CCXT fallback: using TRACKED_SYMBOLS_USDC as valid set')
            valid_symbols = set(TRACKED_SYMBOLS_USDC) | set(current_symbols)

        # Build Grok prompt and call
        prompt = build_grok_prompt(current_symbols, symbol_stats, candidates,
                                   wl_cfg, fear_greed, regime)
        print('[WATCHLIST] Calling Grok...')
        try:
            grok_result = call_grok(prompt)
        except RuntimeError as e:
            err_msg = str(e)
            print(f'[WATCHLIST] Grok failed: {err_msg}')
            telegram_send(format_telegram_message(
                status='failed', added=[], removed=[], skipped=[],
                symbols_after=current_symbols, fear_greed=fear_greed,
                regime=regime, reasoning=err_msg,
                error_step='Grok-anrop (3 försök)',
            ))
            log_to_postgres(pg, run_id, {
                'status': 'failed', 'symbols_before': current_symbols,
                'symbols_after': current_symbols, 'fear_greed': fear_greed,
                'regime': regime, 'error': err_msg,
            })
            return

        proposed_add    = grok_result.get('add', [])
        proposed_remove = grok_result.get('remove', [])
        reasoning       = grok_result.get('reasoning', '')
        print(f'[WATCHLIST] Grok proposes: +{proposed_add} -{proposed_remove}')

        # Apply guardrails
        guarded = apply_guardrails(
            add=proposed_add, remove=proposed_remove,
            current=current_symbols, symbol_stats=symbol_stats,
            max_changes=5,
            hard_cap=wl_cfg['max_symbols_hard_cap'],
            min_symbols=10,
            valid_symbols=valid_symbols,
        )
        final_add    = guarded['add']
        final_remove = guarded['remove']
        skipped      = guarded['skipped_removals']

        if skipped:
            print(f'[WATCHLIST] Guardrails blocked removal of: {skipped}')

        if not final_add and not final_remove:
            print('[WATCHLIST] No changes needed')
            telegram_send(format_telegram_message(
                status='no_changes', added=[], removed=[], skipped=skipped,
                symbols_after=current_symbols, fear_greed=fear_greed,
                regime=regime, reasoning=reasoning,
            ))
            log_to_postgres(pg, run_id, {
                'status': 'no_changes', 'symbols_before': current_symbols,
                'symbols_after': current_symbols, 'added': [], 'removed': [],
                'skipped_removals': skipped, 'fear_greed': fear_greed,
                'regime': regime, 'grok_reasoning': reasoning,
            })
            return

        # Compute new symbol list
        new_symbols = [s for s in current_symbols if s not in final_remove] + final_add
        print(f'[WATCHLIST] New list ({len(new_symbols)}): {new_symbols}')

        if args.dry_run:
            print('[WATCHLIST] DRY RUN — no changes written')
            print(f'  Would add:    {final_add}')
            print(f'  Would remove: {final_remove}')
            return

        # Apply changes
        print('[WATCHLIST] Writing cryonix.toml...')
        write_toml_whitelist(new_symbols)

        print('[WATCHLIST] Committing to git...')
        git_commit(final_add, final_remove)

        print('[WATCHLIST] Restarting engine...')
        restart_engine_status = 'applied'
        try:
            restart_engine()
            print('[WATCHLIST] Engine restarted.')
        except subprocess.CalledProcessError as e:
            restart_engine_status = 'applied_no_restart'
            print(f'[WATCHLIST] Engine restart failed: {e}')

        # Log + notify
        log_to_postgres(pg, run_id, {
            'status': restart_engine_status,
            'symbols_before': current_symbols,
            'symbols_after':  new_symbols,
            'added':          final_add,
            'removed':        final_remove,
            'skipped_removals': skipped,
            'fear_greed':     fear_greed,
            'regime':         regime,
            'grok_reasoning': reasoning,
        })

        telegram_send(format_telegram_message(
            status='applied', added=final_add, removed=final_remove, skipped=skipped,
            symbols_after=new_symbols, fear_greed=fear_greed,
            regime=regime, reasoning=reasoning,
            symbol_stats=symbol_stats,
        ))

        if restart_engine_status == 'applied_no_restart':
            telegram_send('⚠️ Engine-restart misslyckades — symbolerna är uppdaterade i cryonix.toml men engine kör gamla listan tills nästa omstart.')

    finally:
        pg.close()
        r.close()

    print(f'[WATCHLIST] Run {run_id} complete.')


if __name__ == '__main__':
    main()
```

- [ ] **Step 4: Run all tests**

```bash
cd scripts/strategy-lab && python3 -m pytest tests/test_watchlist_agent.py -v 2>&1 | tail -20
```

Expected: All tests pass.

- [ ] **Step 5: Syntax check**

```bash
python3 -m py_compile scripts/strategy-lab/watchlist_agent.py && echo "Syntax OK"
```

Expected: `Syntax OK`

- [ ] **Step 6: Commit**

```bash
git add scripts/strategy-lab/watchlist_agent.py
git commit -m "feat(watchlist): add Grok integration, apply_changes, main orchestrator"
```

---

## Chunk 5: Deployment

### Task 5: DB migration + cron + dry-run verification

**Files:**
- No new files — operational steps only

- [ ] **Step 1: Deploy code to VM**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
```

- [ ] **Step 2: Run DB migration on prod**

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c \"
  CREATE TABLE IF NOT EXISTS watchlist_changes (
    id SERIAL PRIMARY KEY,
    run_id VARCHAR(20) NOT NULL,
    run_at TIMESTAMP DEFAULT NOW(),
    symbols_before TEXT[] NOT NULL,
    symbols_after TEXT[] NOT NULL,
    added TEXT[],
    removed TEXT[],
    skipped_removals TEXT[],
    fear_greed INTEGER,
    regime VARCHAR(20),
    grok_reasoning TEXT,
    status VARCHAR(20) DEFAULT 'applied',
    error TEXT
  );
\""
```

- [ ] **Step 3: Verify table created**

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c '\d watchlist_changes'"
```

Expected: Table structure with all columns listed.

- [ ] **Step 4: Run dry-run on VM to verify end-to-end**

```bash
ssh azureuser@openclaw-vm "cd ~/cryonix && set -a && source .env && set +a && python3 scripts/strategy-lab/watchlist_agent.py --dry-run"
```

Expected output (example):
```
[WATCHLIST] Starting run wl_20260310_0500 (dry_run=True)
[WATCHLIST] Fear/Greed=52, Regime=trending
[WATCHLIST] Collecting symbol stats...
[WATCHLIST] Discovering candidates...
[WATCHLIST] Found N candidates
[WATCHLIST] Fetching valid Binance symbols...
[WATCHLIST] Calling Grok...
[WATCHLIST] Grok proposes: +['PEPE/USDC'] -[]
[WATCHLIST] DRY RUN — no changes written
  Would add:    ['PEPE/USDC']
  Would remove: []
[WATCHLIST] Run wl_20260310_0500 complete.
```

- [ ] **Step 5: Add cron entry on VM**

```bash
ssh azureuser@openclaw-vm "crontab -l"
# Note current crontab, then add:
ssh azureuser@openclaw-vm "(crontab -l; echo '0 5 * * 2,5 cd ~/cryonix && set -a && source .env && set +a && TELEGRAM_EVOLUTION_BOT_TOKEN=\$TELEGRAM_BOT_TOKEN python3 scripts/strategy-lab/watchlist_agent.py >> logs/watchlist_agent.log 2>&1') | crontab -"
```

- [ ] **Step 6: Verify cron entry**

```bash
ssh azureuser@openclaw-vm "crontab -l | grep watchlist"
```

Expected: `0 5 * * 2,5 cd ~/cryonix && set -a ...watchlist_agent.py...`

- [ ] **Step 7: Create logs directory if missing**

```bash
ssh azureuser@openclaw-vm "mkdir -p ~/cryonix/logs"
```

- [ ] **Step 8: Final commit (update CLAUDE.md background workers section)**

In `CLAUDE.md`, in the "Background Workers" section, add:
```
- `scripts/strategy-lab/watchlist_agent.py` — Autonomous watchlist rotation (Tue+Fri 05:00 UTC, Grok-driven)
```

```bash
git add CLAUDE.md
git commit -m "docs: document watchlist_agent.py in CLAUDE.md background workers"
```

---

## Not In Scope

- Real-time symbol add/remove without engine restart
- UI for watchlist history (watchlist_changes table is queryable via Postgres directly)
- Per-symbol Coinglass scoring in candidate ranking (follow-up)

## Deployment Notes

### SQL Migration (run on prod before deploy)
```sql
CREATE TABLE IF NOT EXISTS watchlist_changes (
  id SERIAL PRIMARY KEY,
  run_id VARCHAR(20) NOT NULL,
  run_at TIMESTAMP DEFAULT NOW(),
  symbols_before TEXT[] NOT NULL,
  symbols_after TEXT[] NOT NULL,
  added TEXT[],
  removed TEXT[],
  skipped_removals TEXT[],
  fear_greed INTEGER,
  regime VARCHAR(20),
  grok_reasoning TEXT,
  status VARCHAR(20) DEFAULT 'applied',
  error TEXT
);
```

### Cron Entry (add to VM crontab)
```bash
0 5 * * 2,5 cd ~/cryonix && set -a && source .env && set +a && python3 scripts/strategy-lab/watchlist_agent.py >> logs/watchlist_agent.log 2>&1
```

### Verify
```bash
# Dry run first
python3 scripts/strategy-lab/watchlist_agent.py --dry-run
```
- Grid and scalp position symbol management
