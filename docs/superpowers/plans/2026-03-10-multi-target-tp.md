# Multi-Target Take-Profit Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single take-profit exit with three staged TP levels (25/25/25/trailing split), applied to all positions.

**Architecture:** TP levels are calculated at execution time in the auto-trade route (not in the Python engine), then stored in Redis on the OpenPosition object. A new `partialSellPosition()` function handles tranche sells. The monitoring loop checks each TP level independently (fail-open per level).

**Tech Stack:** TypeScript, Next.js API routes, Redis (POSITIONS_KEY JSON array), Drizzle ORM (schema.ts), Postgres

**Spec:** `docs/superpowers/specs/2026-03-10-multi-target-tp-design.md`

---

## File Map

| File | Change |
|------|--------|
| `packages/database/src/schema.ts` | Add `tp1`, `tp2` columns to `positions` and `positionHistory` tables |
| `packages/types/src/index.ts` | Add `tp1?`, `tp2?`, `tp3?` optional fields to `TradingSignal` |
| `apps/web/src/app/api/auto-trade/route.ts` | Extend `OpenPosition` interface, add `updatePosition()`, extend `MonitorResult.action`, calculate TP levels in `executeBuy()`, add `partialSellPosition()`, add TP1/TP2/TP3 checks in monitoring loop |

---

## Chunk 1: Data Model

### Task 1: DB Schema — Add tp1/tp2 columns

**Files:**
- Modify: `packages/database/src/schema.ts:83-97` (positions table)
- Modify: `packages/database/src/schema.ts:330-355` (positionHistory table)

- [ ] **Step 1: Read the current schema for both tables**

```bash
grep -n "tp1\|tp2\|takeProfit\|take_profit" packages/database/src/schema.ts
```

Expected: Only `takeProfit`/`take_profit` found, no tp1/tp2 yet.

- [ ] **Step 2: Add tp1/tp2 columns to `positions` table**

In `packages/database/src/schema.ts`, after `takeProfit` line (~96):

```typescript
// Before:
  takeProfit: decimal('take_profit', { precision: 20, scale: 8 }),
});

// After:
  takeProfit: decimal('take_profit', { precision: 20, scale: 8 }),
  tp1: decimal('tp1', { precision: 20, scale: 8 }),
  tp2: decimal('tp2', { precision: 20, scale: 8 }),
});
```

- [ ] **Step 3: Add tp1/tp2 columns to `positionHistory` table**

Find the `takeProfit` line in the `positionHistory` table and add after it:

```typescript
  tp1: decimal('tp1', { precision: 20, scale: 8 }),
  tp2: decimal('tp2', { precision: 20, scale: 8 }),
```

- [ ] **Step 4: Type-check to confirm Drizzle schema compiles**

```bash
cd packages/database && pnpm type-check 2>&1 | head -30
```

Expected: No TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/schema.ts
git commit -m "feat(db): add tp1/tp2 columns to positions and position_history tables"
```

---

### Task 2: TradingSignal type — Add tp1/tp2/tp3 fields

**Files:**
- Modify: `packages/types/src/index.ts`

- [ ] **Step 1: Read the TradingSignal type definition**

```bash
grep -n "target_price\|stop_loss\|tp1\|tp2\|tp3\|TradingSignal" packages/types/src/index.ts | head -20
```

- [ ] **Step 2: Add optional tp1/tp2/tp3 to TradingSignalSchema**

Find the `target_price` field in `TradingSignalSchema` and add after `stop_loss`:

```typescript
  tp1: z.number().optional(),
  tp2: z.number().optional(),
  tp3: z.number().optional(),
```

Also add the corresponding fields to any raw `TradingSignal` TypeScript interface in the same file.

- [ ] **Step 3: Type-check**

```bash
cd packages/types && pnpm type-check 2>&1 | head -30
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/index.ts
git commit -m "feat(types): add optional tp1/tp2/tp3 fields to TradingSignal"
```

---

## Chunk 2: OpenPosition & updatePosition

### Task 3: OpenPosition interface + updatePosition()

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts:160-179` (OpenPosition interface)
- Modify: `apps/web/src/app/api/auto-trade/route.ts:420-460` (add updatePosition after removePosition)
- Modify: `apps/web/src/app/api/auto-trade/route.ts:473-476` (MonitorResult.action union)

