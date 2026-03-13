# Implementation Plan: Intelligent Trading Engine

**Spec:** `docs/superpowers/specs/2026-03-13-intelligent-trading-engine-design.md`
**Date:** 2026-03-13

## Overview

Three phases, each independently deployable. Tasks sized for subagent execution (~1-2 files each).

## PHASE 1: Alert System Redesign

**Goal:** 4-tier severity with confirmation counter. Stops false SL tightening from whale moves.

### Task 1.1: Update Grok prompt + alert writer (x_sentiment.py)

**File:** `scripts/strategy-lab/x_sentiment.py`

1. Add `SEVERITY_TTLS = {'info': 1800, 'warning': 7200, 'critical': 21600, 'emergency': 43200}`
2. Replace section 5 in `build_user_prompt()` with new classification rules (spec)
3. Update `write_to_redis()` — confirmation counter logic:
   - Same severity → increment `confirmed_count`, refresh TTL
   - Higher severity → replace, reset `confirmed_count` to 1
   - Lower severity → keep existing
4. Use severity-specific TTL instead of flat `ONCHAIN_ALERT_TTL`
5. `timing_uncertain: true` → cap at `info`
6. Update `print_summary()` for new fields

### Task 1.2: Update BUY filter alert consumer (auto-trade route)

**File:** `apps/web/src/app/api/auto-trade/route.ts` (~line 1473-1488)

1. Replace keyword-matching with severity-based filtering per spec
2. `timing_uncertain` freshness guard
3. Backward compat: plain string alerts → `warning` with `confirmed_count: 1`

### Task 1.3: Update position monitor alert consumer (auto-trade route)

**File:** `apps/web/src/app/api/auto-trade/route.ts` (~line 823-866)

1. Parse new alert format
2. Replace binary logic with spec consumer rules
3. Emergency force-close: cancel native SL → market sell → `SOLD_EMERGENCY`

### Task 1.4: Update grid filter (auto-trade route)

**File:** `apps/web/src/app/api/auto-trade/route.ts` (~line 2220-2228)

1. Only block grid buys on `critical`/`emergency` (was: any alert)

### Task 1.5: Add alert config to cryonix.toml

**File:** `cryonix.toml` — add `[alerts]` section

### Deploy Phase 1

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build web auto-trader"
```

x_sentiment.py runs via cron — no container restart needed.

---

## PHASE 2: Trade Classification (Moonshot Detection)

**Goal:** Score signals 0-100, classify as scalp/standard/moonshot. Informational until Phase 3.

### Task 2.1: Add moonshot scoring to QuantGuild

**File:** `packages/engine/src/guilds/quant.py`

1. New method `_compute_moonshot_score(df, indicators, patterns)`:
   - Volume > 2x avg: +30 (existing `volume_ratio`)
   - BOLLINGER_SQUEEZE: +20
   - ATR expanding (>1.5x ATR 20 periods ago): +15
   - RSI 50-65: +10
   - Multi-TF alignment: +25 (skip if HTF data unavailable, cap at 75)
2. New method `_classify_trade_type(score)` → scalp/standard/moonshot
3. Add `moonshot_score` and `trade_type` to signal dict in `_generate_signal()`

### Task 2.2: Add moonshot score to signal payload (MarketScoutTank)

**File:** `packages/engine/src/tanks/market_scout.py` (~line 156-188)

1. Extract `moonshot_score` and `trade_type` from signal, include in Redis payload

### Task 2.3: Read moonshot score in auto-trade route

**File:** `apps/web/src/app/api/auto-trade/route.ts`

1. Extend `Signal` interface with `moonshot_score`, `trade_type`
2. Pattern-based fallback if missing:
   - DIP_BUY → scalp (20), DEEP_VALUE_CRASH → standard (50), BOLLINGER_SQUEEZE → standard (50)
   - BOLLINGER_SQUEEZE + VOLUME_SPIKE → moonshot (70)
3. Store in position metadata

### Task 2.4: Add moonshot config to cryonix.toml

**File:** `cryonix.toml` — add `[moonshot]` section

### Deploy Phase 2

```bash
docker compose -f docker-compose.prod.yml up -d --build engine web auto-trader
```

---

## PHASE 3: Tiered Exit Engine

**Goal:** T1/T2/T3 partial exits with ratcheting trail. Requires Phase 2.

### Task 3.1: Add ExitPlan type and creation logic

**File:** `apps/web/src/app/api/auto-trade/route.ts`

1. Add `ExitPlan` interface (from spec)
2. Extend `OpenPosition` with `exitPlan?: ExitPlan`
3. Function `createExitPlan(signal, executedPrice, executedQty, atr)`:
   - Trade type → ATR multipliers → T1/T2 prices
   - Min split check: if too small, single TP at T2
   - Returns ExitPlan
4. Function `createDefaultExitPlan(pos)` for migrating existing positions

### Task 3.2: Wire ExitPlan into BUY execution

**File:** `apps/web/src/app/api/auto-trade/route.ts` (~line 1920-1968)

1. After market fill, read ATR from `signal.indicators.atr`
2. Call `createExitPlan()`, store in position
3. Keep `takeProfit`/`stopLoss` for backward compat

### Task 3.3: Implement tiered exit monitoring (LARGEST TASK)

**File:** `apps/web/src/app/api/auto-trade/route.ts` (~line 587-1019)

1. If no `exitPlan` → call `createDefaultExitPlan(pos)`
2. Skip tiered exits for `isGridPosition`
3. **T1 check:** currentPrice ≥ t1Price → partial sell → SL to breakeven → Telegram
4. **T2 check:** currentPrice ≥ t2Price → partial sell → activate trail → Telegram
5. **Ratcheting trail (T3):** profit-band-based trail multiplier, stale tightening, native SL updates
6. **Stagnation:** per-type timeout (4h/16h/48h), Grok override takes precedence
7. Keep existing SL/TP/trailing as fallbacks when tiered exits disabled

### Task 3.4: Extract native SL helper

**File:** `apps/web/src/app/api/auto-trade/route.ts`

1. `replaceNativeSl(pos, newQty, newStopPrice)` — cancel old, place new
2. Used by T1, T2, and trail updates (currently duplicated in ~4 places)

### Task 3.5: Add tiered exit config to cryonix.toml

**File:** `cryonix.toml` — extend `[exits]` with all tiered config from spec

### Task 3.6: Telegram notifications for partial exits

**File:** `apps/web/src/app/api/auto-trade/route.ts`

1. T1/T2/T3/stagnation/emergency message templates per spec

### Deploy Phase 3

```bash
# Deploy with feature flag OFF first
# Set tiered_exits_enabled = false in cryonix.toml
docker compose -f docker-compose.prod.yml up -d --build web auto-trader
# Verify exitPlan creation in logs
# Enable: set tiered_exits_enabled = true, restart
docker compose -f docker-compose.prod.yml restart web auto-trader
```

---

## Task Dependency Graph

```
Phase 1:                    Phase 2:                    Phase 3:
1.5 (config)                2.4 (config)                3.5 (config)
  ↓                           ↓                           ↓
1.1 (x_sentiment) ──┐      2.1 (quant.py)              3.1 (types) ──┐
1.2 (BUY filter)  ──┤        ↓                          3.4 (SL helper)│
1.3 (monitor)     ──┤      2.2 (market_scout)             ↓           │
1.4 (grid filter) ──┘        ↓                          3.2 (BUY wire)│
                            2.3 (auto-trade)              ↓           │
                                                        3.3 (monitor) ┘
                                                        3.6 (telegram)
```

Phases 1 and 2 can run in parallel. Phase 3 depends on Phase 2.
