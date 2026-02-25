# Whale Tracking Integration — Design Document

**Date:** 2026-02-25 (revised)
**Status:** Planned (not implemented)
**Author:** Joel + Claude Opus 4.6
**Priority:** Next after validating Dip + Trend strategy
**Prerequisite:** Let current strategy run 1-2 weeks and measure results first
**Cost:** $0/month (all free tier sources)

## Motivation

Our signal pipeline currently uses three data dimensions:
1. **Technical Analysis** (QuantGuild: price, volume, indicators)
2. **Social Sentiment** (Grok X search, x_sentiment.py)
3. **Macro Intelligence** (CMC: Fear & Greed, market cap, BTC dominance)

Missing dimension: **On-chain data / whale activity**. This is the #1 gap vs professional signal groups. When a whale accumulates $5M of LINK right when our system detects a DIP_BUY — that's a 3-source confirmation that dramatically increases conviction.

## Free Data Sources (No Paid APIs)

### Tier 1 — Zero cost, uses existing infrastructure

| Source | Method | Covers | Cost |
|--------|--------|--------|------|
| **@whale_alert on X** | Grok search (already paid) | BTC, ETH, XRP, SOL + 50 more | $0 (existing) |
| **@whale_alert Telegram** | Our Telegram scraper (already running) | Same | $0 (existing) |

**Why this is the best starting point:**
- @whale_alert posts every >$500K-$1M+ transfer in real-time on both X and Telegram
- We already have Grok with `search: 'on'` scanning X every signal validation
- We already have `scripts/telegram-scraper/scraper.py` running in Docker
- Just add Whale Alert's Telegram channel to our scraper config → instant whale data

### Tier 2 — Free APIs, needs new code

| Source | Free Tier | Best For | API Key |
|--------|-----------|----------|---------|
| **Etherscan** | 5 req/s, 100K/day | ETH, LINK, UNI, ARB (ERC-20) | Free signup |
| **Arkham Intelligence** | Dashboard + basic API | Wallet labeling, entity tracking | Free signup |
| **DeBank** | Full free access | DeFi whale portfolios, token flows | No key needed |
| **Blockchair** | 1440 req/day | BTC, ETH, DOT, XRP, ADA (multi-chain) | Free |

### Tier 3 — Supplementary (future)

| Source | Use Case |
|--------|----------|
| **Cryptocurrency Alerting** | Free Telegram/Discord alerts for custom whale thresholds |
| **DexCheck** | DEX whale board (Uniswap/Raydium) for altcoin tracking |
| **Nansen** | Smart money tracking (free tier limited but useful) |

## Implementation Plan

### Phase 1: Grok X search enhancement (easiest, 30 min)

Modify `x_sentiment.py` prompt to explicitly ask about whale movements:

```python
SYSTEM_PROMPT = (
    'You are a crypto market analyst with access to real-time X/Twitter data. '
    'Analyze sentiment AND whale activity for the requested cryptocurrencies. '
    'Check @whale_alert posts for large transfers (>$1M). '
    'Distinguish between exchange inflows (bearish) and outflows (bullish).'
)

# Add to response format:
# "whale": {"direction": "accumulation"|"distribution"|"neutral",
#            "largest_tx": "$5.2M from Binance", "tx_count": 3}
```

New Redis keys:
```
whale:{SYMBOL}              → score -3 to +3 (same as sentiment)
whale:context:{SYMBOL}      → JSON with direction + details
```

**Pro:** Zero new infrastructure. Works immediately.
**Con:** Grok interprets tweets, may miss some or hallucinate. Not raw data.

### Phase 2: Telegram scraper for @whale_alert (medium, 2-3 hours)

Add Whale Alert's Telegram channel to our existing scraper:

```bash
# In .env on VM:
TELEGRAM_CHANNELS=channel1,channel2,whale_alert  # add whale_alert
```

Extend `parser.py` with a whale message parser:
```
"🐋 5,000,000 #USDT transferred from #Binance to unknown wallet"
→ { symbol: "USDT", amount: 5000000, direction: "outflow", exchange: "Binance" }
```

New Redis keys (from scraper):
```
whale:telegram:{SYMBOL}     → latest whale tx for symbol
whale:telegram:recent       → list of last 50 whale transactions
```

**Pro:** Real-time, raw data, no interpretation needed.
**Con:** Need to parse Whale Alert's message format. Only covers what they post.

### Phase 3: Etherscan API for ERC-20 (medium, 3-4 hours)

New standalone script `whale_tracker.py`:

```python
# Poll Etherscan for large transfers of tracked ERC-20 tokens
# Focus on transfers TO/FROM known exchange hot wallets
# Binance, Coinbase, Kraken hot wallet addresses are public

EXCHANGE_WALLETS = {
    'binance': ['0x28C6c06298d514Db089934071355E5743bf21d60', ...],
    'coinbase': ['0x71660c4005BA85c37ccec55d0C4493E66Fe775d3', ...],
}

# For each tracked token (LINK, UNI, ARB):
# GET /api?module=account&action=tokentx&address={wallet}&sort=desc
# Filter for value > $100K
# Classify: inflow (to exchange) or outflow (from exchange)
```