- [ ] **Step 1: Extend OpenPosition interface**

Find the `OpenPosition` interface at line ~160. Add five new fields after `entryFee`:

```typescript
  entryFee?: number;       // Fee paid on entry order (for total fee tracking)
  // Multi-target TP fields (populated at buy time)
  tp1?: number;            // First target (25% sell)
  tp2?: number;            // Second target (25% sell)
  tp3?: number;            // Third target = takeProfit (25% sell)
  tpFilledLevels?: number[]; // Levels already sold: e.g. [1, 2]
  originalQuantity?: number; // Initial qty for computing 25% tranches
```

- [ ] **Step 2: Add updatePosition() function**

After `removePosition()` (around line 445), add:

```typescript
async function updatePosition(symbol: string, updates: Partial<OpenPosition>): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    if (await acquirePositionLock()) {
      try {
        const positions = await getOpenPositions();
        const idx = positions.findIndex(p => p.symbol === symbol);
        if (idx === -1) return false;
        positions[idx] = { ...positions[idx], ...updates };
        await saveOpenPositions(positions);
        return true;
      } finally {
        await releasePositionLock();
      }
    }
    await new Promise(r => setTimeout(r, 200 * (i + 1)));
  }
  // Fallback without lock
  const positions = await getOpenPositions();
  const idx = positions.findIndex(p => p.symbol === symbol);
  if (idx === -1) return false;
  positions[idx] = { ...positions[idx], ...updates };
  await saveOpenPositions(positions);
  return true;
}
```

- [ ] **Step 3: Extend MonitorResult.action type union**

Find the `MonitorResult` interface (line ~473). Extend the action union:

```typescript
// Before:
  action: 'HOLD' | 'SOLD_TP' | 'SOLD_SL' | 'SOLD_TRAILING' | 'SOLD_STAGNATION' | 'SOLD_DUST' | 'ERROR';

// After:
  action: 'HOLD' | 'SOLD_TP' | 'SOLD_TP1' | 'SOLD_TP2' | 'SOLD_TP3' | 'SOLD_SL' | 'SOLD_TRAILING' | 'SOLD_STAGNATION' | 'SOLD_DUST' | 'ERROR';
```

- [ ] **Step 4: Type-check**

```bash
cd apps/web && pnpm type-check 2>&1 | grep "auto-trade" | head -20
```

Expected: No errors in auto-trade/route.ts.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "feat(auto-trade): extend OpenPosition with tp1/tp2/tp3 fields, add updatePosition()"
```

---

## Chunk 3: executeBuy TP Calculation

### Task 4: Calculate TP levels in executeBuy()

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts` — addPosition call at line ~1829

Context: The `addPosition` call at line ~1829 stores `takeProfit: signal.target_price`. We need to calculate `tp3 = signal.target_price` (or `signal.tp3`), then derive `tp1` and `tp2`, and store all five new fields.

- [ ] **Step 1: Read the addPosition call block (lines ~1828-1847)**

Verify exact field positions before editing.

- [ ] **Step 2: Add TP calculation before the addPosition call**

Insert this block immediately before the `await addPosition({` call at line ~1829:

```typescript
// Calculate multi-target TP levels.
// Telegram signals: use provided levels directly. Partial case (tp1 only, no tp2/tp3):
//   anchor tp2 at midpoint between tp1 and target_price.
// Internal signals: derive all three from target_price using percentage formula.
const tp3 = signal.tp3 ?? signal.target_price;
const tp1 = signal.tp1 ?? (executedPrice + (tp3 - executedPrice) * 0.50);
// If tp1 was Telegram-provided but tp2 is missing, anchor tp2 between tp1 and tp3
const tp2 = signal.tp2 ?? (
  signal.tp1
    ? tp1 + (tp3 - tp1) * 0.5                          // midpoint tp1..tp3
    : executedPrice + (tp3 - executedPrice) * 0.75      // standard 75% formula
);
```

- [ ] **Step 3: Extend the addPosition call with new fields**

