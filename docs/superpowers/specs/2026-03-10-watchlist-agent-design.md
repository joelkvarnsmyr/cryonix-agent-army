# Watchlist Agent Design

**Date:** 2026-03-10
**Status:** Approved

## Overview

A fully autonomous Python script that owns the `symbol_whitelist` in `cryonix.toml`. It runs twice per week, evaluates current symbol performance, discovers new candidates from Binance + CoinMarketCap, calls Grok for final selection, and applies changes by writing TOML + restarting the engine. No human approval required — guardrails are code-enforced.

## Problem

The 15-symbol watchlist is hardcoded and never updated. Underperforming symbols stay on indefinitely. High-opportunity symbols that appear in the top-100 CMC never get considered. No process exists for data-driven symbol rotation.

## Design

### Architecture

Pattern: identical to `scripts/strategy-lab/ai_brain.py` — standalone Python script driven by cron.

```
watchlist_agent.py
  │
  ├─ 1. Collect symbol performance
  │     └─ SQL: position_history GROUP BY symbol, last 30 days
  │
  ├─ 2. Discover candidates
  │     ├─ CCXT load_markets() → active USDC pairs on Binance
  │     └─ CMC Redis (cmc:mcap:{SYMBOL}) → rank, volume, fdv_mc_ratio, 7d_change
  │
  ├─ 3. Score candidates (0-100)
  │     └─ CMC rank (40p) + volume (30p) + FDV/MC (20p) + 7d trend (10p)
  │
  ├─ 4. Grok analysis
  │     └─ Input: current list + stats + top-20 candidates + market context
  │     └─ Output: JSON {add: [...], remove: [...], reasoning: "..."}
  │
  ├─ 5. Code guardrails (applied after Grok response)
  │     ├─ Max 5 changes per run
  │     ├─ Only remove if removal_eligible=True (≥5 trades + ≥14 days)
  │     ├─ Total symbols must stay within [10, max_symbols_hard_cap]
  │     └─ Skip entire run if Fear/Greed < 15 or > 85
  │
  ├─ 6. Write symbol_whitelist to cryonix.toml + git commit
  │
  ├─ 7. docker compose -f docker-compose.prod.yml restart engine
  │
  └─ 8. Log to watchlist_changes (Postgres) + Telegram notification
```

### Cron Schedule

```
0 5 * * 2,5   # Tuesday + Friday at 05:00 UTC
```

Same cron pattern as `run_evolution.sh`. Add to existing crontab on VM.

### Symbol Performance Query

```sql
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
ORDER BY total_pnl_usd DESC;
```

A symbol is `removal_eligible` if:
- `trades >= min_trades_before_removal` (default 5)
- `first_trade_at` is at least `min_days_on_watchlist` (default 14) days ago

### Candidate Scoring

```python
def score_candidate(symbol: str, cmc: dict) -> float:
    rank_score    = (1 - cmc['rank'] / CANDIDATE_POOL_RANK_LIMIT) * 40
    volume_score  = min(cmc['volume_24h'] / 50_000_000, 1.0) * 30
    dilution_score = (20 if cmc['fdv_mc_ratio'] < 2.0 else
                      10 if cmc['fdv_mc_ratio'] < 4.0 else 0)
    trend_score   = max(0, min(cmc['percent_change_7d'] / 20, 1.0)) * 10
    return rank_score + volume_score + dilution_score + trend_score
```

Only symbols NOT already on the watchlist are considered as candidates.
Top 20 by score are passed to Grok.

### Grok Prompt

```
WATCHLIST AGENT — {run_id}
Market: regime={regime}, fear_greed={fg_value} ({fg_label})

CURRENT SYMBOLS ({n}):
symbol | trades_30d | win_rate | pnl_usd | avg_pnl_pct | eligible_for_removal
{rows}

CANDIDATES (not on watchlist, top 20 by score):
symbol | cmc_rank | vol_24h_usd | fdv_mc_ratio | 7d_change_pct | score
{rows}

RULES:
- Target {max_symbols} symbols, hard cap {max_symbols_hard_cap}
- Max 5 changes this run (adds + removes combined)
- Only remove symbols where eligible_for_removal=yes AND (win_rate < 40% OR pnl_usd < -2.0)
- Prefer candidates: high volume, low FDV/MC ratio, top-100 CMC rank
- Do not add a symbol if its score < 30

Respond with JSON only:
{"add": ["X/USDC"], "remove": ["Y/USDC"], "reasoning": "one paragraph"}
```

Grok is called with 3 retries (30s backoff). If all fail → abort run, status='failed'.
Response is validated as valid JSON with correct structure before any guardrail checks.

