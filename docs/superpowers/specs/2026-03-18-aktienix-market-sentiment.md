# Aktienix Market Sentiment Scanner — Design Spec

**Date:** 2026-03-18
**Status:** Approved

---

## Goal

Add 3 alternative data sources (CNN Fear & Greed, CBOE Put/Call Ratio, Finnhub Insider Trading) to Aktienix's signal evaluation pipeline. These provide non-TA alpha signals with low correlation to existing technical factors.

## Architecture

New class `MarketSentimentScanner` in `packages/agents/src/aktienix/intelligence/market-sentiment.ts`. Initialized in the trading loop alongside `MacroIntelligence`. Fetches data on schedule, caches in Redis, and provides a `getConfidenceAdjustment(symbol)` method consumed by `evaluateSignal()`.

No new containers. All fetching happens inside the existing trading loop — pre-market for Fear & Greed / Put-Call, signal scan for insider data.

## Data Sources

### 1. CNN Fear & Greed Index

- **API:** `https://production.dataviz.cnn.io/index/fearandgreed/graphdata/{date}`
- **Auth:** None
- **Poll:** Every 30 minutes
- **Redis:** `aktienix:feargreed` (TTL 1h)
- **Signal:**
  - Score < 25 (extreme fear): +8% confidence boost (contrarian buy)
  - Score 25-75: no adjustment
  - Score > 75 (extreme greed): -8% confidence penalty (market overheated)

### 2. CBOE Put/Call Ratio

- **API:** `https://cdn.cboe.com/resources/options/volume_and_call_put_ratios/indexpcarchive.csv`
- **Auth:** None
- **Poll:** Once daily (data updates after market close)
- **Redis:** `aktienix:putcall` (TTL 24h)
- **Signal:**
  - P/C > 1.2: +6% confidence boost (extreme hedging = contrarian buy)
  - P/C 0.7-1.2: no adjustment
  - P/C < 0.7: -6% confidence penalty (complacency = risk)

### 3. Finnhub Insider Trading (SEC Form 4)

- **API:** `https://finnhub.io/api/v1/stock/insider-transactions?symbol={symbol}&token={key}`
- **Auth:** FINNHUB_API_KEY (free tier, 60 calls/min)
- **Poll:** Every 6 hours per symbol (21 symbols = 21 calls per cycle)
- **Redis:** `aktienix:insider:{symbol}` (TTL 12h)
- **Signal:**
  - 2+ insider buys within 30 days: +10% confidence boost
  - 3+ insider sells within 30 days: -5% confidence penalty
  - Insufficient data or no key: 0% adjustment
- **Graceful degradation:** If FINNHUB_API_KEY is not set, insider scanning is skipped entirely. No error, no log spam.

## Confidence Cap

All intelligence overlays are summed but capped at ±20% total:

```
totalOverlay = grokBoost + polymarketBoost + sentimentBoost
cappedOverlay = Math.max(-0.20, Math.min(0.20, totalOverlay))
confidence += cappedOverlay
```

This prevents boost-stacking from creating false certainty. Example:
- Grok oil bullish: +15%
- Polymarket oil: +6%
- Fear & Greed extreme fear: +8%
- Raw total: +29% → **capped to +20%**

## Implementation

### New File: `packages/agents/src/aktienix/intelligence/market-sentiment.ts`

```typescript
export class MarketSentimentScanner {
    constructor(redisPublisher: StatePublisher, finnhubKey?: string)

    // Fetch + cache methods (called from trading loop)
    async fetchFearGreed(): Promise<void>        // → Redis aktienix:feargreed
    async fetchPutCallRatio(): Promise<void>     // → Redis aktienix:putcall
    async fetchInsiderActivity(symbols: string[]): Promise<void>  // → Redis aktienix:insider:{sym}

    // Read from cache + compute adjustment (called from evaluateSignal)
    async getConfidenceAdjustment(symbol: string): Promise<{
        adjustment: number;          // -0.10 to +0.10
        reasons: string[];           // human-readable explanations
        fearGreed?: number;          // current F&G score
        putCallRatio?: number;       // current P/C ratio
        insiderNetBuys?: number;     // insider buys - sells in 30d
    }>
}
```

### Modified: `packages/agents/src/aktienix/aktienix-agent.ts`

1. **Initialization:** Create `MarketSentimentScanner` after `MacroIntelligence` init
2. **Pre-market loop:** Call `fetchFearGreed()` + `fetchPutCallRatio()` on schedule
3. **Signal scan:** Call `fetchInsiderActivity(watchlist)` on scan interval
4. **evaluateSignal():** After Polymarket overlays, before min_confidence check:
   - Call `getConfidenceAdjustment(symbol)`
   - Sum all overlays (Grok + Polymarket + Sentiment)
   - Cap at ±20%
   - Log adjustment

### Modified: `aktienix.toml`

```toml
[sentiment]
enabled = true
fear_greed_boost = 0.08        # confidence adjustment at extreme fear (<25)
fear_greed_penalty = 0.08      # confidence adjustment at extreme greed (>75)
putcall_boost = 0.06           # confidence adjustment at high P/C (>1.2)
putcall_penalty = 0.06         # confidence adjustment at low P/C (<0.7)
insider_boost = 0.10           # confidence adjustment for insider cluster buys
insider_penalty = 0.05         # confidence adjustment for insider cluster sells
max_total_overlay = 0.20       # cap on total intelligence overlay (Grok + Poly + Sentiment)
```

### Modified: `docker-compose.prod.yml`

Add `FINNHUB_API_KEY` to aktienix container environment (optional, graceful skip if absent).

## Error Handling

- All API fetches wrapped in try/catch with 5s timeout
- On failure: log warning, return 0% adjustment, use cached data if available
- Never block trading due to sentiment API failure
- CNN/CBOE: no auth = no failure mode beyond network issues
- Finnhub: graceful skip if no API key

## Files Changed

| File | Change |
|------|--------|
| `packages/agents/src/aktienix/intelligence/market-sentiment.ts` | NEW — scanner class |
| `packages/agents/src/aktienix/aktienix-agent.ts` | Init scanner, fetch in loops, apply in evaluateSignal |
| `aktienix.toml` | Add [sentiment] config section |
| `docker-compose.prod.yml` | Add FINNHUB_API_KEY env var to aktienix |
