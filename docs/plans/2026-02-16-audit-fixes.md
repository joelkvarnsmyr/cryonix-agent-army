# Cryonix Audit Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix all 13 issues found in the 2026-02-16 system audit: data sync gaps, config inconsistencies, broken healthcheck, stale queues, and missing chart data.

**Architecture:** Auto-trade owns position lifecycle and syncs to Postgres. Shared risk config in `packages/types` replaces 3 inconsistent configs. Chart-data endpoints serve real data from position_history and calibration.

**Tech Stack:** TypeScript (Next.js API routes), Drizzle ORM, ioredis, Python FastAPI engine, Docker Compose.

---

## Task 1: Create Shared Risk Config

> Fixes audit issue #7 (3 different risk configs) and #9 (evolution uses stale config).

**Files:**
- Create: `packages/types/src/risk-config.ts`
- Modify: `packages/types/src/index.ts` (add re-export)
- Modify: `apps/web/src/app/api/auto-trade/route.ts:43-65` (import shared config)
- Modify: `apps/web/src/app/api/risk-check/route.ts:124-130` (import shared config)

**Step 1: Create `packages/types/src/risk-config.ts`**

```typescript
// Canonical risk config — single source of truth
// Used by: auto-trade, risk-check API, engine (via Redis config:risk key)

export const RISK_CONFIG = {
  // Capital allocation
  TOTAL_CAPITAL: 0, // 0 = auto-detect from Binance balance
  SIGNAL_POOL_PCT: 0.65,
  GRID_POOL_PCT: 0.25,
  RESERVE_PCT: 0.10,

  // Position limits
  MAX_POSITION_SIZE_PCT: 0.25,
  MAX_OPEN_POSITIONS: 3,
  MAX_SIGNAL_POSITIONS: 2,
  MAX_GRID_POSITIONS: 1,
  MIN_ORDER_VALUE: 7.5,

  // Risk limits
  MIN_CONFIDENCE: 0.65,
  MAX_DAILY_LOSS_PCT: 0.05,
  MAX_WEEKLY_LOSS_PCT: 0.10,
  MAX_SLIPPAGE_PCT: 0.5,
  MAX_TRADES_PER_DAY: 6,
  MAX_PENDING_QUEUE: 30,

  // Execution
  SPOT_ONLY: true,
  TRADING_MODE: 'spot' as const,
  MARGIN_TYPE: 'cross' as const,
  DEFAULT_LEVERAGE: 3,
  TRAILING_STOP_PCT: 3,
  AI_VALIDATION: true,
} as const;

export type RiskConfig = typeof RISK_CONFIG;
```

**Step 2: Add re-export to `packages/types/src/index.ts`**

Add at end of file:
```typescript
export { RISK_CONFIG, type RiskConfig } from './risk-config';
```

**Step 3: Replace CONFIG in `auto-trade/route.ts`**

At line 1-2, add import:
```typescript
import { RISK_CONFIG } from '@cryonix/types';
```

Replace lines 43-65 (the entire `const CONFIG = { ... }` block) with:
```typescript
const CONFIG = RISK_CONFIG;
```

**Step 4: Replace hardcoded config in `risk-check/route.ts`**

Replace lines 124-130 (the hardcoded config in GET response) with:
```typescript
config: {
    maxPortfolioRisk: `${RISK_CONFIG.MAX_DAILY_LOSS_PCT * 100}%`,
    maxPositionRisk: '2%',
    maxPositionSize: `${RISK_CONFIG.MAX_POSITION_SIZE_PCT * 100}%`,
    maxOpenPositions: RISK_CONFIG.MAX_OPEN_POSITIONS,
    dailyLossLimit: `${RISK_CONFIG.MAX_DAILY_LOSS_PCT * 100}%`,
    useHalfKelly: true,
},
```

Add import at top:
```typescript
import { RISK_CONFIG } from '@cryonix/types';
```

**Step 5: Push config to Redis for engine**

In `auto-trade/route.ts`, inside the POST handler (after line 1680 `resetDailyStateIfNeeded()`), add:
```typescript
await redis.set('config:risk', JSON.stringify(RISK_CONFIG), 'EX', 3600);
```

**Step 6: Verify build**

Run: `cd /home/azureuser/cryonix && pnpm build`

**Step 7: Commit**

```
feat: shared risk config — single source of truth for all risk parameters
```

---