### Code Guardrails (post-Grok)

Applied in order, any violation causes the specific action to be dropped (not the whole run):

1. `total_changes = len(add) + len(remove)` → if > 5, truncate to highest-priority 5
2. Each symbol in `remove` must have `removal_eligible=True` in the collected stats → drop ineligible removals silently, log warning
3. `new_count = current_count - len(remove) + len(add)` → must be in `[10, max_symbols_hard_cap]` → truncate adds if needed
4. Each symbol in `add` must exist in the CCXT market list (active, USDC pair) → drop unknown symbols

### TOML Section (new)

```toml
[watchlist]
max_symbols = 15
max_symbols_hard_cap = 50
min_trades_before_removal = 5
min_days_on_watchlist = 14
candidate_pool_cmc_rank_limit = 150
candidate_min_volume_usd = 5000000
fear_greed_skip_below = 15
fear_greed_skip_above = 85
```

### Database Schema

New table `watchlist_changes`:

```sql
CREATE TABLE watchlist_changes (
  id               SERIAL PRIMARY KEY,
  run_id           VARCHAR(20) NOT NULL,
  run_at           TIMESTAMP DEFAULT NOW(),
  symbols_before   TEXT[] NOT NULL,
  symbols_after    TEXT[] NOT NULL,
  added            TEXT[],
  removed          TEXT[],
  skipped_removals TEXT[],
  fear_greed       INTEGER,
  regime           VARCHAR(20),
  grok_reasoning   TEXT,
  status           VARCHAR(20) DEFAULT 'applied',  -- 'applied' | 'skipped' | 'failed'
  error            TEXT
);
```

Migration (run on prod before deploy):
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

### Error Handling

| Step | On failure |
|------|-----------|
| CCXT `load_markets()` | Fall back to CMC TRACKED_SYMBOLS list as candidate pool |
| Postgres performance query | Skip removal logic, only add candidates; log warning |
| Grok call (3 retries exhausted) | Abort run, status='failed', send Telegram alert |
| Invalid Grok JSON | Abort run, status='failed' |
| TOML write fails | Abort, file unchanged (no partial state) |
| `docker restart` fails | Log error, status='applied_no_restart', send Telegram alert — symbols updated in TOML but engine runs old list until next restart |

Baseline freeze: if `[baseline] frozen = true` in cryonix.toml → exit early (same pattern as AI Brain + Evolution).

### Telegram Notifications

**On successful change:**
```
🔄 Watchlist uppdaterad

➕ Tillagda (N): PEPE/USDC, WIF/USDC
➖ Borttagna (N): ADA/USDC (3 trades, -$1.10, 33% WR)
📊 Ny lista: 16 symboler

Fear/Greed: 52 (Neutral) | Regime: trending
Motivering: {grok_reasoning}
```

**On skipped run (market conditions):**
```
⏭️ Watchlist-körning skippad
Orsak: Fear/Greed {value} ({label}) — utanför säkert fönster [15, 85]
```

**On no changes needed:**
```
✅ Watchlist granskad — inga ändringar
Alla {n} symboler presterar acceptabelt. Nästa körning om 3-4 dagar.
```

**On failure:**
```
❌ Watchlist-agent misslyckades
Steg: Grok-anrop (3 försök)
Fel: {error_message}
Watchlist oförändrad.
```

## Files Changed

| File | Change |
|------|--------|
| `scripts/strategy-lab/watchlist_agent.py` | New — main agent script |
| `cryonix.toml` | Add `[watchlist]` section |
| `packages/database/src/schema.ts` | Add `watchlistChanges` table |
| `apps/web/src/app/api/analytics/watchlist/route.ts` | New — read watchlist_changes history (optional, can be follow-up) |

Drizzle schema change + SQL migration on prod for `watchlist_changes` table.

## Deployment

1. Deploy code
2. Run SQL migration on prod
3. Add cron entry on VM:
   ```bash
   0 5 * * 2,5 cd ~/cryonix && set -a && source .env && set +a && python3 scripts/strategy-lab/watchlist_agent.py >> logs/watchlist_agent.log 2>&1
   ```
4. Run once manually to verify: `python3 scripts/strategy-lab/watchlist_agent.py --dry-run`

## Not In Scope

- Real-time symbol addition/removal (that requires engine architecture changes)
- Per-symbol Coinglass scoring (can be added later as a signal boost, not gating)
- UI for watchlist management (Telegram notification is sufficient)
- Grid and scalp position symbols (they use the same watchlist, but their logic is unaffected)
