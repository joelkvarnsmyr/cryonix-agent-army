# CoinglassScout Integration Design

**Date:** 2026-03-10
**Status:** Approved

## Overview

Integrate Coinglass derivatives market data (funding rates, open interest, long/short ratio) as a confidence-adjustment layer in the Cryonix auto-trade pipeline. Follows the same pattern as CMCScout — a Python tank that polls data, writes to Redis, and is consumed by the auto-trade route.

## Architecture

### New Python Tank: `CoinglassScout`

File: `packages/engine/src/tanks/coinglass_scout.py`

Polls every 10 minutes. Two modes:

1. **Coinglass API mode** (when `enabled = true` + `COINGLASS_API_KEY` set): fetches all three data types from Coinglass Open API v1.
2. **CCXT fallback mode** (default): fetches funding rates + open interest via Binance futures through the already-integrated CCXT library. Long/short ratio block is silently skipped.

**Coinglass API endpoints:**

| Data | Endpoint |
|------|----------|
| Funding rates | `GET /api/pro/v1/futures/funding-rate` |
| Long/Short ratio | `GET /api/pro/v1/futures/global-long-short-account-ratio` |
| Open interest | `GET /api/pro/v1/futures/openInterest` |

Header: `coinglassSecret: <COINGLASS_API_KEY>`

Symbol mapping: USDC spot pairs (e.g. `BTC/USDC`) → Binance futures format (`BTCUSDT`).

### Redis Keys (TTL: 20 min)

```
coinglass:funding:{SYMBOL}  →  { rate, annualized_rate, next_funding_time }
coinglass:oi:{SYMBOL}       →  { oi_usd, oi_change_24h_pct, timestamp }
coinglass:ls:{SYMBOL}       →  { long_ratio, short_ratio, timestamp }
```

### Engine Registration

`packages/engine/src/main.py` — add CoinglassScout to tank list alongside CMCScout.

## Confidence Adjustments (auto-trade route)

New block inserted after the CMC block (Step 3d). Reads from Redis. All adjustments are additive boosts/penalties on `signal.confidence`, capped at 0.95.

### Funding Rate

| Condition | Adjustment | Rationale |
|-----------|-----------|-----------|
| rate < -0.05% | +8% on BUY | Shorts paying longs → squeeze potential |
| rate < -0.02% | +4% on BUY | Market bearish-positioned |
| rate > +0.10% | -8% on all BUY | Longs crowded → dump risk |
| rate > +0.05% | -4% on all BUY | Bullish consensus = elevated risk |

### Open Interest (24h change)

| Condition | Adjustment | Rationale |
|-----------|-----------|-----------|
| OI +10%+ and price rising | +5% | New capital entering = strong trend |
| OI -10%+ (deleveraging) | +4% on DIP_BUY/DEEP_VALUE_CRASH | Capitulation = potential bottom |
| OI -10%+ and price falling | -5% | Panic exit, not a dip |

### Long/Short Ratio (Coinglass API only)

| Condition | Adjustment | Rationale |
|-----------|-----------|-----------|
| L/S ratio < 0.8 | +6% | Shorts dominant → squeeze setup |
| L/S ratio > 2.5 | -6% | Crowded long trade |

## Configuration (`cryonix.toml`)

```toml
[coinglass]
enabled = false                             # set true when COINGLASS_API_KEY is active
poll_interval_seconds = 600

# Funding rate thresholds
funding_extreme_negative_threshold = -0.0005   # -0.05%
funding_negative_threshold = -0.0002           # -0.02%
funding_extreme_positive_threshold = 0.001     # +0.10%
funding_positive_threshold = 0.0005            # +0.05%

# Funding rate adjustments
funding_squeeze_boost = 0.08
funding_bearish_boost = 0.04
funding_crowded_penalty = 0.08
funding_positive_penalty = 0.04

# Open interest thresholds
oi_surge_threshold = 0.10                      # 10% OI change

# Open interest adjustments
oi_trend_boost = 0.05
oi_capitulation_boost = 0.04
oi_panic_penalty = 0.05

# Long/short ratio thresholds (Coinglass API only)
ls_short_squeeze_threshold = 0.8
ls_crowded_long_threshold = 2.5

# Long/short adjustments
ls_squeeze_boost = 0.06
ls_crowded_penalty = 0.06
```

## Files Changed

| File | Change |
|------|--------|
| `packages/engine/src/tanks/coinglass_scout.py` | New file |
| `packages/engine/src/main.py` | Register CoinglassScout |
| `apps/web/src/app/api/auto-trade/route.ts` | New Coinglass block (Step 3d) |
| `cryonix.toml` | New `[coinglass]` section |
| `docker-compose.prod.yml` | `COINGLASS_API_KEY` env var on engine container |

## Environment Variables

```
COINGLASS_API_KEY=<key>   # in ~/cryonix/.env on VM (engine container)
```

## Activation (when ready)

1. Set `COINGLASS_API_KEY` in `.env`
2. Set `[coinglass] enabled = true` in `cryonix.toml`
3. Redeploy engine container: `docker compose -f docker-compose.prod.yml up -d --build engine`

## Data Flow

```
CoinglassScout (Python, every 10 min)
  → Coinglass API (if enabled) OR CCXT Binance futures (fallback)
  → Redis: coinglass:funding:{SYMBOL}, coinglass:oi:{SYMBOL}, coinglass:ls:{SYMBOL}

Auto-Trade Route (every 30s)
  → Step 3d: Read Coinglass Redis keys
  → Apply funding rate boost/penalty
  → Apply OI change boost/penalty
  → Apply L/S ratio boost/penalty (if Coinglass API active)
  → Continue to GROK AI validation
```

## Phase 2: Polymarket

After CoinglassScout is stable, integrate Polymarket prediction market data as an additional signal source. Separate design doc to follow.
