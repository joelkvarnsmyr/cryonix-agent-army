# ADR-022: Signal Quality Overhaul -- HTF Veto, Multi-TF Confirmation, Regime Gating
**Date:** 2026-02-20 | **Status:** Active

**Origin:** `docs/plans/2026-02-20-signal-quality-overhaul-design.md`

### Context (Why)

Backtesting across all 15 symbols showed 0/15 profitable, 38% win rate, profit factor 0.48, and R:R of 1.22 (below the configured min_risk_reward of 1.3). Signal quality was the root cause -- the system generated too many false signals.

Six specific problems identified:
1. **No HTF hard veto**: 1h + 4h trend only adjusted confidence by +/-5-10%, never blocked. BUY signals passed in strong downtrends.
2. **All 6 core patterns ran only on 15m**: High noise, many false signals with no multi-timeframe confirmation.
3. **No regime-pattern matching**: Mean-reversion patterns (RSI) fired in trending markets; trend-following patterns (EMA cross) fired in ranging markets.
4. **MOMENTUM_GAINER bypassed consensus gate**: MarketScoutTank created single-pattern BUY signals directly, circumventing the 2+ pattern requirement.
5. **RSI oversold threshold too generous**: Set at 35, while standard crypto is 30. RSI 30-35 in downtrends is continuation, not reversal.
6. **R:R below minimum**: SL 4.5 ATR / TP 5.5 ATR = 1.22 ratio, below the 1.3 floor.

### Decision (What)

Five changes to the QuantGuild pattern detection engine (`packages/engine/src/guilds/quant.py`):

**1. HTF Hard Veto** (`_passes_htf_gate()`): Evaluate trend on 1h and 4h via EMA 9/21 position + price relative to EMA21. Hard block BUY if both timeframes are bearish (EMA9 < EMA21 AND price < EMA21). Single TF confirming: allow with -15% confidence penalty. Both confirming: +10% boost. Applied before consensus gate.

**2. Multi-TF Pattern Confirmation**: Each pattern detector receives `indicators_1h` and `indicators_4h`. Patterns failing HTF confirmation are rejected entirely (not lower confidence). Examples: RSI_OVERSOLD on 15m requires 1h RSI < 40; MACD_CROSS on 15m requires 1h histogram same direction; DIP_BUY requires 4h RSI < 45.

**3. Regime-Gated Pattern Selection**: Filter patterns by market regime after detection, before consensus gate.
- Trending (ADX >= 25): Allow EMA_CROSS, MACD_CROSS, MOMENTUM_GAINER, DIP_BUY (uptrend only). Block RSI, BOLLINGER_SQUEEZE.
- Ranging (ADX < 25): Allow RSI, BOLLINGER_SQUEEZE, VOLUME_SPIKE. Block EMA_CROSS, MACD_CROSS.
- Volatile (ATR > 2x): Allow DEEP_VALUE_CRASH, VOLUME_SPIKE only.

Consensus gate (2+ patterns) applies to remaining patterns after regime filtering. If 3 detected but 2 filtered = 1 remaining = blocked. This is intentional.

**4. MOMENTUM_GAINER normalization**: Moved into QuantGuild as a regular pattern detector, subject to consensus gate and classified as trend-following (only allowed in trending regime). Removed the override in `market_scout.py` that bypassed the consensus requirement.

**5. Threshold adjustments**: RSI oversold 35 -> 30 (standard crypto). SL ATR multiplier 4.5 -> 3.5 (22% less loss per trade, R:R improves to 1.57). EMA_CROSS and MACD_CROSS base confidence lowered to 0.60/0.62 (below min_confidence alone, forcing pattern confirmation). Consensus 2-pattern boost reduced from +10% to +8% to avoid confidence inflation.

### Consequences (How)

- **Positive**: Expected ~60-70% reduction in signal volume. Win rate estimated to improve from 38% to 50-55%. Profit factor from 0.48 to 0.8-1.1. R:R from 1.22 to 1.57. Per-trade loss reduced 22%.
- **Trade-off**: Dramatically fewer trades means slower account growth if the remaining signals are profitable. With only 2 symbols (at the time), the system might go days without a trade.
- **Trade-off**: Regime gating can mis-classify transitional markets. A market shifting from ranging to trending may have its early trend signals blocked by the ranging regime classification (ADX lags).
- **Trade-off**: HTF veto prevents buying reversals at the very bottom (the most profitable entries) because 1h + 4h will still show bearish when the 15m reversal begins. This is a deliberate sacrifice of upside for reliability.
- **Verification**: Before/after backtest on same 30-day period + 48h live baseline measurement.
