# Alphanix Critical Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 6 critical bugs preventing Alphanix from functioning as designed — entry prices, Brain JSON parsing, swarm workers, exit trade logging, sentiment wiring, and Nordic SL churn.

**Architecture:** Fix existing code in-place. No new files needed. All fixes are in `packages/agents/src/alphanix/`.

**Tech Stack:** TypeScript, ioredis, Postgres (drizzle)

---

## Bug Analysis

| # | Bug | Root Cause | Impact | File(s) |
|---|-----|-----------|--------|---------|
| 1 | Entry prices = $0 | PositionTracker stores fillPrice from adapter, but positions published to Redis show `entryPrice: 0` — state publisher maps `avgEntryPrice` field but position-tracker uses different key | Dashboard shows 0% PnL for all positions | `pod/position-tracker.ts`, `state/state-publisher.ts` |
| 2 | Brain JSON parse crash | `"running" is not valid JSON` — Brain reads pod state from Redis, state-publisher was fixed to write plain strings, but Brain still calls `JSON.parse()` | Brain never runs successfully | `scripts/services/alphanix-brain.ts` |
| 3 | Swarm workers not starting | 0 Redis keys for `alphanix:swarm:*` — workers are defined but never spawned | No macro/sentiment/osint intelligence | `swarms/swarm-spawner.ts`, `alphanix-agent.ts` |
| 4 | Exit trades not logged to Postgres | Only BUY logged via `db.logTrade()`, SELL/exit path in pod.ts skips logging | No P&L history, no performance analysis | `pod/pod.ts` |
| 5 | Sentiment not wired to QuantAgents | `sentiment_enabled = true` but swarm results never call `setSentimentBoost()` | Pods ignore macro intelligence | `alphanix-agent.ts`, `pod/quant-agent.ts` |
| 6 | Nordic SL churn | Pods buy and immediately SL-exit (HM-B -4.27%, EVO -6.51%, HEXA -6.97%) — SL too tight for Nordic stocks | Constant loss, wastes capital | `pod/pod.ts` exit config |

---

### Task 1: Fix Entry Prices ($0 bug)

**Files:**
- Modify: `packages/agents/src/alphanix/state/state-publisher.ts`
- Modify: `packages/agents/src/alphanix/pod/position-tracker.ts`

The PositionTracker stores `avgEntryPrice` correctly (from fillPrice). The bug is that when positions are serialized to Redis via `publishPodPositions()`, the `NormalizedPosition` type uses `avgEntryPrice` — verify the field name matches between tracker and publisher.

- [ ] **Step 1:** Read `state-publisher.ts` `publishPodPositions()` and `position-tracker.ts` `getAll()` — verify field mapping
- [ ] **Step 2:** Read `alphanix-agent.ts` line 186 where `pod.getPositions()` is called — trace the data flow
- [ ] **Step 3:** Add debug logging to `publishPodPositions()` — log first position's entryPrice before Redis write
- [ ] **Step 4:** If field mismatch found, fix the mapping. If adapter returns 0, fix in adapter's `submitOrder()`
- [ ] **Step 5:** Verify fix by checking Redis after deploy: `redis-cli GET alphanix:pod:crypto_dip_hunter:positions`
- [ ] **Step 6:** Commit

---

### Task 2: Fix Brain JSON Parse Crash

**Files:**
- Modify: `scripts/services/alphanix-brain.ts`

Brain reads `alphanix:pod:{id}:state` which now contains plain string `"running"` (not `'"running"'`). Brain's data collection calls `JSON.parse()` on this, which fails.

- [ ] **Step 1:** Read `scripts/services/alphanix-brain.ts` — find where it reads pod state from Redis
- [ ] **Step 2:** Add `safeParse()` helper (same pattern as dashboard API fixes):
```typescript
function safeParse<T = any>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw as unknown as T; }
}
```
- [ ] **Step 3:** Replace all `JSON.parse(podStateRaw)` calls with `safeParse(podStateRaw)`
- [ ] **Step 4:** Commit

---

### Task 3: Start Swarm Workers

**Files:**
- Read: `packages/agents/src/alphanix/swarms/swarm-spawner.ts`
- Read: `packages/agents/src/alphanix/swarms/workers/` (macro, sentiment, osint, altdata, news)
- Modify: `packages/agents/src/alphanix/alphanix-agent.ts`

Swarm workers are defined but never spawned. Find where `SwarmSpawner` should be called in the orchestrator loop and wire it.

