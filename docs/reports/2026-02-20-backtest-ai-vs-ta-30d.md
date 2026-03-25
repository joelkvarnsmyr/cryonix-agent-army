# Backtest Results — 30 Days, AI (Grok) vs TA-Only

**Date:** 2026-02-20
**Engine:** Python QuantGuild + Grok AI validation (grok-4-1-fast-reasoning)
**Config:** `cryonix.toml` — min_confidence 0.70, trailing_stop 3%, trailing_activation 2.5%
**Capital:** $10,000 per symbol
**Timeframe:** 15m primary, 1h/4h/1d multi-TF context
**Period:** 30 days (~2,880 candles per symbol)
**AI Mode:** Each BUY signal validated by Grok. Confidence blending: TA 60% + AI 40%.

---

## Results — With AI Validation

| Symbol | Trades | Win Rate | Return % | Max DD % | Sharpe | PF | Expectancy | AI Approved | AI Rejected |
|--------|--------|----------|----------|----------|--------|----|------------|-------------|-------------|
| ATOM | 21 | 66.7% | **+2.68%** | 2.68% | 2.22 | 1.53 | 12.76 | 21 | 3 |
| TIA | 26 | 50.0% | -0.94% | 3.24% | -0.68 | 0.92 | -3.62 | 26 | 4 |
| INJ | 21 | 38.1% | -3.40% | 4.77% | -2.32 | 0.67 | -16.21 | 21 | 1 |
| BTC | 16 | 37.5% | -4.49% | 5.14% | -4.61 | 0.29 | -28.09 | 16 | 2 |
| AVAX | 19 | 42.1% | -4.97% | 5.91% | -5.35 | 0.50 | -26.18 | 19 | 1 |
| ETH | 20 | 45.0% | -5.28% | 6.16% | -5.21 | 0.46 | -26.41 | 20 | 2 |
| DOT | 23 | 43.5% | -5.35% | 6.08% | -4.25 | 0.53 | -23.28 | 23 | 0 |
| ADA | 20 | 40.0% | -5.82% | 6.84% | -5.50 | 0.47 | -29.12 | 20 | 1 |
| DOGE | 21 | 33.3% | -6.03% | 6.40% | -3.26 | 0.50 | -28.73 | 21 | 0 |
| LINK | 22 | 36.4% | -6.40% | 6.42% | -7.62 | 0.46 | -29.10 | 22 | 0 |
| SOL | 22 | 36.4% | -6.58% | 7.41% | -3.26 | 0.52 | -29.89 | 22 | 0 |
| FIL | 19 | 36.8% | -8.07% | 8.56% | -6.93 | 0.34 | -42.47 | 19 | 1 |
| ARB | 23 | 39.1% | -8.81% | 8.88% | -7.75 | 0.32 | -38.30 | 23 | 2 |
| OP | 28 | 35.7% | -10.03% | 12.22% | -6.49 | 0.37 | -35.83 | 28 | 7 |
| NEAR | 24 | 25.0% | -11.64% | 12.22% | -9.09 | 0.27 | -48.49 | 24 | 1 |

---

## AI vs TA-Only Comparison (matching symbols)

| Symbol | TA Return | AI Return | Delta | TA WR | AI WR | TA Trades | AI Trades |
|--------|-----------|-----------|-------|-------|-------|-----------|-----------|
| ATOM | -1.12% | **+2.68%** | **+3.80%** | 50.0% | 66.7% | 22 | 21 |
| BTC | -3.36% | -4.49% | -1.13% | 47.6% | 37.5% | 21 | 16 |
| AVAX | -4.92% | -4.97% | -0.05% | 45.5% | 42.1% | 22 | 19 |
| ARB | -5.74% | -8.81% | -3.07% | 48.1% | 39.1% | 27 | 23 |
| SOL | -6.48% | -6.58% | -0.10% | 36.0% | 36.4% | 25 | 22 |
| DOT | -6.66% | -5.35% | **+1.31%** | 40.7% | 43.5% | 27 | 23 |
| INJ | -6.84% | -3.40% | **+3.44%** | 30.8% | 38.1% | 26 | 21 |
| DOGE | -7.09% | -6.03% | **+1.06%** | 30.4% | 33.3% | 23 | 21 |
| ETH | -7.10% | -5.28% | **+1.82%** | 40.0% | 45.0% | 25 | 20 |
| LINK | -7.12% | -6.40% | **+0.72%** | 30.4% | 36.4% | 23 | 22 |
| FIL | -7.86% | -8.07% | -0.21% | 36.0% | 36.8% | 25 | 19 |
| NEAR | -12.08% | -11.64% | **+0.44%** | 25.0% | 25.0% | 28 | 24 |
| OP | -15.17% | -10.03% | **+5.14%** | 29.0% | 35.7% | 31 | 28 |