```typescript
// Before (takeProfit line):
      takeProfit: signal.target_price,

// After:
      takeProfit: tp3,          // alias for tp3, kept for trailing stop compat
      tp1,
      tp2,
      tp3,
      tpFilledLevels: [],
      originalQuantity: executedQty,
```

- [ ] **Step 4: Type-check**

```bash
cd apps/web && pnpm type-check 2>&1 | grep "auto-trade" | head -20
```

Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "feat(auto-trade): calculate tp1/tp2/tp3 levels in executeBuy()"
```

---

## Chunk 4: partialSellPosition + Monitor Loop

### Task 5: partialSellPosition() function

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts` — add function before `monitorPositions()`

Context: This function sells a tranche of a position at market price, writes a `position_history` record, and updates the position in Redis (reduced quantity, prorated fee, marks level filled). It is fail-open: a failed sell skips the level for this cycle, retried next cycle.

- [ ] **Step 1: Find where monitorPositions() begins**

```bash
grep -n "async function monitorPositions\|function monitorPositions" apps/web/src/app/api/auto-trade/route.ts
```

Note the line number — insert `partialSellPosition` before it.

- [ ] **Step 2: Add partialSellPosition() function**

```typescript
async function partialSellPosition(
  pos: OpenPosition,
  trancheQty: number,
  reason: 'SOLD_TP1' | 'SOLD_TP2' | 'SOLD_TP3',
  currentPrice: number
): Promise<{ success: boolean; orderId?: string; price?: number }> {
  const level = parseInt(reason.replace('SOLD_TP', '')) as 1 | 2 | 3;

  // Dust guard
  const trancheValue = trancheQty * currentPrice;
  if (trancheValue < CONFIG.MIN_ORDER_VALUE) {
    console.warn(`[PARTIAL-TP] ${pos.symbol} TP${level} tranche $${trancheValue.toFixed(2)} < min — skipping`);
    return { success: false };
  }

  // Market sell with 3-retry / 200ms backoff
  let closeOrder: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      closeOrder = await ex.createMarketOrder(pos.symbol, 'sell', trancheQty);
      break;
    } catch (err) {
      if (attempt === 3) {
        console.error(`[PARTIAL-TP] ${pos.symbol} TP${level} sell failed after 3 attempts:`, err instanceof Error ? err.message : String(err));
        return { success: false };
      }
      await new Promise(r => setTimeout(r, 200 * attempt));
    }
  }

  const exitPrice = closeOrder.average || closeOrder.price || currentPrice;
  const exitFee = closeOrder.fee?.cost || 0;
  // Prorated entry fee for this tranche
  const proratedEntryFee = ((pos.entryFee || 0) / (pos.originalQuantity || pos.quantity)) * trancheQty;
  const fees = exitFee + proratedEntryFee;
  const realizedPnl = (exitPrice - pos.entryPrice) * trancheQty - fees;

  // Write position_history row for this tranche
  try {
    await archivePosition({
      symbol: pos.symbol,
      side: pos.side,
      quantity: String(trancheQty),
      entryPrice: String(pos.entryPrice),
      exitPrice: String(exitPrice),
      stopLoss: String(pos.stopLoss),
      takeProfit: String(pos.takeProfit),
      pnl: String(realizedPnl),
      pnlPercent: String(((exitPrice - pos.entryPrice) / pos.entryPrice) * 100),
      fees: String(fees),
      holdingPeriod: Math.round((Date.now() - new Date(pos.openedAt || Date.now()).getTime()) / 1000),
      openedAt: new Date(pos.openedAt || Date.now()),
      closedAt: new Date(),
      closeReason: reason,
      pattern: pos.pattern,
      tp1: pos.tp1 ? String(pos.tp1) : undefined,
      tp2: pos.tp2 ? String(pos.tp2) : undefined,
      metadata: {
        level,
        trancheQty,
        originalQuantity: pos.originalQuantity,
        highWaterMark: pos.highWaterMark,
        confidence: pos.confidence,
        configVersion: getConfigVersion(),
      },
      agentId: 'auto-trader',
    });
  } catch (archiveErr) {
    console.warn(`[PARTIAL-TP] ${pos.symbol} TP${level} position_history write failed (non-critical):`, archiveErr);
  }

  // Update position in Redis: reduce quantity, prorated fee, mark level filled
  const newQuantity = pos.quantity - trancheQty;
  const newEntryFee = (pos.entryFee || 0) - proratedEntryFee;
  const newFilledLevels = [...(pos.tpFilledLevels || []), level];
  await updatePosition(pos.symbol, {
    quantity: newQuantity,
    entryFee: Math.max(0, newEntryFee),
    tpFilledLevels: newFilledLevels,
  });

  console.log(`[PARTIAL-TP] ${pos.symbol} TP${level}: sold ${trancheQty} @ $${exitPrice.toFixed(4)}, PnL $${realizedPnl.toFixed(4)}, remaining qty ${newQuantity.toFixed(6)}`);
  return { success: true, orderId: closeOrder.id, price: exitPrice };
}
```

