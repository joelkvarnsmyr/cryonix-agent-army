# ADR-020: Backtest Gate for Evolution and AI Brain
**Date:** 2026-02-20 | **Status:** Active

**Origin:** `docs/plans/2026-02-20-backtest-integration-design.md`

### Context (Why)

The Evolution system (every 2h) and AI Brain (every 6h) modify trading parameters in `cryonix.toml` without empirical validation. Evolution mutates blindly via Claude Code and waits for live results over days/weeks. AI Brain relies on Grok's reasoning about trade history but has no backtested evidence for whether proposed changes actually improve performance.

Both systems operate on belief rather than measurement. A parameter change that looks reasonable in theory may degrade backtested performance. Without a quality gate, bad mutations accumulate until live trading losses trigger a correction.

### Decision (What)

A single Python function `quick_backtest()` in `scripts/strategy-lab/quick_backtest.py` that both agents call directly. No new services, no HTTP calls, no queues, no new database tables.

```python
def quick_backtest(symbol, days=14, config_overrides=None) -> dict:
    # Returns: sharpe_ratio, profit_factor, win_rate, total_return_pct,
    #          max_drawdown_pct, total_trades
```

Reuses the QuantGuild engine (same as live scanning) and OHLCV fetch logic from `backtest.py`. Does not save to Postgres. Runs in ~5-10 seconds per symbol.

**Evolution integration** (hard gate): After Claude Code mutates config but BEFORE commit, the backtest gate runs:
1. Identify changed TOML params from `git diff`
2. Run `quick_backtest()` with original config (baseline)
3. Run `quick_backtest()` with mutated config (candidate)
4. Pass criteria: candidate profit_factor >= baseline OR sharpe_ratio > baseline, AND max_drawdown <= baseline * 1.2
5. Fail: `git checkout -- .`, log "rejected by backtest"

Time cost: ~10-20 sec (2 backtests), marginal vs Evolution's 15-40 min total runtime.

**AI Brain integration** (advisory context, not a gate): Before calling Grok, run `quick_backtest()` for top 3 symbols (BTC, ETH, SOL) and include results in the context. Grok sees actual performance data alongside trade history. Time cost: ~15-30 sec.

**Explicitly not built**: No new daemon, no queue/worker system, no new API endpoint, no new database table, no new cron job. Pure function call.

### Consequences (How)

- **Positive**: Evolution mutations are empirically validated before commit. Bad mutations are rejected with a log entry rather than deployed to production.
- **Positive**: AI Brain has quantitative backtest data to reason about, not just historical trade outcomes.
- **Trade-off**: Backtest accuracy depends on QuantGuild's pattern detection being representative. If the backtester and live scanner diverge, the gate could approve bad mutations or reject good ones.
- **Trade-off**: 14-day lookback window may not capture regime changes. A mutation that improves trending-market performance but degrades ranging-market performance could pass if the last 14 days were trending.
- **Trade-off**: AI Brain integration is advisory only (no gating) -- Grok may still override backtest evidence with its own reasoning. This is intentional to avoid over-constraining the AI's decision space.
