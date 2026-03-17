# Polynix Pivot: 5-min Micro-Markets → Real Polymarket Markets

**Date:** 2026-03-15 → 2026-03-17
**Status:** Deployed, running in paper mode

## Problem

Polynix was designed for 5-minute crypto binary micro-markets on Polymarket. After deployment, it found **0 markets** every scan — Polymarket has no short-duration crypto binary markets. All markets are days to months long.

## Solution

Pivoted the entire scanner to work with real available markets:

### Market Scanner (dual mode)
1. **Crypto markets** — Scans all crypto-related events (BTC price targets, ETH milestones) for directional trading
2. **All high-liquidity markets** — Scans top 80 markets by liquidity for YES+NO spread arbitrage

### Spread Detector
- Switched from CLOB `/book` endpoint (thin limit orders, 0.01/0.99 spreads) to `/price` endpoint (AMM-inclusive, real execution prices)
- Arb threshold: combined cost < 0.96 after 3.1% round-trip fees

### Directional Engine
- **Price target extraction:** Parses questions like "Will BTC be above $80K by June?" into `{target: 80000, direction: 'above'}`
- **Fair probability estimation:** Uses current price distance + crypto volatility (2%/day) + time to expiry via normal CDF approximation
- **Edge detection:** When Polymarket probability diverges from fair value by >2%

### Position Sizing
- Arb bets: $25 max (risk-free)
- Directional: edge-proportional, $6.25 at max edge
- Kelly formula replaced with linear scaling (Kelly degenerates for binary markets)
- 20 max concurrent positions, 50% max exposure

## Config Changes (polynix.toml)

| Parameter | Before | After |
|-----------|--------|-------|
| `min_time_to_expiry_s` | 60 (1 min) | 3600 (1 hour) |
| `max_time_to_expiry_s` | 240 (4 min) | 7,776,000 (90 days) |
| `scan_interval_ms` | 5,000 (5s) | 60,000 (60s) |
| `max_bet_size_usd` | 10 | 25 |
| `max_concurrent_positions` | 5 | 20 |
| `scan_all_for_arb` | N/A | true |
| `min_liquidity_usd` | N/A | 500 |

## Results (first scan)

- 53 crypto markets found
- 75 markets scanned for arb
- 7 arb trades executed (3-37% net edge)
- 13 directional trades (BTC/ETH price target markets)
- Balance: $437.75 → $267 (capital deployed in positions)

## Key Bugs Fixed

1. **Gamma API outcomes is JSON string** — `'["Yes","No"]'` not array, string.length = 16 not 2
2. **Kelly formula → 0 for arb bets** — Replaced with max bet for risk-free arbs
3. **Kelly → 0 for directional** — Replaced with edge-proportional sizing

## Files

- `packages/agents/src/polynix/` — All 10 modules rewritten
- `polynix.toml` — Config updated
- `Dockerfile.polynix` — Added `pg` dependency