## Task 2: Sync Positions to Postgres on Open

> Fixes audit issue #2 (positions table always empty).

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts:1320-1362` (after executeBuy)
- Reference: `packages/database/src/positions.repository.ts`
- Reference: `packages/database/src/schema.ts:32-46` (positions table)

**Step 1: Add import**

In `auto-trade/route.ts`, find existing imports from `@cryonix/database` (near line 2) and add:
```typescript
import { createPosition, updatePosition, markSignalExecuted } from '@cryonix/database';
```

Check what `positions.repository.ts` exports. If `createPosition` doesn't exist, create it (see step 1b).

**Step 1b: If needed, add createPosition to positions.repository.ts**

```typescript
export async function createPosition(data: {
  symbol: string;
  quantity: string;
  entryPrice: string;
  status?: string;
  stopLoss?: string;
  takeProfit?: string;
}): Promise<Position> {
  const [pos] = await db
    .insert(positions)
    .values({
      symbol: data.symbol,
      quantity: data.quantity,
      entryPrice: data.entryPrice,
      status: data.status || 'OPEN',
      stopLoss: data.stopLoss,
      takeProfit: data.takeProfit,
    })
    .returning();
  return pos;
}

export async function closePosition(symbol: string, exitPrice: string, pnl: string, pnlPercent: string): Promise<void> {
  await db
    .update(positions)
    .set({
      status: 'CLOSED',
      currentPrice: exitPrice,
      pnl,
      pnlPercent,
      closedAt: new Date(),
    })
    .where(and(eq(positions.symbol, symbol), eq(positions.status, 'OPEN')));
}
```

**Step 2: After executeBuy success, also write to Postgres**

In `auto-trade/route.ts`, after the `addPosition({...})` call (around line 1346-1362), add:

```typescript
// Sync to Postgres
try {
  await createPosition({
    symbol: signal.symbol,
    quantity: String(qty),
    entryPrice: String(executedPrice),
    stopLoss: signal.stop_loss ? String(signal.stop_loss) : undefined,
    takeProfit: signal.target_price ? String(signal.target_price) : undefined,
  });
} catch (err) {
  console.error('[SYNC] Failed to create position in Postgres:', err);
}
```

Do the same after `executeMarginSell` success (around line 1432-1445).

**Step 3: Commit**

```
feat: sync position opens to Postgres — positions table now populated
```

---

## Task 3: Sync Position Closes to Postgres + Mark Signals Executed

> Fixes audit issues #2 (positions table), #3 (executed flag never set), #11 (orphaned trades).

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts:639-859` (monitorPositions close path)
- Reference: `packages/database/src/signals.repository.ts:83-91` (markSignalExecuted exists but unused)

**Step 1: In monitorPositions(), after removePosition and archivePosition, add Postgres close**

Find the position close logic (around lines 682-731) where `removePosition(pos.symbol)` and `archivePosition({...})` are called. After the archivePosition call, add:

```typescript
// Close position in Postgres
try {
  await closePosition(pos.symbol, String(closePrice), String(pnl), String(pnlPct));
} catch (err) {
  console.error('[SYNC] Failed to close position in Postgres:', err);
}
```

**Step 2: Mark the corresponding signal as executed**

After `logTrade()` in the execution path (around line 1852-1862), add:

```typescript
// Mark matching signal as executed in Postgres
try {
  // Find most recent unexecuted signal for this symbol
  const recentSignals = await db
    .select()
    .from(signals)
    .where(and(
      eq(signals.symbol, signal.symbol),
      eq(signals.executed, false),
      eq(signals.action, signal.action)
    ))
    .orderBy(desc(signals.id))
    .limit(1);

  if (recentSignals.length > 0) {
    await markSignalExecuted(recentSignals[0].id);
  }
} catch (err) {
  console.error('[SYNC] Failed to mark signal executed:', err);
}
```

This requires importing `db`, `signals`, `eq`, `and`, `desc` from Drizzle, or creating a helper in `signals.repository.ts` that finds and marks by symbol.

Simpler alternative — add to `signals.repository.ts`:
```typescript
export async function markLatestSignalExecuted(symbol: string, action: string): Promise<void> {
  const [latest] = await db
    .select({ id: signals.id })
    .from(signals)
    .where(and(
      eq(signals.symbol, symbol),
      eq(signals.executed, false),
      eq(signals.action, action)
    ))
    .orderBy(desc(signals.id))
    .limit(1);

  if (latest) {
    await markSignalExecuted(latest.id);
  }
}
```

