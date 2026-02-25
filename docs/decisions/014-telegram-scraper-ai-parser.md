# ADR-014: Telegram Scraper — AI Parser + Channel Upgrade
**Date:** 2026-02-25 | **Status:** Active

## Context (Why)
The Telegram scraper had been running for weeks but captured 0 signals. Investigation revealed three root causes:
1. Channels posted free-text analysis (`$ETH breakout, looks bullish`), not structured signals
2. Cornix parser had a bug -- matched "BUY" as the symbol instead of the actual ticker
3. Two of three channels were inactive or VIP-promo-only

## Decision (What)
- Add a **sentiment parser** (regex) for `$SYMBOL` + bullish/bearish keyword detection
- Add a **Grok AI fallback parser** for messages no regex can handle (rate-limited: 10s/channel)
- Fix Cornix parser symbol detection (skip action keywords like BUY/SELL)
- Fix `_extract_price` to use text after colon (was matching "1" from "TP1:" instead of the price)
- Replace dead channels with active ones: BinanceKillers, WolfOfTrading, WallStreetQueenOfficial, EveningTrader
- Auto-join channels at startup (Telethon requires membership for real-time events)

## Consequences (How)
- Parser chain: Cornix -> Simple -> Sentiment -> AI (Grok) -> Emoji
- AI parser costs ~0.001 XAI credits per call, rate-limited to prevent abuse
- Confidence boost still DISABLED (log only) -- enable when channel quality is proven
- 5 channels monitored instead of 3
- Signals saved to Postgres `telegram_signals` + Redis `telegram:signal:{SYMBOL}`
