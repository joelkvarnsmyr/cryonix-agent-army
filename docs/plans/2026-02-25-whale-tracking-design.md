# Whale Tracking Integration — Design Document

**Date:** 2026-02-25
**Status:** Planned (not implemented)
**Author:** Joel + Claude Opus 4.6
**Priority:** Next after validating Dip + Trend strategy
**Prerequisite:** Let current strategy run 1-2 weeks and measure results first

## Motivation

Our signal pipeline currently uses three data dimensions:
1. **Technical Analysis** (QuantGuild: price, volume, indicators)
2. **Social Sentiment** (Grok X search, x_sentiment.py)
3. **Macro Intelligence** (CMC: Fear & Greed, market cap, BTC dominance)

Missing dimension: **On-chain data / whale activity**. This is the #1 gap vs professional signal groups. When a whale moves $5M of LINK to a cold wallet (accumulation) right when our system detects a DIP_BUY — that's a 3-source confirmation that dramatically increases conviction.

## What Is Whale Tracking?

Monitoring large cryptocurrency transfers (typically >$100K) to detect:
- **Exchange inflows** (whale sends to Binance) → likely selling → bearish
- **Exchange outflows** (whale withdraws from Binance) → likely holding → bullish
- **Large accumulation** (whale buys on DEX or OTC) → bullish
- **Whale-to-whale transfers** (cold wallet reshuffling) → neutral

## Data Sources (All Free Tier)

### Primary: Whale Alert API
- **URL:** `https://api.whale-alert.io/v1/transactions`
- **Free tier:** 10 requests/minute, historical 3600s lookback
- **Returns:** Transaction hash, from/to (exchange/unknown/known), amount, USD value, symbol
- **Cost:** Free (10 req/min = 600/hr = enough for 15min polling)
- **Covers:** BTC, ETH, SOL, XRP, LINK, ADA, DOT, AVAX + 50 more

### Supplementary: Etherscan API (ERC-20 tokens)
- **URL:** `https://api.etherscan.io/api`
- **Free tier:** 5 requests/second, 100K/day
- **Use case:** Track specific whale wallets for ETH, LINK, UNI, ARB
- **Cost:** Free with API key
- **Limitation:** Only Ethereum chain

### Future: Solscan / BscScan / similar
- Same pattern as Etherscan but for SOL chain tokens
- Add when we expand beyond ERC-20

## Architecture

### New Component: WhaleScout

```
┌──────────────────────────────────────────────────┐
│  WhaleScout (Python, cron every 10 min)          │
│                                                  │
│  1. Poll Whale Alert API → large transactions    │
│  2. Classify: exchange_inflow / exchange_outflow │
│  3. Aggregate per symbol: net_flow, tx_count     │
│  4. Score: -3 (heavy selling) to +3 (heavy buy)  │
│  5. Write to Redis                               │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│  Redis Keys                                      │
│                                                  │
│  whale:{SYMBOL}           → score (-3 to +3)     │
│  whale:context:{SYMBOL}   → JSON (details)       │
│  whale:alert:{SYMBOL}     → "mega whale sell"    │
│  whale:latest             → full scan summary    │
└──────────────────┬───────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────┐
│  Auto-Trader (existing pipeline)                 │
│                                                  │
│  1. Risk gate: reject BUY if whale:alert active  │
│  2. Confidence boost: +5% if whale score >= 2    │
│  3. Confidence penalty: -5% if whale score <= -2 │
│  4. Grok AI prompt: include whale context        │
└──────────────────────────────────────────────────┘
```

### Redis Key Schema

```
whale:{SYMBOL}              # Score -3 to +3 (TTL 1800s / 30min)
                            # +3 = heavy accumulation (outflows >> inflows)
                            # -3 = heavy distribution (inflows >> outflows)

whale:context:{SYMBOL}      # JSON (TTL 1800s)
  {
    "score": 2,
    "net_flow_usd": -5200000,    # negative = outflow from exchange (bullish)
    "inflow_usd": 1200000,       # sent TO exchanges
    "outflow_usd": 6400000,      # withdrawn FROM exchanges
    "tx_count": 7,
    "largest_tx_usd": 3100000,
    "narrative": "3 large outflows from Binance ($6.4M total), suggesting accumulation"
  }

whale:alert:{SYMBOL}        # String alert (TTL 1200s / 20min)
                            # "mega_sell: $12M moved to Binance"
                            # Used as hard reject in risk gate

whale:latest                # Full scan summary JSON (TTL 900s / 15min)
```

### Scoring Algorithm

```python
def score_whale_activity(inflow_usd: float, outflow_usd: float,
                         tx_count: int) -> int:
    """
    Score based on net exchange flow direction.
    Exchange inflow = selling pressure (bearish)
    Exchange outflow = accumulation (bullish)
    """
    net_flow = outflow_usd - inflow_usd  # positive = bullish

    # Thresholds (adjustable in cryonix.toml)
    if net_flow > 5_000_000:    return 3   # Mega accumulation
    if net_flow > 1_000_000:    return 2   # Strong accumulation
    if net_flow > 200_000:      return 1   # Mild accumulation
    if net_flow < -5_000_000:   return -3  # Mega distribution
    if net_flow < -1_000_000:   return -2  # Strong distribution
    if net_flow < -200_000:     return -1  # Mild distribution
    return 0                               # Neutral
```

### Alert Triggers (Hard Reject)