Then in auto-trade: `await markLatestSignalExecuted(signal.symbol, signal.action);`

**Step 3: Commit**

```
feat: sync position closes to Postgres + mark signals executed
```

---

## Task 4: Clean trades:approved Queue

> Fixes audit issue #4 (queue grows indefinitely with executed trades).

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts:1842-1850` (lpush to approved)

**Step 1: Add queue trim after pushing to approved**

After the `redis.lpush('trades:approved', ...)` call at line 1842-1850, add:

```typescript
// Keep only last 50 approved trades (prevent unbounded growth)
await redis.ltrim('trades:approved', 0, 49);
```

**Step 2: Commit**

```
fix: trim trades:approved queue to prevent unbounded growth
```

---

## Task 5: Sync risk:portfolio_state with Actual Positions

> Fixes audit issue #1 (engine sees 0 open positions).

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts`

**Step 1: Create syncRiskState helper function**

Add near the other helper functions (around line 350):

```typescript
async function syncRiskState(): Promise<void> {
  const positions = await getOpenPositions();
  const state = {
    total_capital: (await getCapitalBudget()).totalCapital,
    available_capital: (await getCapitalBudget()).signalRemaining + (await getCapitalBudget()).gridRemaining,
    open_positions: positions.map(p => ({
      symbol: p.symbol,
      side: p.side || 'BUY',
      entry_price: p.entryPrice,
      quantity: p.quantity,
      stop_loss: p.stopLoss,
    })),
    daily_pnl: dailyState.dailyPnl,
    weekly_pnl: 0,
    daily_trades: dailyState.tradesExecuted,
    consecutive_losses: 0,
    last_reset_date: new Date().toISOString().split('T')[0],
    last_week_reset: new Date().toISOString().split('T')[0],
    circuit_breaker_active: false,
    circuit_breaker_reason: '',
    circuit_breaker_until: null,
  };
  await redis.set('risk:portfolio_state', JSON.stringify(state));
}
```

**Step 2: Call syncRiskState after every position change**

In the POST handler, after `monitorPositions()` (around line 1683) and after the buy execution loop (around line 1880), add:

```typescript
await syncRiskState();
```

**Step 3: Commit**

```
fix: sync risk:portfolio_state with actual positions from Redis
```

---

## Task 6: Fix Docker Healthcheck

> Fixes audit issue #5 (curl not in image, Docker always shows unhealthy).

**Files:**
- Modify: `docker-compose.prod.yml:111-116`

**Step 1: Replace curl-based healthcheck with node-based**

Replace lines 111-116:
```yaml
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 30s
```

With:
```yaml
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 30s
```

**Step 2: Commit**

```
fix: Docker healthcheck uses node fetch instead of curl (not in image)
```

---

## Task 7: Fix health.trading.capital

> Fixes audit issue #6 (capital always 0) and #15 (health.trading.capital hardcoded).

**Files:**
- Modify: `apps/web/src/app/api/health/route.ts:69-91`

**Step 1: Read actual capital from auto-trade budget**

In the `getTradingData()` function (lines 69-91), the `capital: 0` placeholder needs to read from Binance balance or Redis. Find the line where `capital: 0` is set (line 85) and replace with:

```typescript
// Read actual capital from Redis daily state or fallback
let capital = 0;
try {
  const budgetRaw = await redis.get('risk:portfolio_state');
  if (budgetRaw) {
    capital = JSON.parse(budgetRaw).total_capital || 0;
  }
} catch {}
```

Then use `capital` in the returned object instead of `0`.

**Step 2: Commit**

```
fix: health endpoint returns actual capital from risk:portfolio_state
```

---

## Task 8: Fix Consensus Level in Validation

> Fixes audit issue #8 (3,242 of 3,244 validations have UNKNOWN consensus).

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts:1791-1814`

**Step 1: Replace hardcoded 'UNKNOWN' with calculated consensus**

At line 1798, the `consensusLevel: 'UNKNOWN'` is hardcoded. Replace with logic from `validate-signal/route.ts` (lines 98-103):

```typescript
// Calculate consensus from AI confidence vs original
const confDelta = Math.abs(aiResult.aiConfidence - signal.confidence);
const consensusScore = confDelta < 0.1 ? 0.8 : confDelta < 0.2 ? 0.6 : confDelta < 0.3 ? 0.4 : 0.2;
const consensusLevel = consensusScore >= 0.8 ? 'STRONG'
  : consensusScore >= 0.6 ? 'MODERATE'
  : consensusScore >= 0.4 ? 'WEAK'
  : 'CONFLICTING';
