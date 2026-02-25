# ADR-011: Smart Dip Hunter Strategy
**Date:** 2026-02-25 | **Status:** Active

## Context (Why)
Full system audit revealed 29% win rate (19W/44L), total PnL -$3.72. Root cause: most losses came from trend-following patterns (MACD+EMA crosses had 0% win rate in live trading). Meanwhile, value/dip patterns (DIP_BUY, DEEP_VALUE_CRASH, BOLLINGER_SQUEEZE) had strong positive EV. Backtests confirmed: dip patterns +$0.64/month projected, trend patterns were consistent losers.

**Origin:** `docs/plans/2026-02-25-smart-dip-hunter-strategy.md`

## Decision (What)
Enable `dip_focus_mode` in `cryonix.toml`:
- Only allow trades with at least one value pattern: DIP_BUY, DEEP_VALUE_CRASH, BOLLINGER_SQUEEZE
- Block pure trend-following signals (MACD+EMA without dip context)
- Single toggle to revert: `dip_focus_mode = false`

**See also:** [ADR-025](025-trending-exception-adx.md) — ADX > 30 exception added same day to prevent idle capital in strong trends.

## Consequences (How)
- Fewer trades but higher quality — accepts missing profitable MACD+EMA trades as trade-off
- Expected: 24 trades/month with +1.6% return (vs previous -10%/month)
- No trades for 5 days post-activation (market was overbought) — working as designed
- Filter applied in auto-trade route after weak solo filter, before EV model
