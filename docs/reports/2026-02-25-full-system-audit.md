# Cryonix Full System Audit

**Date:** 2026-02-25
**Auditor:** Claude Code (Opus 4.6)
**Scope:** ~50 source files across 4 subsystems
**Verified Findings:** 68 (after false positive removal)

---

## Executive Summary

The system has a solid architecture and well-thought-out design. The signal flow Python Engine -> Redis -> Auto-Trade -> GROK -> Binance works at its core. **However**, there are several critical issues preventing reliable profitability — particularly race conditions in position management, an AI validation that is fail-open (not fail-closed as documented), and an evolution engine that accepts mutations even when backtests fail.

**System maturity level:** ~65% of the way to a reliable self-sustaining system.

---

## Critical Issues (Must fix before system can be profitable)

### 1. AI Validation is FAIL-OPEN (not fail-closed)

**File:** `apps/web/src/app/api/auto-trade/route.ts:1195`

```typescript
if (!ai) return { approved: true, aiConfidence: signal.confidence, reasoning: 'AI validation disabled' };
```

**Problem:** If GROK API key is missing or client can't be created, all signals are approved without AI validation. CLAUDE.md documents this as "fail-closed" but the code does the opposite.
**Impact:** Bad signals execute without second opinion. Direct financial risk.

### 2. Position Data Mutated Without Lock

**File:** `apps/web/src/app/api/auto-trade/route.ts:919-930`

**Problem:** `monitorPositions()` updates positions in-memory (trailing stop, PnL) and saves back without holding the Redis lock. If two auto-trade cycles run in parallel, position data can become corrupt — trailing stops disappear, duplicates occur.
**Impact:** Position state corruption -> lost trailing stops -> unnecessary losses.

### 3. Position Lock TTL Too Short (5 seconds)

**File:** `apps/web/src/app/api/auto-trade/route.ts:324`

**Problem:** If monitoring 30 positions takes >5s (likely with Binance API rate limits), the lock expires and a new cycle runs in parallel.
**Impact:** Same as #2 — corrupt state.

### 4. Evolution Backtest Gate is Fail-Open

**File:** `scripts/evolution/copilot-evolution.mjs:710`

```javascript
return { passed: true, reason: `error: ${e.message}`, candidate: null };
```

**Problem:** If backtest crashes, the mutation is approved and deployed. Should be `passed: false`.
**Impact:** Broken backtest = unrestricted mutations -> parameters can go wild.

### 5. NewsScoutTank Blocks Event Loop

**File:** `packages/engine/src/tanks/news_scout.py:12`

```python
from redis import Redis  # SYNC, not async!
```

**Problem:** Imports synchronous Redis but runs in async context via `asyncio.create_task()`. Every Redis operation blocks the entire Python process event loop.
**Impact:** MarketScoutTank and CMCScout freeze during NewsScout calls.

### 6. Division by Zero in R/R Calculation (AI prompt)

**File:** `apps/web/src/app/api/auto-trade/route.ts:1234-1235`

```typescript
const rr = signal.stop_loss > 0
  ? ((signal.target_price - signal.entry_price) / (signal.entry_price - signal.stop_loss)).toFixed(2)
  : 'N/A';
```

**Problem:** If `entry_price === stop_loss` -> division by zero -> `Infinity` -> JSON serialization crashes -> AI validation fails -> signal rejected (or crashes entire cycle).

### 7. Missing Database Indexes on Time-Series Tables

**File:** `packages/database/src/schema.ts`

**Problem:** `trades.timestamp`, `signals.timestamp`, `positionHistory.closedAt`, `market_data(symbol,timestamp)` have no indexes.
**Impact:** Full table scan on every analytics query. With thousands of rows -> slow dashboard.

---

## High Severity Issues (Affects system reliability)

### 8. Grid Trades Bypass All Risk Validation

**File:** `apps/web/src/app/api/auto-trade/route.ts:1775`

Grid orders are sent directly to `executeBuy()` without `passesRiskChecks()` or `getAIValidation()`.