```

Replace line 1798 with:
```typescript
consensusLevel,
```

Also replace line 1806 `riskLevel: 'UNKNOWN'` with:
```typescript
riskLevel: signal.confidence >= 0.8 ? 'LOW' : signal.confidence >= 0.65 ? 'MEDIUM' : 'HIGH',
```

**Step 2: Commit**

```
fix: calculate actual consensus level and risk level for AI validation
```

---

## Task 9: Fix Floating-Point Confidence

> Fixes audit issue #13 (0.8374999999999999 instead of 0.8375).

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts:1833`

**Step 1: Round blended confidence**

At line 1833:
```typescript
signal.confidence = signal.confidence * 0.5 + aiResult.aiConfidence * 0.5;
```

Replace with:
```typescript
signal.confidence = Math.round((signal.confidence * 0.5 + aiResult.aiConfidence * 0.5) * 10000) / 10000;
```

**Step 2: Commit**

```
fix: round blended confidence to 4 decimals to avoid floating-point artifacts
```

---

## Task 10: Fix Chart Data Endpoints

> Fixes audit issue #12 (type=patterns and type=pnl return identical candle data).

**Files:**
- Modify: `apps/web/src/app/api/chart-data/route.ts:53-119`

**Step 1: Fix type=pnl to return cumulative P&L**

Replace the `case 'pnl':` block (lines 53-85) with:

```typescript
case 'pnl': {
  // Return cumulative P&L from position_history
  const history = await getPositionHistory({ limit: 100 });
  let cumulative = 0;
  const pnlData = history.map((h: any) => {
    cumulative += parseFloat(h.pnl || '0');
    return {
      time: Math.floor(new Date(h.closedAt || h.openedAt).getTime() / 1000),
      value: +cumulative.toFixed(4),
      symbol: h.symbol,
      pnl: parseFloat(h.pnl || '0'),
      pattern: h.pattern,
    };
  });
  return NextResponse.json({ success: true, data: pnlData });
}
```

Import `getPositionHistory` from `@cryonix/database` if not already imported.

**Step 2: Fix type=patterns to return pattern performance**

Replace the `case 'patterns':` block (lines 88-119) with:

```typescript
case 'patterns': {
  // Return pattern performance from Redis calibration data
  const calibRaw = await redis.get('calibration:patterns');
  if (!calibRaw) {
    return NextResponse.json({ success: true, data: [] });
  }
  const calibData = JSON.parse(calibRaw);
  const patterns = Object.values(calibData).map((p: any) => ({
    pattern: p.pattern,
    trades: p.trades,
    wins: p.wins,
    winRate: p.winRate,
    ev: p.ev,
    totalPnl: p.totalPnl,
    avgWin: p.avgWin,
    avgLoss: p.avgLoss,
    profitFactor: p.profitFactor,
    sufficientData: p.sufficientData,
  }));
  return NextResponse.json({ success: true, data: patterns });
}
```

Import `redis` from `@/lib/redis` if not already imported.

**Step 3: Commit**

```
feat: chart-data pnl returns cumulative P&L, patterns returns calibration stats
```

---

## Task 11: Investigate and Fix Evolution

> Fixes audit issue #9 (evolution cron FAILED).

**Files:**
- Read: `/tmp/evolution-cron.log`
- Reference: `scripts/copilot-evolution.mjs` (failure modes at lines 618, 702, 775, 812, 849)

**Step 1: Check evolution log**

```bash
cat /tmp/evolution-cron.log 2>/dev/null | tail -50
```

If file doesn't exist, check:
```bash
ls -la /tmp/evolution*.log
bash scripts/run_evolution.sh 2>&1 | tail -20
```

**Step 2: Based on findings, apply fix**

Common causes (from copilot-evolution.mjs):
- **Verification test fails** (line 775) → Check if test expectations are stale
- **Copilot CLI refusal** (line 374) → Check if Copilot CLI token is expired
- **Diff guard** (line 637-641) → Mutation was too large (>100 lines)
- **Max attempts** (line 809-823) → All mutation attempts failed

