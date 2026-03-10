# Multi-Target Take-Profit Design

**Date:** 2026-03-10
**Status:** Approved

## Overview

Replace the single take-profit exit with three staged TP levels (TP1, TP2, TP3) where 25% of the position is sold at each level, and the remaining 25% runs with the existing trailing stop. Applies to all positions — both internally generated signals and Telegram signals.

## Problem

Currently every position stores a single `takeProfit` price and exits 100% of the position when that price is reached. Telegram signal channels (CoinCodeCap, Cornix-based) provide TP1/TP2/TP3 levels — this data is already parsed and stored in `telegram_signals.tp1/tp2/tp3` but is not used during execution.

## Design

### Sell Split

| Level | Quantity sold | Trigger |
|-------|--------------|---------|
| TP1 | 25% of original | price >= tp1 |
| TP2 | 25% of original | price >= tp2 |
| TP3 | 25% of original | price >= tp3 |
| Trailing | 25% of original | existing trailing stop logic |
| Stop-Loss | remaining quantity | existing SL logic (full exit) |

### TP Level Calculation

**Internal signals and Telegram signals without multi-TP:**
```
tp3 = signal.target_price          (unchanged, ATR×12 or signal-provided)
tp2 = entry + (tp3 - entry) × 0.75
tp1 = entry + (tp3 - entry) × 0.50
```

**Telegram signals with parsed TP1/TP2/TP3:**
```
tp1 = signal.tp1   (from parser.py ParsedSignal.tp1)
tp2 = signal.tp2
tp3 = signal.tp3
```

Fallback: if a Telegram signal only has tp1 but not tp2/tp3, derive the missing levels using the percentage formula above with tp1 as the anchor and target_price as tp3.

### OpenPosition Redis Structure

Add four fields to the existing `OpenPosition` interface:

```typescript
tp1: number;              // first target price
tp2: number;              // second target price
tp3: number;              // third target = original takeProfit
tpFilledLevels: number[]; // which levels have been sold: e.g. [1, 2]
originalQuantity: number; // initial qty for computing 25% tranches
```

`takeProfit` is kept as an alias for `tp3` (backward compatibility with trailing stop code that references it).

### partialSellPosition() Contract

```typescript
async function partialSellPosition(
  position: OpenPosition,
  trancheQty: number,
  reason: 'SOLD_TP1' | 'SOLD_TP2' | 'SOLD_TP3'
): Promise<{ success: boolean; orderId?: string; price?: number }> {
  // 1. Guard: skip if trancheQty < MIN_ORDER_VALUE (dust protection)
  // 2. Execute MARKET SELL via Binance CCXT with 3-retry / 200ms backoff
  // 3. On success:
  //    a. Write position_history row: quantity=trancheQty, closeReason=reason,
  //       pnl=(exitPrice - entryPrice) * trancheQty - proratedFee
  //    b. Update position in Redis:
  //       - quantity -= trancheQty
  //       - entryFee -= (entryFee / originalQuantity) * trancheQty  (prorated)
  //       - tpFilledLevels.push(levelNumber)
  // 4. On failure: log error, skip this TP level for current cycle
  //    (will retry on next monitorPositions() cycle)
}
```

**Error handling:** fail-open per-level. A failed TP1 sell does not block TP2/TP3 on next cycle.
**highWaterMark:** not reset on partial sell (position-level metric, unchanged).
**Trailing stop:** operates unchanged on remaining quantity after partial sells.

### Position Monitoring Logic

`partialSellPosition()` executes a market sell of `trancheQty`, writes a `position_history` record, and updates the position in Redis with reduced `quantity`.

Monitor loop per position:
1. If `price >= tp1` and `!tpFilledLevels.includes(1)` → partialSell(originalQty × 0.25), push 1
2. If `price >= tp2` and `!tpFilledLevels.includes(2)` → partialSell(originalQty × 0.25), push 2
3. If `price >= tp3` and `!tpFilledLevels.includes(3)` → partialSell(originalQty × 0.25), push 3
4. Trailing stop → closes remaining quantity (existing logic, unchanged)
5. Stop-Loss → closes remaining quantity (existing logic, unchanged)

Position is fully closed when `quantity ≈ 0` (below MIN_ORDER_VALUE).

### Exit Reason Granularity

New `closeReason` values for partial exits:
- `SOLD_TP1` — 25% sold at TP1
- `SOLD_TP2` — 25% sold at TP2
- `SOLD_TP3` — 25% sold at TP3

Existing values unchanged:
- `SOLD_TRAILING` — final 25% via trailing stop
- `SOLD_SL` — stop-loss hit (closes remaining quantity)
- `SOLD_STAGNATION`, `SOLD_DUST` — unchanged

### Database Schema Changes

Add `tp1` and `tp2` decimal columns to:
- `positions` table
- `position_history` table

Existing `take_profit` column = tp3 (no rename, no breaking change). Migration via direct SQL on prod (`docker exec cryonix-postgres-1 psql`).

### TradingSignal Type

Add optional fields to `TradingSignal` in `packages/types/src/index.ts`:
```typescript
tp1?: number;
tp2?: number;
tp3?: number;
```

These are populated by the Telegram scraper for channel signals, and left undefined for internal signals (route derives them from `target_price` at execution time).

## Files Changed

| File | Change |
|------|--------|
| `apps/web/src/app/api/auto-trade/route.ts` | OpenPosition interface (+4 fields), executeBuy() (calculate tp1/tp2/tp3), monitorPositions() (check each TP level), new partialSellPosition() |
| `packages/database/src/schema.ts` | +tp1, +tp2 columns in positions + position_history tables |
| `packages/types/src/index.ts` | +tp1?, tp2?, tp3? in TradingSignal |

`cryonix.toml` — no changes needed. TP levels derived at runtime.

## Backward Compatibility

**Old positions (no tp1/tp2 in Redis):**
- Detection: `if (!position.tp1)` → skip TP1/TP2 checks, use only `takeProfit` (existing behavior).
- On first read, auto-hydrate missing fields with safe defaults:
  ```typescript
  const pos = {
    tpFilledLevels: [],
    originalQuantity: raw.quantity ?? 0,
    tp1: raw.tp1 ?? 0,   // 0 = never triggers (price never <= 0)
    tp2: raw.tp2 ?? 0,
    tp3: raw.takeProfit,
    ...raw,
  };
  ```
- `takeProfit` field retained as alias for tp3.
- Existing `SOLD_TP` close reason still valid for positions without multi-TP structure.

## Deployment Checklist

Run schema migration **after** `git archive` deploy but **before** `docker compose restart`:

```bash
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "
  ALTER TABLE positions ADD COLUMN IF NOT EXISTS tp1 DECIMAL(20,8);
  ALTER TABLE positions ADD COLUMN IF NOT EXISTS tp2 DECIMAL(20,8);
  ALTER TABLE position_history ADD COLUMN IF NOT EXISTS tp1 DECIMAL(20,8);
  ALTER TABLE position_history ADD COLUMN IF NOT EXISTS tp2 DECIMAL(20,8);
"
```

Verify:
```bash
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "\d positions" | grep tp
# Expected: tp1 | numeric | and tp2 | numeric |
```

Then restart services: `docker compose -f docker-compose.prod.yml restart web auto-trader`

## Not In Scope

- Configurable split ratios (25/25/25/25 is fixed for now; calibrate later)
- Python engine changes (TP levels computed in route, not engine)
- Telegram scraper changes (already parses tp1/tp2/tp3 correctly)
- Grid positions and scalp positions (unchanged, use their own TP logic)