Generate `whale:alert:{SYMBOL}` when:
- Single transaction > $10M to an exchange (mega whale dump)
- 5+ exchange inflow transactions within 1 hour (coordinated selling)
- Known "smart money" wallet dumps entire position

## Integration Points in Auto-Trade

### 1. Risk Gate (hard reject)
```typescript
// After existing X sentiment alert check
const whaleAlert = await redis.get(`whale:alert:${baseAsset}`);
if (whaleAlert && signal.action === 'BUY') {
    return { pass: false, reason: `Whale alert: ${whaleAlert}` };
}
```

### 2. Confidence Adjustment (after TA+AI blending)
```typescript
// Same pattern as X sentiment boost
const whaleScore = parseInt(await redis.get(`whale:${baseAsset}`) || '0');
if (whaleScore >= 2) signal.confidence += whaleBoost;      // +5%
if (whaleScore <= -2) signal.confidence -= whalePenalty;    // -5%
```

### 3. Grok AI Context
```typescript
// Add to validation prompt alongside X sentiment
const whaleCtx = await redis.get(`whale:context:${baseAsset}`);
// "Whale activity: 3 large outflows from Binance ($6.4M), score +2 (accumulation)"
```

## Configuration (cryonix.toml)

```toml
[whale]
# Master switch
enabled = false              # Enable after adding WHALE_ALERT_API_KEY to .env

# Polling interval (seconds). 600 = 10min.
# Free tier: 10 req/min, we use ~2 req/poll (transactions + status)
poll_interval_seconds = 600

# Minimum transaction value (USD) to track
min_transaction_usd = 100000

# Lookback window per poll (seconds). Max 3600 for free tier.
lookback_seconds = 3600

# Confidence adjustments
accumulation_boost = 0.05        # +5% when whale score >= 2
strong_accumulation_boost = 0.08 # +8% when whale score >= 3
distribution_penalty = 0.05      # -5% when whale score <= -2

# Alert thresholds
mega_tx_alert_usd = 10000000    # Single tx > $10M triggers alert
coordinated_sell_count = 5       # N+ inflows in lookback = alert
```

## File Structure

```
scripts/strategy-lab/
  whale_tracker.py           # Main script (like x_sentiment.py)
                             # Cron: */10 * * * * (every 10 min)

packages/engine/src/tanks/   # Alternative: run as engine tank
  whale_scout.py             # If we want it in Docker (like CMCScout)
```

### Recommendation: Standalone script (like x_sentiment.py)
- Simpler deployment (just cron + host Python)
- Same pattern as x_sentiment.py (proven)
- No Docker rebuild needed
- Uses same `db.py` helper for Redis access

## API Cost Analysis

| Source | Free Tier | Our Usage | Monthly Cost |
|--------|-----------|-----------|-------------|
| Whale Alert | 10 req/min | ~2 req / 10min = 288/day | Free |
| Etherscan | 100K req/day | ~144/day (per known wallet) | Free |
| **Total** | | | **$0/month** |

## Symbol Coverage

Whale Alert covers all 15 symbols in our trading whitelist:
BTC, ETH, SOL, XRP, AVAX, LINK, ADA, DOT, NEAR, SUI, ATOM, INJ, ARB, UNI, RENDER

Etherscan covers ERC-20 subset: ETH, LINK, UNI, ARB (for specific wallet tracking).

## Example Signal Enhancement

**Scenario: LINK DIP_BUY signal**

Without whale tracking:
```
Signal: BUY LINK/USDC
Patterns: DIP_BUY + RSI_OVERSOLD
TA confidence: 72%
X sentiment: +1 (Positive)
→ Blended confidence: ~70% → Passes min_confidence
```

With whale tracking:
```
Signal: BUY LINK/USDC
Patterns: DIP_BUY + RSI_OVERSOLD
TA confidence: 72%
X sentiment: +1 (Positive)
Whale: score +2 (3 large outflows, $4.2M accumulation) → +5% boost
→ Blended confidence: ~75% → Stronger conviction
→ Grok sees: "Whale accumulation aligns with dip — likely smart money buying"
```

**Scenario: SOL falling knife**
```
Signal: BUY SOL/USDC
Patterns: DEEP_VALUE_CRASH
TA confidence: 68%
X sentiment: -2 (Bearish, hack rumors)
Whale: score -3 (mega sell: $12M to Binance) → ALERT
→ Hard reject at risk gate: "Whale alert: mega_sell $12M to Binance"
→ Saved from falling knife trade
```

## Risks

| Risk | Mitigation |
|------|-----------|
| Whale Alert API goes down | Graceful fallback (score = 0, no boost/penalty) |
| False signals (whale moves between own wallets) | Exchange-specific flow only (not wallet-to-wallet) |
| API rate limits | Conservative polling (10min interval, well within 10 req/min) |
| Whale data too delayed (already priced in) | 10min poll + 1hr lookback catches most moves in time for 15m candle signals |

## Implementation Steps (When Ready)

1. Get Whale Alert API key (free signup)
2. Write `whale_tracker.py` (same structure as `x_sentiment.py`)
3. Add `[whale]` section to `cryonix.toml`
4. Add whale confidence boost in `auto-trade/route.ts` (same pattern as sentiment)
5. Add whale context to Grok AI prompt
6. Set up cron: `*/10 * * * *`
7. Monitor for 1 week with `enabled = true` but boosts at 0 (log-only mode)
8. Enable boosts after validating data quality

## Dependencies

- Whale Alert API key (free, instant signup)
- `requests` Python package (already in engine requirements)
- No new Docker containers needed
- No database schema changes
