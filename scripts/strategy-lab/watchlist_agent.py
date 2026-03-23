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
GROK_MODEL = 'grok-4-1-fast-non-reasoning'

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


# ── Grok ─────────────────────────────────────────────────────────────────────

def build_grok_prompt(
    current_symbols: list,
    symbol_stats: dict,
    candidates: list,
    wl_cfg: dict,
    fear_greed: int,
    regime: str,
) -> str:
    max_sym  = wl_cfg['max_symbols']
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
    """Call Grok with 3 retries (30s backoff). Returns parsed JSON or raises RuntimeError."""
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

            # Strip markdown code fences if present (ai_brain.py pattern)
            if content.startswith('```'):
                content = content.split('\n', 1)[1]
                if content.endswith('```'):
                    content = content[:-3]

            parsed = json.loads(content)
            if not isinstance(parsed.get('add'), list) or not isinstance(parsed.get('remove'), list):
                raise ValueError('Missing add/remove arrays in Grok response')
            return parsed

        except Exception as e:
            print(f'[WATCHLIST] Grok attempt {attempt}/3 failed: {e}')
            if attempt < 3:
                time.sleep(30 * attempt)

    raise RuntimeError('Grok call failed after 3 attempts')


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
        data.get('added', []) or [],
        data.get('removed', []) or [],
        data.get('skipped_removals', []) or [],
        data.get('fear_greed'),
        data.get('regime'),
        data.get('grok_reasoning'),
        data['status'],
        data.get('error'),
    ))
    pg.commit()


def telegram_send(text: str) -> None:
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print(f'[TELEGRAM] Skipping (no token): {text[:80]}')
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

        # Collect symbol performance data
        print('[WATCHLIST] Collecting symbol stats...')
        symbol_stats = {}
        try:
            symbol_stats = collect_symbol_stats(pg, current_symbols, wl_cfg)
        except Exception as e:
            print(f'[WATCHLIST] WARNING: symbol stats query failed: {e} — proceeding in add-only mode')
            for sym in current_symbols:
                symbol_stats[sym] = {
                    'symbol': sym, 'trades': 0, 'win_rate': 0.0,
                    'total_pnl_usd': 0.0, 'avg_pnl_pct': 0.0,
                    'days_on_watchlist': 0, 'removal_eligible': False,
                }

        # Discover candidates
        print('[WATCHLIST] Discovering candidates...')
        candidates = discover_candidates(r, current_symbols, wl_cfg)
        print(f'[WATCHLIST] Found {len(candidates)} candidates')

        # Get valid Binance symbols (CCXT)
        print('[WATCHLIST] Fetching valid Binance symbols...')
        valid_symbols = get_valid_binance_symbols()
        if not valid_symbols:
            print('[WATCHLIST] CCXT fallback: using TRACKED_SYMBOLS_USDC as valid set')
            valid_symbols = set(TRACKED_SYMBOLS_USDC) | set(current_symbols)

        # Build prompt and call Grok
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

        # Apply: write TOML
        print('[WATCHLIST] Writing cryonix.toml...')
        write_toml_whitelist(new_symbols)

        # Apply: git commit
        print('[WATCHLIST] Committing to git...')
        git_commit(final_add, final_remove)

        # Apply: restart engine
        restart_status = 'applied'
        print('[WATCHLIST] Restarting engine...')
        try:
            restart_engine()
            print('[WATCHLIST] Engine restarted.')
        except subprocess.CalledProcessError as e:
            restart_status = 'applied_no_restart'
            print(f'[WATCHLIST] Engine restart failed: {e}')

        # Log + notify
        log_to_postgres(pg, run_id, {
            'status': restart_status,
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

        if restart_status == 'applied_no_restart':
            telegram_send('⚠️ Engine-restart misslyckades — symbolerna är uppdaterade i cryonix.toml men engine kör gamla listan tills nästa omstart.')

    finally:
        pg.close()
        r.close()

    print(f'[WATCHLIST] Run {run_id} complete.')


if __name__ == '__main__':
    main()