- [ ] **Step 1:** Read `swarm-spawner.ts` — understand the `spawn()` / `runWorkers()` API
- [ ] **Step 2:** Read all 5 workers in `swarms/workers/` — understand what data they produce and where they publish
- [ ] **Step 3:** Read `alphanix-agent.ts` orchestrator loop — find where swarms should be triggered
- [ ] **Step 4:** Add swarm initialization in `initialize()` and periodic `runWorkers()` in the orchestrator tick
- [ ] **Step 5:** Verify swarm Redis keys appear: `redis-cli KEYS 'alphanix:swarm:*'`
- [ ] **Step 6:** Commit

---

### Task 4: Log Exit Trades to Postgres

**Files:**
- Modify: `packages/agents/src/alphanix/pod/pod.ts` (exit section, ~line 240-260)

The exit path closes positions and calls `positionTracker.close()` but never calls `db.logTrade()` for the SELL side.

- [ ] **Step 1:** Read `pod.ts` lines 230-270 — find the exit execution code
- [ ] **Step 2:** After `this.adapter.submitOrder({ side: 'SELL', ... })` succeeds, add:
```typescript
await this.db?.logTrade({
  podId: this.config.id, symbol: sym, adapter: this.adapter.id,
  side: 'SELL', qty: exitResult.filledQty,
  fillPrice: exitResult.filledAvgPrice || currentPrice,
  notional: (exitResult.filledAvgPrice || currentPrice) * exitResult.filledQty,
  slippage: 0, fees: 0,
  confidence: 0, reasoning: exitReason,
  signals: [], models: [],
  orderId: exitResult.orderId || '', proposalId: '',
});
```
- [ ] **Step 3:** Verify by checking Postgres after deploy: `SELECT * FROM alphanix_trades WHERE side='SELL' LIMIT 5`
- [ ] **Step 4:** Commit

---

### Task 5: Wire Sentiment to QuantAgents

**Files:**
- Read: `packages/agents/src/alphanix/pod/quant-agent.ts` — find `setSentimentBoost()` method
- Modify: `packages/agents/src/alphanix/alphanix-agent.ts` — call setSentimentBoost after swarm results

- [ ] **Step 1:** Read `quant-agent.ts` — find the `setSentimentBoost` method signature
- [ ] **Step 2:** Read swarm workers — find where they publish results (Redis keys)
- [ ] **Step 3:** In the orchestrator tick (after swarm run), read swarm results from Redis and call `pod.getQuant().setSentimentBoost(score)` for each pod
- [ ] **Step 4:** Commit

---

### Task 6: Fix Nordic SL Churn

**Files:**
- Modify: `packages/agents/src/alphanix/pod/pod.ts` (exit-monitor config, ~line 47-53)
- Optionally: `alphanix.toml` per-pod exit config

Nordic stocks have different volatility than crypto. The exit-monitor uses hardcoded 3% SL / 5% TP for all pods. Nordic large-caps need wider SL.

- [ ] **Step 1:** Read `pod.ts` constructor lines 47-53 — exit-monitor config is hardcoded
- [ ] **Step 2:** Change to read from pod config or use asset-class defaults:
```typescript
const isStock = adapter.assetClass === 'stock';
const isNordic = config.id.includes('nordic');
this.exitMonitor = new ExitMonitor({
  takeProfitPct: isNordic ? 8.0 : isStock ? 6.0 : 5.0,
  stopLossPct: isNordic ? 5.0 : isStock ? 4.0 : 3.0,
  trailingStopActivation: isNordic ? 4.0 : isStock ? 3.0 : 2.0,
  trailingStopDistance: isNordic ? 3.0 : isStock ? 2.0 : 1.0,
  stagnationHours: isNordic ? 120 : isStock ? 72 : 48,
});
```
- [ ] **Step 3:** Verify by checking logs — Nordic pods should stop immediate SL exits
- [ ] **Step 4:** Commit

---

## Deployment

After all 6 tasks:
```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build alphanix alphanix-brain"
```

## Verification Checklist

- [ ] Redis `alphanix:pod:crypto_dip_hunter:positions` shows non-zero entryPrice
- [ ] Brain logs show successful data collection (no JSON parse errors)
- [ ] Redis `alphanix:swarm:*` keys exist (macro, sentiment, etc.)
- [ ] Postgres `alphanix_trades` has SELL rows
- [ ] Nordic pods hold positions > 1 minute before exiting
- [ ] Dashboard `/alphanix` shows real position P&L
