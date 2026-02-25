# ADR-009: CoinMarketCap Integration — Macro Intelligence
**Date:** 2026-02-17 | **Status:** Active

## Context (Why)
The system had zero macro market awareness. It would buy altcoins during market crashes, ignore BTC dominance shifts, and had no way to assess overall market sentiment. The existing signal pipeline was purely technical (RSI, MACD, Bollinger) with no fundamental data.

## Decision (What)
Integrate CoinMarketCap Free tier (10k credits/month) via new `CMCScout` tank:
- Fear & Greed index -> confidence adjustment (extreme fear: boost deep value, extreme greed: penalty)
- BTC dominance -> alt penalty when BTC dom is rising
- Market cap rank -> reject signals for coins ranked >500
- FDV/MC ratio -> reject overvalued tokens (>4x)
- Global market cap crash -> force volatile regime

## Consequences (How)
- ~5,500 credits/month usage (within free tier)
- Data cached in Redis with 20min TTL: `cmc:global`, `cmc:fear_greed`, `cmc:mcap:{SYMBOL}`
- Requires `CMC_API_KEY` env var + `coinmarketcap.enabled=true` in toml
- Five new risk checks in auto-trade route
