# Backtest Integration — Evolution & AI Brain

**Date:** 2026-02-20
**Approach:** A — "Backtest-as-a-function"
**Status:** Approved

## Problem

Evolution and AI Brain modify trading parameters (cryonix.toml) without validating
whether the changes actually improve backtested performance. Evolution mutates blindly
and waits for live results. AI Brain relies on Grok's reasoning without empirical data.

## Solution

A single Python function `quick_backtest()` that both agents call directly.
No new services, no HTTP calls, no queues, no new database tables.

## New File: `scripts/strategy-lab/quick_backtest.py`

```python
def quick_backtest(symbol: str, days: int = 14, config_overrides: dict = None) -> dict:
    """
    Run a fast backtest using the QuantGuild engine.

    Args:
        symbol: Trading pair (e.g. "BTC/USDC")
        days: Lookback period (default 14)
        config_overrides: Optional dict of TOML params to override
            e.g. {"min_confidence": 0.75, "sl_atr_multiplier": 3.5}

    Returns:
        {
            "sharpe_ratio": float,
            "profit_factor": float,
            "win_rate": float,
            "total_return_pct": float,
            "max_drawdown_pct": float,
            "total_trades": int,
        }
    """
```

- Reuses QuantGuild engine (same as live scanning)
- Reuses OHLCV fetch logic from `backtest.py`
- Does NOT save to Postgres
- ~5-10 seconds per run (1 symbol, 14 days)

## Evolution Integration

**Where:** `scripts/evolution/copilot-evolution.mjs`
**When:** After Claude Code mutation + verification, BEFORE commit

```
analyze → claude mutates → verify (type-check, tests)
    → BACKTEST GATE (new)
    → commit → deploy
```

### Backtest Gate Logic

1. Read `git diff` to identify which TOML params changed
2. Run `quick_backtest(symbol, 14, original_config)` → baseline
3. Run `quick_backtest(symbol, 14, mutated_config)` → candidate
4. Symbol chosen from the pattern that triggered evolution
5. Comparison criteria:
   - `candidate.profit_factor >= baseline.profit_factor` OR
   - `candidate.sharpe_ratio > baseline.sharpe_ratio`
   - AND `candidate.max_drawdown_pct <= baseline.max_drawdown_pct * 1.2`
6. Pass → commit as usual, log backtest results in `evolution_runs.changes_made`
7. Fail → `git checkout -- .`, log "rejected by backtest"

**Time cost:** ~10-20 sec (2 backtests). Marginal vs Evolution's 15-40 min total.

## AI Brain Integration

**Where:** `scripts/strategy-lab/ai_brain.py`
**When:** Before Grok API call, as additional context

### Flow

1. Before calling Grok, run `quick_backtest()` for top 3 symbols (BTC, ETH, SOL)
2. Add results to `context["backtest_baseline"]`
3. Grok sees actual performance data, not just trade history

### What Grok Receives (new field)

```python
context["backtest_baseline"] = {
    "BTC/USDC": {"sharpe": -4.16, "profit_factor": 0.37, "win_rate": 38.9},
    "ETH/USDC": {"sharpe": -8.11, "profit_factor": 0.31, "win_rate": 37.5},
    "SOL/USDC": {"sharpe": -2.91, "profit_factor": 0.56, "win_rate": 34.8},
}
```

**Role:** Advisory only — one input among many. No gating.
**Time cost:** ~15-30 sec (3 symbols). Total AI Brain: 20-50 sec (was 5-20 sec).

## What We Do NOT Build

- No new service/daemon
- No queue/worker system
- No new API endpoint
- No new database table
- No new cron job
- No TS backtester involvement (Python only)

## Files Changed

| File | Action |
|------|--------|
| `scripts/strategy-lab/quick_backtest.py` | NEW — extract backtest logic |
| `scripts/evolution/copilot-evolution.mjs` | MODIFY — add backtest gate |
| `scripts/strategy-lab/ai_brain.py` | MODIFY — add backtest context |
