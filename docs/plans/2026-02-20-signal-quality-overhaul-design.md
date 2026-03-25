# Signal Quality Overhaul — Design

**Date:** 2026-02-20
**Status:** Approved
**Problem:** Backtest shows 0/15 symbols profitable, 38% win rate, profit factor 0.48. Signal quality is the root cause.

## Root Causes

1. **No HTF hard veto** — 1h+4h trend only adjusts confidence ±5-10%, never blocks. BUY signals pass in strong downtrends.
2. **All 6 core patterns run only on 15m** — High noise, many false signals. No multi-timeframe confirmation.
3. **No regime-pattern matching** — Mean-reversion patterns (RSI) fire in trending markets. Trend-following patterns (EMA cross) fire in ranging markets.
4. **MOMENTUM_GAINER bypasses consensus gate** — MarketScoutTank creates single-pattern BUY signals directly, circumventing the 2+ pattern requirement.
5. **RSI oversold=35 too generous** — Standard crypto is 30. RSI 30-35 in downtrends is continuation, not reversal.
6. **R:R = 1.22** (SL 4.5 ATR / TP 5.5 ATR) — Below the stated min_risk_reward=1.3.

## Design

### 1. HTF Hard Veto

New function `_passes_htf_gate()` in QuantGuild.

- Evaluate trend on **1h and 4h** via EMA 9/21 position + price position relative to EMA21
- **Hard block BUY** if both 1h + 4h are bearish (EMA9 < EMA21 AND price < EMA21)
- **Hard block SELL** if both 1h + 4h are bullish
- Single TF confirming: allow with -15% confidence penalty
- Both TF confirming direction: +10% confidence boost
- Applied in `_generate_signal()` before consensus gate

### 2. Multi-Timeframe Pattern Confirmation

Each pattern detector receives `indicators_1h` and `indicators_4h`. Patterns that fail HTF confirmation are **rejected entirely** (not just lower confidence).

| Pattern | 15m Trigger | Required HTF Confirmation |
|---------|------------|---------------------------|
| RSI_OVERSOLD | RSI < 30 | 1h RSI < 40 |
| RSI_OVERBOUGHT | RSI > 70 | 1h RSI > 60 |
| BOLLINGER_SQUEEZE | BB width < 20th pctl | 1h BB width < 30th pctl |
| VOLUME_SPIKE | vol > 2x avg | 1h vol > 1.5x avg |
| MACD_CROSS | Histogram sign change | 1h MACD histogram same direction |
| EMA_CROSS | EMA9 crosses EMA21 | 1h EMA9/21 already aligned in same direction |
| DIP_BUY | 5% drawdown + recovery | 4h RSI < 45 |

### 3. Regime-Gated Pattern Selection

Filter patterns by market regime after detection, before consensus gate.

| Regime | Allowed Patterns | Blocked Patterns |
|--------|-----------------|------------------|
| **Trending** (ADX >= 25) | EMA_CROSS, MACD_CROSS, MOMENTUM_GAINER, DIP_BUY* | RSI, BOLLINGER_SQUEEZE |
| **Ranging** (ADX < 25) | RSI, BOLLINGER_SQUEEZE, VOLUME_SPIKE | EMA_CROSS, MACD_CROSS |
| **Volatile** (ATR > 2x) | DEEP_VALUE_CRASH, VOLUME_SPIKE | Everything else |

*DIP_BUY in trending: only if trend is UP (price > EMA21). Downtrend dips are blocked.

DEEP_VALUE_CRASH and VOLUME_SPIKE are regime-agnostic (allowed in all regimes).

Consensus gate (2+ patterns) applies to the **remaining** patterns after regime filtering. If 3 detected but 2 filtered = 1 remaining = blocked by consensus. This is intended behavior.

### 4. MOMENTUM_GAINER Fix

- **Move** MOMENTUM_GAINER detection into QuantGuild as a regular pattern detector
- Subject to consensus gate (requires 2+ confirming patterns)
- Classified as **trend-following** → only allowed in trending regime
- **Remove** the override logic in `market_scout.py` lines 154-164

### 5. Threshold Adjustments

| Parameter | Current | New | Rationale |
|-----------|---------|-----|-----------|
| RSI oversold | 35 | **30** | Standard for crypto |
| SL ATR multiplier | 4.5 | **3.5** | Tighter SL, 22% less loss per losing trade |
| TP ATR multiplier | 5.5 | **5.5** | Unchanged — R:R improves to 1.57 |
| EMA_CROSS confidence | 0.65 | **0.60** | Below min_confidence alone, forces confirmation |
| MACD_CROSS confidence | 0.68 | **0.62** | Same logic |
| Consensus 2-pattern boost | +10% | **+8%** | Avoid confidence inflation |

## Files Modified

| File | Changes |
|------|---------|
| `packages/engine/src/guilds/quant.py` | HTF gate, multi-TF confirmation, regime filter, MOMENTUM_GAINER detector, threshold changes |
| `packages/engine/src/tanks/market_scout.py` | Remove MOMENTUM_GAINER override (lines 154-164) |
| `cryonix.toml` | RSI, SL ATR, confidence, consensus parameters |

## Expected Impact

- ~60-70% fewer signals (aggressive filtering)
- Win rate: 38% → estimated 50-55%
- Profit factor: 0.48 → estimated 0.8-1.1
- R:R: 1.22 → 1.57
- Per-trade loss reduced 22% (tighter SL)

## Verification

1. Backtest before/after on same 30-day period, same 15 symbols
2. Compare: signal count, win rate, profit factor, max drawdown
3. 48h live baseline measurement after deploy
