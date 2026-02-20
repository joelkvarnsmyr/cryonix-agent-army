# Backtest Results — 30 Days, All Symbols

**Date:** 2026-02-20
**Engine:** Python QuantGuild (patterns: RSI, Bollinger, MACD, EMA, Volume Spike, Dip Buy, Deep Value)
**Config:** `cryonix.toml` defaults — min_confidence 0.60, trailing_stop 3%, trailing_activation 2.5%, SL ATR 3.5x, TP ATR 6.5x
**Capital:** $10,000 per symbol
**Timeframe:** 15m primary, 1h/4h/1d multi-TF context
**Period:** 30 days (~2,880 candles per symbol)

---

## Results

| Symbol | Trades | Win Rate | Return % | Max DD % | Sharpe | Profit Factor | Expectancy |
|--------|--------|----------|----------|----------|--------|---------------|------------|
| ATOM | 22 | 50.0% | -1.12% | 5.60% | -0.18 | 0.84 | -5.11 |
| BTC | 21 | 47.6% | -3.36% | 4.91% | -3.10 | 0.50 | -16.00 |
| AVAX | 22 | 45.5% | -4.92% | 5.80% | -4.66 | 0.54 | -22.35 |
| ARB | 27 | 48.1% | -5.74% | 6.82% | -4.44 | 0.57 | -21.25 |
| SOL | 25 | 36.0% | -6.48% | 7.43% | -3.18 | 0.54 | -25.93 |
| DOT | 27 | 40.7% | -6.66% | 7.54% | -4.55 | 0.47 | -24.68 |
| INJ | 26 | 30.8% | -6.84% | 9.03% | -3.76 | 0.48 | -26.32 |
| DOGE | 23 | 30.4% | -7.09% | 7.18% | -3.50 | 0.46 | -30.82 |
| ETH | 25 | 40.0% | -7.10% | 7.27% | -5.72 | 0.42 | -28.39 |
| LINK | 23 | 30.4% | -7.12% | 7.12% | -5.58 | 0.38 | -30.94 |
| UNI | 22 | 45.5% | -7.56% | 9.77% | -4.42 | 0.48 | -34.36 |
| FIL | 25 | 36.0% | -7.86% | 7.91% | -6.15 | 0.38 | -31.43 |
| APT | 35 | 34.3% | -9.48% | 10.13% | -6.69 | 0.51 | -27.08 |
| NEAR | 28 | 25.0% | -12.08% | 12.79% | -7.92 | 0.31 | -43.13 |
| OP | 31 | 29.0% | -15.17% | 15.40% | -9.09 | 0.28 | -48.95 |

**Ej tillgangliga:** SUI/USDC, PEPE/USDC (inga USDC-par pa Binance)

---

## Aggregated Stats

| Metric | Value |
|--------|-------|
| Symbols tested | 15 |
| Total trades | 372 |
| Avg trades/symbol | 24.8 |
| Avg win rate | 38.0% |
| Avg return | -6.57% |
| Avg max drawdown | 7.87% |
| Avg Sharpe | -4.73 |
| Avg profit factor | 0.48 |
| Avg expectancy | -26.45 |
| Profitable symbols | 0 / 15 |

---

## Key Insights

### 1. Every symbol is unprofitable
All 15 tested symbols show negative returns over 30 days. Not a single pair is profitable. This is a systematic issue, not symbol-specific.

### 2. Win rate too low (38% avg)
With an average win rate of 38%, the strategy needs exceptional risk/reward (avg win >> avg loss) to compensate. The current profit factor of 0.48 shows avg losses far exceed avg wins. The strategy would need win rate >50% OR profit factor >1.5 to break even.

### 3. ATOM is the closest to break-even
ATOM stands out with 50% win rate, -0.18 Sharpe, and 0.84 profit factor. This suggests the pattern detection works better on assets with moderate volatility and cleaner trends.

### 4. High-volatility alts perform worst
OP (-15.17%), NEAR (-12.08%), APT (-9.48%) are the worst performers. These high-volatility tokens produce more false signals, likely because the pattern detectors (RSI, Bollinger, etc.) generate more noise on whipsaw price action.

### 5. Too many trades (overtrading)
24.8 trades per symbol over 30 days = nearly 1 trade/day. With 38% win rate each trade has negative expected value. Fewer, higher-conviction trades would likely improve results.

### 6. Stop-losses are likely too tight
The high number of losing trades combined with low win rate suggests stop-losses (SL ATR 3.5x) are getting triggered before the trade thesis plays out. The trailing stop (3%) may also be cutting winners short.

### 7. Drawdowns are manageable
Max drawdowns range 4.9%–15.4%, averaging 7.87%. This is within acceptable bounds for crypto trading. The capital preservation is decent — the problem is consistent small losses rather than catastrophic ones.

---

## Recommendations for Evolution & AI Brain

### Short-term (config tuning via AI Brain)
1. **Raise min_confidence from 0.60 to 0.70+** — filter out weak signals, reduce trade count
2. **Widen trailing_stop_pct from 3% to 4-5%** — let winners run longer
3. **Widen SL ATR multiplier from 3.5 to 4.0-4.5** — reduce premature stop-outs
4. **Reduce max_positions from 5 to 3** — concentrate on highest-conviction setups

### Medium-term (pattern evolution)
5. **Add trend filter** — only take BUY signals when higher timeframe (4h/1d) confirms uptrend
6. **Add volume confirmation** — require above-average volume on signal candle
7. **Pattern stacking** — require 2+ patterns to agree before entry (currently single-pattern can trigger)
8. **Time-of-day filter** — analyze if certain hours produce better results

### Long-term (architectural)
9. **Walk-forward optimization** — use rolling 14-day windows to continuously adapt parameters
10. **Per-symbol config** — ATOM gets different params than OP; one-size-fits-all hurts

---

## How This Data Is Used

- **Evolution (backtest gate):** Rejects mutations where profit_factor < 0.3 or max_drawdown > 25%
- **AI Brain (advisory context):** Feeds these metrics to Grok before each analysis cycle so parameter suggestions are grounded in empirical data
- **Backtest function:** `scripts/strategy-lab/quick_backtest.py` — lightweight wrapper, ~10 sec per run