- [ ] **Step 3: Type-check**

```bash
cd apps/web && pnpm type-check 2>&1 | grep "auto-trade" | head -20
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "feat(auto-trade): add partialSellPosition() for tranche TP exits"
```

---

### Task 6: monitorPositions() — partial exit checks

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts` — monitoring loop at line ~716-733

Context: The LONG position monitoring block currently checks `if (currentPrice >= pos.takeProfit)` and sets `shouldSell = true`. We need to:
1. Hydrate old positions that lack tp1/tp2 fields (backward compat)
2. Before the full-sell TP check: check each TP level in order and call `partialSellPosition()` for unmet levels
3. Only trigger the existing full-sell TP path if TP is a legacy position OR if tp3 is hit AND tp1+tp2 have already been filled

- [ ] **Step 1: Read lines 665-740 in route.ts**

Understand the exact structure of the per-position monitoring block to pick exact insertion points.

- [ ] **Step 2: Add backward-compat hydration at the top of the per-position block**

Find where `pos` is first used in the monitoring loop. Add hydration at the start of the `for (const pos of positions)` body, before any price checks:

```typescript
// Hydrate old positions missing multi-TP fields (backward compat).
// tp1/tp2 default to 0: price never <= 0, so these levels never trigger spuriously.
if (!pos.tp1) {
  pos.tpFilledLevels = pos.tpFilledLevels ?? [];
  pos.originalQuantity = pos.originalQuantity ?? pos.quantity;
  pos.tp1 = pos.tp1 ?? 0;   // 0 = never triggers
  pos.tp2 = pos.tp2 ?? 0;
  pos.tp3 = pos.tp3 ?? pos.takeProfit;
}
```

- [ ] **Step 3: Add TP1/TP2/TP3 partial sell checks in the LONG block**

Find the LONG monitoring block (lines ~716-733):

```typescript
      // LONG position: exit by selling
      // 1. Take-profit hit
      if (currentPrice >= pos.takeProfit) {
        shouldSell = true;
        exitReason = `Take-profit hit: ...`;
      }
