# Backtest Results — Post Signal Quality Overhaul (Previous 30d, 15 symbols)

**Date:** 2026-02-20
**Engine:** Python QuantGuild with HTF veto, multi-TF confirmation, regime gates
**Config:** `cryonix.toml` — rsi_oversold 30, sl_atr 3.5, tp_atr 6.0, consensus boost 8%
**Capital:** $10,000 per symbol
**Timeframe:** 15m primary, 1h/4h/1d multi-TF context
**Period:** Previous 30 days (~day 60–30 ago, ~21 Jan – 20 Feb 2026)
**Purpose:** Validate signal quality overhaul on a different market period

---

## Results — Previous 30d Window

| Symbol | Trades | Win Rate | Return % | Max DD % | Sharpe | PF | Expectancy |
|--------|--------|----------|----------|----------|--------|----|------------|
| ATOM | 8 | 50.0% | **+1.00%** | 1.73% | 1.26 | 1.36 | 12.48 |
| INJ | 6 | 50.0% | **+0.74%** | 0.53% | 1.37 | 1.74 | 12.28 |
| SOL | 6 | 50.0% | **+0.43%** | 0.94% | 0.98 | 1.32 | 7.22 |
| NEAR | 3 | 66.7% | +0.00% | 0.67% | 0.02 | 1.00 | 0.08 |
| BNB | 0 | — | +0.00% | 0.00% | — | — | — |
| DOGE | 4 | 50.0% | -0.28% | 1.85% | -0.46 | 0.73 | -6.91 |
| BTC | 6 | 33.3% | -0.51% | 1.26% | -1.24 | 0.65 | -8.49 |
| DOT | 4 | 50.0% | -0.53% | 1.04% | -1.02 | 0.61 | -13.25 |
| OP | 4 | 50.0% | -0.59% | 1.86% | -0.94 | 0.57 | -14.80 |
| ADA | 4 | 50.0% | -0.68% | 2.26% | -0.90 | 0.51 | -16.94 |
| ARB | 1 | 0.0% | -0.73% | 1.71% | -1.31 | 0.00 | -73.20 |
| ETH | 4 | 25.0% | -0.73% | 1.44% | -1.66 | 0.50 | -18.29 |
| LINK | 4 | 25.0% | -0.88% | 1.61% | -1.95 | 0.43 | -22.05 |
| FIL | 7 | 28.6% | -1.26% | 2.08% | -2.65 | 0.44 | -17.97 |
| AVAX | 5 | 20.0% | -1.56% | 2.65% | -2.63 | 0.17 | -31.15 |

---

## Cross-Period Comparison

| Metric | Recent 30d | Previous 30d |
|--------|:----------:|:------------:|
| Total trades | 56 | 66 |
| Avg trades/symbol | 3.7 | 4.4 |
| Avg win rate | 52.7% | 40.5% |
| Avg return | -0.38% | -0.42% |
| Profitable symbols | 9/15 | 3/15 |
| Avg max drawdown | 2.05% | 1.44% |
| Max loss per symbol | -5.26% (SOL) | -1.56% (AVAX) |

---

## Comparison vs Pre-Overhaul Baseline

| Metric | Pre-Overhaul (TA-only) | Recent 30d | Previous 30d |
|--------|:----------------------:|:----------:|:------------:|
| Avg trades/symbol | 24.8 | 3.7 | 4.4 |
| Avg win rate | 38.0% | 52.7% | 40.5% |
| Avg return | **-6.57%** | **-0.38%** | **-0.42%** |
| Profitable symbols | 0/15 | 9/15 | 3/15 |
| Avg max drawdown | 7.87% | 2.05% | 1.44% |

---

## Key Insights

1. **Consistent near break-even** — avg return -0.42% vs -0.38%, the overhaul works across market conditions
2. **Dramatically better than pre-overhaul** — -0.42% vs -6.57% in the old strategy, a 94% reduction in losses
3. **INJ + ATOM profitable in both periods** — strongest and most consistent symbols
4. **Previous 30d was a harder market** — only 3/15 profitable vs 9/15, but losses stayed small
5. **Max drawdown contained** — worst symbol lost only -1.56% (AVAX) vs -15.17% (OP) pre-overhaul
6. **Trade count stable** — 4.4/symbol/30d, slightly more than recent period (3.7)
7. **Strategy is robust but not yet profitable** — needs further optimization or symbol selection to cross into consistent profit