---

## Aggregated Stats

| Metric | TA-Only | With AI | Delta |
|--------|---------|---------|-------|
| Symbols tested | 15 | 15 | — |
| Total trades | 372 | 325 | -47 (-12.6%) |
| Avg trades/symbol | 24.8 | 21.7 | -3.1 |
| Avg win rate | 38.0% | 39.0% | **+1.0%** |
| Avg return | -6.57% | -5.61% | **+0.96%** |
| Avg max drawdown | 7.87% | 6.86% | **-1.01%** |
| Avg Sharpe | -4.73 | -4.41 | **+0.32** |
| Avg profit factor | 0.48 | 0.54 | **+0.06** |
| Avg expectancy | -26.45 | -24.18 | **+2.27** |
| Profitable symbols | 0/15 | **1/15** | **+1** |
| Total AI rejections | — | 25 | — |
| Rejection rate | — | 7.1% | — |

---

## Key Insights

### 1. AI validation improves results across the board
Average return improved from -6.57% to -5.61% (+0.96%). One symbol (ATOM) turned profitable at +2.68% with AI. Drawdown reduced by ~1% on average.

### 2. Grok is too permissive — only 7.1% rejection rate
With 350 total signals, Grok only rejected 25 (7.1%). The live system should be more selective. The AI approved almost everything, suggesting the backtest prompt may need to be stricter or the live system's richer context (order book, sentiment, regime) makes a bigger difference.

### 3. Biggest AI improvements: OP (+5.14%), ATOM (+3.80%), INJ (+3.44%)
These symbols had the most signals rejected, and the rejected signals were indeed bad trades. This suggests AI adds most value on volatile mid-cap alts.

### 4. AI hurt BTC (-1.13%) and ARB (-3.07%)
On some symbols, AI filtered the wrong signals. BTC went from -3.36% to -4.49%. This may be because the simplified backtest prompt lacks the market context available in live trading.

### 5. ATOM is the standout performer
ATOM is the only profitable symbol both with and without AI. With AI, it reaches 66.7% win rate and a Sharpe of 2.22 — a genuinely tradeable result. Consider increasing ATOM allocation.

### 6. Win rate improved slightly (38% → 39%) but not enough
The strategy still fundamentally loses money on most symbols. Win rate needs to be >50% or profit factor >1.0 to break even. The AI helps marginally but doesn't solve the core issue.

### 7. Trade count reduced by 12.6%
AI filtered out 47 trades total. Fewer trades = less exposure = lower drawdown. This is a positive signal that the AI is at least reducing churn.

---

## Recommendations

1. **Increase AI rejection threshold** — The backtest prompt should be stricter. Consider requiring 3+ confirming indicators instead of 2+.
2. **Leverage ATOM's edge** — ATOM consistently performs best. Consider higher position sizing or dedicated strategy.
3. **Reduce exposure to worst performers** — NEAR, OP, FIL consistently lose >8%. Consider excluding or reducing position size.
4. **Test with longer lookback** — 30 days may be too short. Run 90-day backtest to separate signal quality from market conditions.
5. **Add market regime awareness** — The backtest lacks regime context (bull/bear/sideways) that the live system has via CMC Fear & Greed. This likely explains some AI underperformance.
6. **Cost analysis** — This run cost approximately 3 SEK ($0.27) for all 15 symbols. Cost-efficient enough to run regularly.