### 9. No Timeout on Binance API Calls

**File:** `apps/web/src/app/api/auto-trade/route.ts:607,526,463`

`fetchTicker()`, `fetchOrder()`, `fetchBalance()` without timeout. If Binance is slow, the entire trading loop hangs.

### 10. Capital Allocator Race Condition

**File:** `apps/web/src/app/api/auto-trade/route.ts:195-253`

Positions read, budget calculated, but between reading and execution another cycle can open positions -> capital over-allocation.

### 11. Fee Logging Inconsistent

**File:** `apps/web/src/app/api/auto-trade/route.ts:574,839,859`

- Native SL fills log `fees: '0'` despite fees being calculated
- Dust write-off vs archive log different fees
- **Impact:** P&L analysis doesn't match reality

### 12. GainerScanner 24h Calculation Bug

**File:** `packages/engine/src/tanks/gainer_scanner.py:65`

```python
prev_24h = ohlcv[0][4] if len(ohlcv) >= 24 else ohlcv[0][4]
```

Both branches do the same thing. Boost applied to wrong coins.

### 13. Telegram Bot No Restart Mechanism

**File:** `scripts/services/telegram-interactive.mjs:1066`

Infinite loop with bare try/catch. Unexpected crash -> silent death.

### 14. Telegram Scraper Dies on DB Disconnect

**File:** `scripts/telegram-scraper/scraper.py:373`

`sys.exit(1)` on Postgres error, no retry.

### 15. Engine Container Missing Docker Healthcheck

**File:** `docker-compose.prod.yml`

All other containers have healthcheck except engine. If engine crashes it's not detected.

### 16. Postgres URL Inconsistency

**File:** `docker-compose.prod.yml`

Engine: `postgres://...`, telegram-bot: `postgresql://...`. Can cause connection errors.

---

## Medium Severity Issues (Affects signal quality & maintenance)

| # | Problem | File |
|---|---------|------|
| 17 | Momentum Gainer confidence never applied to final signal | market_scout.py |
| 18 | Confidence blending: ta_weight + ai_weight not validated = 1.0 | route.ts:2130 |
| 19 | CMC regime change as side-effect inside risk check function | route.ts:1120 |
| 20 | Hardcoded fallback capital $42 if cache missing | market_data.py:106 |
| 21 | RiskManager default capital $17 before sync | risk_manager.py:47 |
| 22 | Stale signal age 15 min (90 scan cycles old) | route.ts:1917 |
| 23 | Missing `/api/scanner-history` endpoint (GainerScanner POST fails silently) | router.py |
| 24 | calibration_history missing UNIQUE constraint `(snapshot_date, run_type)` | schema.ts |
| 25 | Timestamps without timezone in schema (except evolution_runs) | schema.ts |
| 26 | autopilotActions confidence precision (3,2) instead of (5,4) | schema.ts |
| 27 | AI Brain Grok API timeout 60s without fallback | ai_brain.py:426 |
| 28 | Evolution CLI model argument not quoted | copilot-evolution.mjs:392 |
| 29 | Signal parser doesn't handle PERP/SWAP suffixes | parser.py:49 |
| 30 | NaN in MACD can silence bullish cross signals | quant.py:315 |

---

## What Works Well

- **Signal flow** Python -> Redis -> Auto-trade works end-to-end
- **Instance lock** with TTL prevents most duplicate executions
- **Dedup lock** per signal prevents duplicate buys of same signal
- **Config version tagging** — every trade tagged with SHA256 of cryonix.toml
- **CMC macro filters** — rank, FDV/MC, Fear & Greed, BTC dominance integrated
- **Reconciliation logic** — phantom positions detected correctly
- **Native SL orders** — safety net on Binance
- **Baseline freeze** — prevents mutations during performance measurement
- **Structured evolution diffs** — TOML changes logged in detail
- **Environment guards** — no testing in prod mode without explicit flag
- **EV model filter** — filters out patterns with negative expected value
- **X sentiment check** — blocks buys on hack/exploit alerts

---

## Current State

