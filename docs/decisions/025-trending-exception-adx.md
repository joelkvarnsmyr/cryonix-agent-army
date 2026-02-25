# ADR-025: Trending Exception — Allow Trend Signals When ADX > 30
**Date:** 2026-02-25 | **Status:** Active

**Origin:** `docs/plans/2026-02-25-x-sentiment-and-trend-pass.md`
**Extends:** [ADR-011](011-smart-dip-hunter-strategy.md) (Smart Dip Hunter)

## Context (Why)
Smart Dip Hunter (ADR-011) blocked ALL trend signals (MACD+EMA cross) because they had 0% win rate historically. But that data included ranging/choppy markets where trend-following always fails. During strong uptrends (~60% of crypto market time), capital sat idle earning nothing — significant opportunity cost with $40 capital.

The question: can we allow trend signals selectively, only when there's evidence of a real trend?

## Decision (What)
Add a conditional exception to the dip focus filter:

```
Signal → Dip Focus Filter:
  ├─ Has DIP_BUY / DEEP_VALUE / BOLLINGER_SQUEEZE → Pass (unchanged)
  └─ No value pattern?
       ├─ MACD/EMA cross + ADX >= 30 + HTF bullish → Pass (NEW)
       └─ Otherwise → Rejected
```

- **ADX >= 30** indicates strong directional movement (not just noise)
- **HTF bullish** confirmation prevents counter-trend trades
- Configurable: `[patterns] trending_adx_threshold = 30`
- Revertible: set threshold to 100 to effectively disable

## Consequences (How)
- Capital no longer sits idle during bull markets
- Trend signals that pass still go through ALL remaining filters (EV model, Grok AI, min confidence, X sentiment, budget check)
- Risk: trend signals may still lose money, but ADX > 30 + HTF alignment is a much stronger filter than allowing all trends
- Future: if trending trades show positive edge after 20+ trades, expand to full regime-adaptive mode (`strategy_mode = "auto"`)
