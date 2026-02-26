# ADR-026: AI Prompt Specialization for Dip Signals
**Date:** 2026-02-25 | **Status:** Active

**Origin:** `docs/reports/2026-02-25-backtest-live-config-30d.md`
**Relates to:** [ADR-011](011-smart-dip-hunter-strategy.md) (Smart Dip Hunter), [ADR-005](005-grok-ai-validation-fail-closed.md) (Fail-closed AI)

## Context (Why)
Backtest with live config showed 73% win rate and +5.4% monthly return for dip/value patterns. But live trading had 29% win rate and -$3.72 total. Investigation of validation_history (3,486 records) revealed the root cause:

- Grok AI **rejected 88% of dip/value signals** (1,472/1,673)
- Top rejection reason: "conflicts with bearish higher-timeframe trend" (hundreds of times)
- Dip buying IS buying against the short-term trend — the AI prompt was fundamentally misaligned with the strategy
- Average AI confidence for rejected dip signals: 30.9%
- With 60/40 TA/AI blending, even an 80% TA signal drops to 60.4% — below the 70% threshold
- Meanwhile, trend-following signals (MACD/EMA cross) had 78% AI approval rate — but those signals have 0% live win rate

## Decision (What)
Split the Grok system prompt into three specialized modes based on signal type:

1. **Deep Value Crash** (unchanged) — "crash-buying specialist", evaluates panic vs falling knife
2. **Dip Buy / Bollinger Squeeze** (NEW) — "mean-reversion specialist"
   - Explicitly tells Grok: bearish HTF is expected context, not a rejection reason
   - Focus: is price near support? RSI oversold? Bad news on X?
   - REJECT only for: hack/exploit/delisting, rug pull velocity, fundamentally broken coin
3. **Trend-following** (adjusted) — standard risk analyst
   - HTF trend check applies only here (where it makes sense)
   - Clarified: "For trend-following signals: reject if HTF bearish or ADX < 25"

Signal classification in code:
```typescript
const isDeepValue = signal.is_deep_value || signal.patterns?.includes('DEEP_VALUE_CRASH');
const isDipBuy = signal.patterns?.includes('DIP_BUY') || signal.patterns?.includes('BOLLINGER_SQUEEZE');
```

## Consequences (How)
- Expected: dip signal approval rate rises from 12% to 50-70%
- Grok still provides value: X search for hacks/exploits, rug pull detection, news catalysts
- Risk: if approval rate goes too high (>80%), Grok is rubber-stamping — may need prompt tuning
- No change to fail-closed behavior (ADR-005): AI errors still reject signals
- No change to confidence blending weights (60% TA / 40% AI)
- Measure after 7 days: compare dip approval rate, trade count, win rate