Fix depends on root cause. If Copilot CLI auth is the issue, re-authenticate. If verification tests are stale, update them.

**Step 3: Commit if changes made**

```
fix: evolution cron — [specific fix based on investigation]
```

---

## Task 12: Clean Up Orphaned Trades

> Fixes audit issue #11 (15 trades with null exit_price but not open).

**Files:**
- Create: `scripts/fix-orphaned-trades.sql` (one-time migration)

**Step 1: Create cleanup script**

```sql
-- Fix orphaned trades: 15 rows have no exit_price but only 2 are actually open
-- Identify truly open positions from Redis, mark everything else as orphaned

-- First, check current state
SELECT id, symbol, side, entry_price, exit_price, status, timestamp
FROM trades WHERE exit_price IS NULL ORDER BY id;

-- Close orphaned trades (not MANTA/USDC or TAO/USDC which are currently open)
-- The currently open symbols should be verified at runtime
UPDATE trades
SET status = 'ORPHANED',
    exit_price = entry_price,
    pnl = 0
WHERE exit_price IS NULL
  AND status != 'CLOSED'
  AND id NOT IN (
    SELECT id FROM trades
    WHERE exit_price IS NULL
    ORDER BY id DESC
    LIMIT 2  -- keep the 2 most recent (currently open)
  );
```

**Step 2: Run with review**

```bash
# First preview
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c "SELECT id, symbol, status FROM trades WHERE exit_price IS NULL ORDER BY id"

# Then apply
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -f /tmp/fix-orphaned-trades.sql
```

**Step 3: Commit**

```
fix: mark orphaned trades (null exit_price but not open) as ORPHANED
```

---

## Task 13: Rebuild and Deploy

> Applies all changes to production.

**Step 1: Build**

```bash
cd /home/azureuser/cryonix && pnpm build
```

**Step 2: Rebuild Docker containers**

```bash
docker compose -f docker-compose.prod.yml up -d --build web
```

Only web needs rebuild (auto-trader uses the same image via Dockerfile.scripts which shares the codebase).

Wait for health:
```bash
sleep 30 && curl -s http://localhost:3000/api/health | python3 -m json.tool
```

**Step 3: Verify Docker healthcheck**

```bash
sleep 90 && docker inspect cryonix-web-1 --format '{{.State.Health.Status}}'
# Expected: healthy (not unhealthy)
```

**Step 4: Run system test**

```bash
bash scripts/system-test.sh
# Expected: 60 tests, 0 failures
```

**Step 5: Verify fixes via audit spot-checks**

```bash
# Check positions table is populated
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -tAc "SELECT count(*) FROM positions WHERE status='OPEN'"
# Expected: >= 0 (will populate on next trade)

# Check risk:portfolio_state has positions
docker exec cryonix-redis-1 redis-cli GET risk:portfolio_state | python3 -c "import sys,json; d=json.load(sys.stdin); print('open_positions:', len(d['open_positions']))"
# Expected: 2 (after first auto-trade cycle)

# Check trades:approved queue bounded
docker exec cryonix-redis-1 redis-cli LLEN trades:approved
# Expected: <= 50

# Check chart-data endpoints
curl -s http://localhost:3000/api/chart-data?type=pnl | python3 -c "import sys,json; d=json.load(sys.stdin); print('pnl entries:', len(d.get('data',[])))"
curl -s http://localhost:3000/api/chart-data?type=patterns | python3 -c "import sys,json; d=json.load(sys.stdin); print('patterns:', len(d.get('data',[])))"
```

**Step 6: Commit all**

```
chore: rebuild and deploy audit fixes
```

---

## Execution Order

Tasks 1-5 touch `auto-trade/route.ts` and should be done sequentially to avoid merge conflicts. Tasks 6-10 are independent of each other and can be parallelized. Task 11 is investigative. Task 12 is a one-time data fix. Task 13 is final deploy.

```
Sequential: Task 1 → 2 → 3 → 4 → 5
Parallel:   Task 6, 7, 8, 9, 10
Then:       Task 11, 12
Finally:    Task 13
```

## Not in scope

- **Telegram scraper** (low priority, boost disabled)
- **Trading performance** (29% win rate is strategy, not a bug)
- **Engine Python risk_manager.py** (reads config:risk from Redis after Task 1)