**Pro:** Raw on-chain data, most accurate.
**Con:** Only EVM chains. Need to maintain exchange wallet list.

### Phase 4: Arkham Intelligence integration (future)

Use Arkham's free dashboard/API for:
- **Entity resolution** — who owns which wallet (labeled addresses)
- **Smart money tracking** — follow known profitable wallets
- **Alert setup** — notify on specific wallet movements

## Architecture (All Phases Combined)

```
┌─────────────────────┐  ┌──────────────────────┐  ┌─────────────────┐
│ x_sentiment.py      │  │ telegram-scraper      │  │ whale_tracker.py│
│ (Grok @whale_alert) │  │ (@whale_alert channel)│  │ (Etherscan API) │
│ Phase 1             │  │ Phase 2               │  │ Phase 3         │
└────────┬────────────┘  └──────────┬────────────┘  └────────┬────────┘
         │                          │                         │
         ▼                          ▼                         ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Redis                                                               │
│                                                                      │
│  whale:{SYMBOL}           → score -3 to +3 (aggregated)              │
│  whale:context:{SYMBOL}   → JSON (best source wins)                  │
│  whale:alert:{SYMBOL}     → hard reject trigger                      │
│  whale:telegram:recent    → raw Telegram messages                    │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Auto-Trader (existing pipeline additions)                           │
│                                                                      │
│  1. Risk gate: reject BUY if whale:alert active (mega dump)          │
│  2. Confidence: +5% if whale score >= 2, -5% if <= -2                │
│  3. Grok AI prompt: include whale context + narrative                 │
└──────────────────────────────────────────────────────────────────────┘
```

## Scoring Algorithm

```python
def score_whale_activity(inflow_usd: float, outflow_usd: float) -> int:
    """
    Exchange inflow = selling pressure (bearish)
    Exchange outflow = accumulation (bullish)
    """
    net_flow = outflow_usd - inflow_usd  # positive = bullish

    if net_flow > 5_000_000:    return 3   # Mega accumulation
    if net_flow > 1_000_000:    return 2   # Strong accumulation
    if net_flow > 200_000:      return 1   # Mild accumulation
    if net_flow < -5_000_000:   return -3  # Mega distribution
    if net_flow < -1_000_000:   return -2  # Strong distribution
    if net_flow < -200_000:     return -1  # Mild distribution
    return 0                               # Neutral
```

## Configuration (cryonix.toml)

```toml
[whale]
enabled = false

# Confidence adjustments (same pattern as [sentiment])
accumulation_boost = 0.05        # +5% when whale score >= 2
strong_accumulation_boost = 0.08 # +8% when whale score >= 3
distribution_penalty = 0.05      # -5% when whale score <= -2

# Alert threshold — single tx that triggers hard BUY reject
mega_tx_alert_usd = 10000000    # $10M to exchange = alert
```

## Auto-Trade Integration (same pattern as X sentiment)

```typescript
// Risk gate (hard reject)
const whaleAlert = await redis.get(`whale:alert:${baseAsset}`);
if (whaleAlert && signal.action === 'BUY') {
    return { pass: false, reason: `Whale alert: ${whaleAlert}` };
}

// Confidence adjustment (after TA+AI blending)
const whaleScore = parseInt(await redis.get(`whale:${baseAsset}`) || '0');
const accumBoost = TOML?.whale?.accumulation_boost ?? 0.05;
if (whaleScore >= 2) signal.confidence += accumBoost;
if (whaleScore <= -2) signal.confidence -= distribPenalty;

// Grok prompt context
const whaleCtx = await redis.get(`whale:context:${baseAsset}`);
// → "Whale: 3 large outflows from Binance ($6.4M accumulation)"
```

## Example: Triple Confirmation

**LINK DIP_BUY + bullish X + whale accumulation:**
```
TA:        DIP_BUY + RSI_OVERSOLD → 72% confidence
X:         Score +2 (bullish buzz) → +5% boost → 77%
Whale:     Score +2 ($4.2M outflow from Binance) → +5% boost → 82%
Grok AI:   Sees all three sources aligned → high conviction approve
Result:    Strong buy signal with 3-source confirmation
```

**SOL falling knife — whale catches it:**
```
TA:        DEEP_VALUE_CRASH → 68% confidence
X:         Score -2 (hack rumors) → -5% penalty → 63%
Whale:     Score -3 ($12M TO Binance) → ALERT → hard reject
Result:    Saved from falling knife trade
```

## Cost Summary

| Phase | New API Keys | Monthly Cost |
|-------|-------------|-------------|
| Phase 1 (Grok search) | None | $0 |
| Phase 2 (Telegram scraper) | None | $0 |
| Phase 3 (Etherscan) | Free signup | $0 |
| Phase 4 (Arkham) | Free signup | $0 |
| **Total** | | **$0/month** |

## Implementation Order

1. **Phase 1 first** — modify x_sentiment.py prompt (30 min, zero risk)
2. Validate Phase 1 data quality for 1 week
3. **Phase 2** — add @whale_alert to Telegram scraper (2-3 hours)
4. **Phase 3** — Etherscan for precise ERC-20 tracking (3-4 hours)
5. Phase 4 — Arkham for entity resolution (future, if needed)