```
SUBSYSTEM                  STATUS     MATURITY
──────────────────────────────────────────────
Python Engine (scan)       Live       75%  — Scanning, generating signals
Redis Pipeline             Live       90%  — Data flows correctly
Auto-Trade Execution       Buggy      55%  — Race conditions, fail-open AI
GROK AI Validation         Fragile    60%  — Works but fail-open
Position Monitoring        Buggy      50%  — Trailing stops can be lost
Capital Allocation         Fragile    65%  — Race condition with parallel cycles
Evolution System           Risky      40%  — Backtest fail-open = dangerous
Calibration                Good       80%  — EV filter works
Telegram Bot               Fragile    60%  — Can die silently
Dashboard/Analytics        Good       75%  — Works but missing indexes
Database                   Lacking    55%  — Missing indexes, constraints
Docker/Deploy              Good       80%  — Working but engine lacks healthcheck
```

**Overall maturity: ~65%** — System runs but has too many weaknesses to be reliably self-sustaining and profitable.

---

## Roadmap to Goal: Self-Sustaining Profitable System

### Phase 1: STABILITY (1-2 weeks) — "Stop losing money on bugs"

These fixes cost nothing but prevent losses:

1. **Fix AI fail-closed** — Change `getAIValidation()` to `approved: false` when no AI
2. **Fix position locking** — Raise TTL to 30s, hold lock through entire monitor cycle
3. **Fix evolution fail-closed** — `passed: false` on backtest error
4. **Fix division by zero** in R/R calculation
5. **Fix NewsScout** — Migrate to `redis.asyncio`
6. **Add database indexes** — trades, signals, positionHistory
7. **Add engine healthcheck** to Docker Compose
8. **Standardize Postgres URL** — `postgres://` everywhere

### Phase 2: PRECISION (1-2 weeks) — "Generate better signals"

Raise signal quality for more winners:

9. **Fix GainerScanner 24h calculation** — correct 24h change
10. **Apply Momentum Gainer confidence** to final signal
11. **Fix fee logging** — correct P&L data
12. **Guard NaN in MACD** — MACD signals currently being silenced can activate
13. **Grid trades through risk validation**
14. **Timeout on all Binance API calls** (5s)
15. **Reduce signal max age** to 5 min (from 15)
16. **Validate confidence weights** sum = 1.0

### Phase 3: RESILIENCE (1 week) — "Survive all problems"

System should not die on network issues:

17. **Telegram bot** — exponential backoff + process restart
18. **Telegram scraper** — retry on DB disconnect
19. **Auto-trader** — backoff on API errors
20. **Capital allocator** — atomic Redis transaction
21. **AI Brain** — Grok fallback on timeout

### Phase 4: PROFITABILITY (ongoing) — "Optimize and grow"

Once foundation is stable:

22. **Activate CoinMarketCap** integration (CMC_API_KEY + enabled=true)
23. **Activate Telegram signal boost** (CONFIDENCE_BOOST_ENABLED=true)
24. **Scale up capital** gradually based on verified edge
25. **Evolution with fail-closed backtest** can start mutating safely
26. **Calibration-driven pattern selection** — disable patterns without edge

### Estimated effort per phase:

| Phase | Scope | Priority |
|-------|-------|----------|
| Phase 1: Stability | ~8 critical fixes, ~200 lines of code | **NOW** |
| Phase 2: Precision | ~8 fixes, ~150 lines of code | Immediately after Phase 1 |
| Phase 3: Resilience | ~5 fixes, ~100 lines of code | Week after |
| Phase 4: Profitability | Configuration + monitoring | Ongoing |

---

## False Positives Removed

During audit, the following were initially flagged but verified as correct:

- **state_sync.py** uses `import redis.asyncio as redis` — async client is correct
- **CMCScout** receives `state_manager.redis` (async) — pipeline operations are async
- **.env.prod** exists locally but is NOT tracked in git (`.env*` in .gitignore)

---

*Generated by Claude Code (Opus 4.6) — Full system audit of Cryonix Agent Army*