```

Replace it with:

```typescript
      // LONG position: exit by selling
      // Multi-target TP (new): check each level if position has tp1/tp2 set
      if (pos.tp1 && pos.tp2 && !pos.isGridPosition && !pos.isScalpPosition) {
        const filledLevels = pos.tpFilledLevels ?? [];
        const origQty = pos.originalQuantity ?? pos.quantity;
        const trancheQty = origQty * 0.25;

        // Check TP1
        if (currentPrice >= pos.tp1 && !filledLevels.includes(1)) {
          if (IS_PRODUCTION) {
            const result = await partialSellPosition(pos, trancheQty, 'SOLD_TP1', currentPrice);
            if (result.success) {
              results.push({ symbol: pos.symbol, action: 'SOLD_TP1', currentPrice, pnl: undefined });
            }
          } else {
            console.log(`[DEV-MODE] Would partial sell TP1 ${pos.symbol} — blocked`);
          }
        }

        // Check TP2
        if (currentPrice >= pos.tp2 && !filledLevels.includes(2)) {
          if (IS_PRODUCTION) {
            const result = await partialSellPosition(pos, trancheQty, 'SOLD_TP2', currentPrice);
            if (result.success) {
              results.push({ symbol: pos.symbol, action: 'SOLD_TP2', currentPrice, pnl: undefined });
            }
          } else {
            console.log(`[DEV-MODE] Would partial sell TP2 ${pos.symbol} — blocked`);
          }
        }

        // Check TP3 (tp3 = takeProfit) — partial sell, not full close
        // Note: filledLevels is read once per cycle. On a price gap-up past all 3 levels,
        // all three partialSellPosition calls fire (intended: sell 75%). Fail-open per level.
        if (currentPrice >= pos.tp3! && !filledLevels.includes(3)) {
          if (IS_PRODUCTION) {
            const result = await partialSellPosition(pos, trancheQty, 'SOLD_TP3', currentPrice);
            if (result.success) {
              results.push({ symbol: pos.symbol, action: 'SOLD_TP3', currentPrice, pnl: undefined });
            }
          } else {
            console.log(`[DEV-MODE] Would partial sell TP3 ${pos.symbol} — blocked`);
          }
          // Don't set shouldSell — trailing stop handles the remaining 25%
        }
      } else {
        // 1. Take-profit hit (legacy: no tp1/tp2, or grid/scalp position)
        if (currentPrice >= pos.takeProfit) {
          shouldSell = true;
          exitReason = `Take-profit hit: $${currentPrice.toFixed(4)} >= $${pos.takeProfit.toFixed(4)}`;
        }
      }
```

Note: The stop-loss and trailing-stop blocks that follow (`else if (currentPrice <= pos.stopLoss)` etc.) are unchanged — they still trigger `shouldSell = true` and cause a full close of remaining quantity.

- [ ] **Step 4: Type-check**

```bash
cd apps/web && pnpm type-check 2>&1 | grep "auto-trade" | head -20
```

Expected: No errors.

- [ ] **Step 5: Run production build to catch any remaining issues**

```bash
cd apps/web && pnpm build 2>&1 | tail -30
```

Expected: Successful build.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "feat(auto-trade): add TP1/TP2/TP3 partial exit checks in monitoring loop"
```

---

## Chunk 5: Deployment

### Task 7: Database migration + deploy

**Context:** Schema changes are pushed directly via `docker exec psql` on the VM (not via drizzle-kit). Run the SQL migration AFTER deploying the code but BEFORE restarting services.

- [ ] **Step 1: Deploy code to VM**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
```

- [ ] **Step 2: Run DB migration**

```bash
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "
  ALTER TABLE positions ADD COLUMN IF NOT EXISTS tp1 DECIMAL(20,8);
  ALTER TABLE positions ADD COLUMN IF NOT EXISTS tp2 DECIMAL(20,8);
  ALTER TABLE position_history ADD COLUMN IF NOT EXISTS tp1 DECIMAL(20,8);
  ALTER TABLE position_history ADD COLUMN IF NOT EXISTS tp2 DECIMAL(20,8);
"
```

- [ ] **Step 3: Verify columns added**

```bash
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "\d positions" | grep tp
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "\d position_history" | grep tp
```

Expected: `tp1 | numeric |` and `tp2 | numeric |` for both tables.

- [ ] **Step 4: Restart web + auto-trader services**

```bash
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml restart web auto-trader"
```

- [ ] **Step 5: Check logs for errors**

```bash
ssh azureuser@openclaw-vm "docker logs cryonix-web-1 --tail 30"
ssh azureuser@openclaw-vm "docker logs cryonix-auto-trader-1 --tail 30"
```

Expected: No TypeErrors, no crash loops. Auto-trader poll log shows normal cycle.

- [ ] **Step 6: Verify next position opened stores TP fields**

After the next BUY signal executes, inspect Redis:

```bash
docker exec cryonix-redis-1 redis-cli GET positions:open
```

Expected: JSON array where the new position has `tp1`, `tp2`, `tp3`, `tpFilledLevels: []`, `originalQuantity` set.

---

## Not In Scope

- Configurable split ratios (fixed 25/25/25/25)
- Grid and scalp positions (they have their own TP logic — explicitly excluded)
- Python engine changes
- Telegram scraper changes (already parses tp1/tp2/tp3 from CoinCodeCap/Cornix)
- UI changes (TP level display can be a follow-up)

