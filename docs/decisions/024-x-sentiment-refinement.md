# ADR-024: X Sentiment Refinement — From Defensive to Active
**Date:** 2026-02-25 | **Status:** Active

**Origin:** `docs/plans/2026-02-25-x-sentiment-and-trend-pass.md`

## Context (Why)
X sentiment was underused after Smart Dip Hunter deployment. Two problems:
1. **Misaligned watchlist** — scanner watched 13 coins (including BNB, DOGE, OP that we don't trade) while missing 4 traded symbols (DOT, ATOM, INJ, UNI, RENDER)
2. **Defensive-only usage** — sentiment only rejected signals on hack/exploit alerts. No positive confidence boost for bullish X buzz, wasting valuable signal data

## Decision (What)
- **Sync watchlist** to match the 15 traded symbols exactly
- **Force Grok X search** (`mode: 'on'` instead of `'auto'`) for every signal
- **Add positive sentiment boosts** (configurable in `[sentiment]` section):
  - X score >= 3 (Strong Bullish): +8% confidence
  - X score >= 2 (Bullish): +5% confidence
  - X score <= -2 (Bearish): -5% penalty
- **Enrich AI context** — pass X narrative ("People discussing breakout...") to Grok prompt, not just the score label
- **Store richer data** — new Redis key `sentiment:context:{SYMBOL}` with score + volume + narrative

## Consequences (How)
- DIP_BUY + bullish X buzz now gets extra +5-8% boost → more likely to pass confidence threshold
- Dip during hack/exploit gets double protection: alert keyword block + bearish penalty
- Max boost is +8%, not enough to override a fundamentally weak signal (sub-60% base confidence)
- All boosts configurable via cryonix.toml, revertible by setting values to 0
- Grok AI still runs its own live search — narrative is supplementary, not authoritative
