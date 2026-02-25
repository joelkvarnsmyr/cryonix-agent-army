# X Sentiment Refinement & Trending Exception — Design & Implementation

**Date:** 2026-02-25
**Status:** Implemented & Live
**Author:** Joel + Claude Opus 4.6
**Builds on:** [Smart Dip Hunter Strategy](./2026-02-25-smart-dip-hunter-strategy.md)

## Problem

Two issues identified after deploying Smart Dip Hunter:

1. **X sentiment data was misaligned and underused** — the scanner watched 13 coins (BTC, ETH, SOL, BNB, XRP, DOGE, ADA, AVAX, LINK, NEAR, SUI, ARB, OP) while we traded 15 different ones (missing DOT, ATOM, INJ, UNI, RENDER). Sentiment was only used defensively (reject on hack alerts) — no positive confidence boost for bullish X buzz.

2. **Idle capital in bull markets** — Dip Focus Mode blocks all trend signals (MACD/EMA cross), which means the system does nothing when the market trends upward. With $40 capital sitting idle for days, this is a significant opportunity cost.

## Decision 1: Refine X Sentiment Pipeline

### What changed

| Component | Before | After |
|-----------|--------|-------|
| Watchlist | 13 coins (BNB, DOGE, OP — not traded) | 15 coins (matches trading whitelist exactly) |
| Grok search mode | `'auto'` (sometimes skips X search) | `'on'` (always searches X for every signal) |
| Sentiment usage | Defensive only (reject on alerts) | Defensive + positive boost + penalty |
| AI prompt context | Score label only ("Bullish") | Score + narrative ("X buzz: People discussing...") |
| Redis storage | `sentiment:{SYMBOL}` (score only) | + `sentiment:context:{SYMBOL}` (score + volume + narrative) |

### Confidence adjustments (after TA+AI blending)

| X Score | Label | Adjustment | Configurable via |
|---------|-------|------------|-----------------|
| ≥ 3 | Strong Bullish | +8% confidence | `[sentiment] strong_bullish_boost` |
| ≥ 2 | Bullish | +5% confidence | `[sentiment] bullish_boost` |
| ≤ -2 | Bearish | -5% confidence | `[sentiment] bearish_penalty` |
| -1 to +1 | Neutral | No change | — |

### Why this matters for Smart Dip Hunter

A DIP_BUY signal with bullish X sentiment (score ≥ 2) now gets an extra +5% confidence boost, making it more likely to pass the min_confidence threshold. Conversely, a dip during a hack/exploit event gets both the alert keyword block AND the bearish penalty — double protection against falling knives.

### Files changed

- `scripts/strategy-lab/x_sentiment.py` — Watchlist synced + `sentiment:context:{SYMBOL}` storage
- `apps/web/src/app/api/auto-trade/route.ts` — Search `'on'`, narrative in prompt, confidence adjustment
- `apps/web/src/lib/config.ts` — TypeScript type for new sentiment fields
- `cryonix.toml` — `[sentiment]` section: `bullish_boost`, `strong_bullish_boost`, `bearish_penalty`

## Decision 2: Trending Exception (ADX > 30)

### The problem with pure dip focus

Smart Dip Hunter works well when dips occur, but crypto markets are bullish ~60% of the time. During sustained uptrends:
- No DIP_BUY signals fire (price going up, not down)
- No DEEP_VALUE_CRASH signals (no crashes)
- Capital sits idle earning nothing

### Why not just disable dip focus?

MACD+EMA signals had **0% win rate** in our calibration data. But that was across all market conditions — including ranging/choppy markets where trend-following fails. In a strong trend (ADX > 30 with HTF confirmation), trend signals are expected to perform much better.

### The solution: conditional trend pass

The dip focus filter now has an exception:

```
Signal → Dip Focus Filter:
  ├─ Has DIP_BUY / DEEP_VALUE / BOLLINGER_SQUEEZE → ✅ Pass (as before)
  └─ No value pattern?
       ├─ MACD/EMA cross + ADX ≥ 30 + HTF bullish → ✅ Pass (NEW)
       └─ Otherwise                                → ❌ Rejected
```

**Safety nets still apply:** Trend signals that pass the dip focus filter still go through:
- EV Model filter (rejects negative historical edge)
- Grok AI validation (with live X search)
- Min confidence threshold (70%)
- X sentiment boost/penalty
- Capital budget check

### Configuration

```toml
[patterns]
trending_adx_threshold = 30  # Min ADX to allow trend signals through dip focus
```

### How to monitor

In auto-trader logs, look for:
- `[TREND-PASS] SOL/USDC: trend signal allowed (ADX=35, HTF=bullish, patterns=MACD_BULLISH_CROSS+EMA_BULLISH_CROSS)` — trend signal passed
- `Dip focus: no value pattern (has: MACD_BULLISH_CROSS, ADX=18)` — trend signal rejected (weak trend)

### Files changed

- `apps/web/src/app/api/auto-trade/route.ts` — Trending exception in dip focus filter
- `apps/web/src/lib/config.ts` — `trending_adx_threshold` in patterns type
- `cryonix.toml` — `[patterns] trending_adx_threshold = 30`

## Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Trend signals lose money (as before) | ADX > 30 + HTF aligned = strong trend filter; Grok AI + EV model still validate |
| Too many trend trades dilute capital | Max 3 positions shared across all strategies |
| X sentiment boost pushes bad signals through | Max boost is +8%, not enough to override a sub-60% base confidence |
| X narrative misleads Grok AI | Grok has its own live search; narrative is supplementary context |

## How to Revert

**X Sentiment boosts:** Set all boost values to 0 in `cryonix.toml`:
```toml
[sentiment]
bullish_boost = 0
strong_bullish_boost = 0
bearish_penalty = 0
```

**Trending exception:** Set threshold impossibly high:
```toml
[patterns]
trending_adx_threshold = 100  # Effectively disables trend pass
```

Restart: `docker compose -f docker-compose.prod.yml restart web auto-trader`

## Future: Full Regime-Adaptive Strategy (Step 2)

If trending trades show positive edge after 20+ trades, expand to full regime-adaptive mode:
- **Trending regime** (ADX > 25): Allow all momentum patterns
- **Dipping regime** (F&G < 30): Smart Dip Hunter
- **Ranging regime**: BOLLINGER_SQUEEZE + tight grid
- **Volatile regime**: Smaller positions, wider stops

This would replace the static `dip_focus_mode` toggle with a dynamic `strategy_mode = "auto"`.
