# Comprehensive Code Review Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Dispatch each task as a parallel review agent using `isolation: "worktree"` since they read different files.

**Goal:** Audit all ~40 commits from the past 3 days on a LIVE trading system ($36 real money) to catch security issues, logic bugs, edge cases, and data integrity problems before they cause financial loss.

**Architecture:** 4 parallel review agents, each focused on a different subsystem. Each agent reads specific files, checks against a review checklist, and reports findings. Fixes are applied after all reviews complete.

**Tech Stack:** TypeScript (Next.js), Python (FastAPI), Redis, Docker, Binance CCXT

---

## Review Task 1: Critical Trading Logic (auto-trade/route.ts)

**Priority:** HIGHEST — This file executes real trades on Binance.

**Files to review:**
- `apps/web/src/app/api/auto-trade/route.ts` (entire file, ~4500 lines)

**Checklist:**

- [ ] **1.1: Multiplicative confidence model (lines ~3600-3950)**
  - Verify `pickMaxAbs()` returns the modifier with largest absolute value, not just largest
  - Check: if ALL group modifiers are negative, does the formula still clamp to [0, 0.95]?
  - Check: can `(1 + modA) * (1 + modB) * (1 + modC)` ever produce negative confidence?
  - Verify additive fallback path (mode="additive") still works and preserves old behavior

- [ ] **1.2: HTF trend filter (lines ~2198-2220)**
  - Verify DIP_BUY and DEEP_VALUE_CRASH are correctly exempted
  - Check: what happens when `htf_trend` is "unknown" or null? Should it penalize or skip?
  - Verify the penalty is applied BEFORE the confidence threshold check

- [ ] **1.3: DCA/Pyramiding (lines ~2076-2110)**
  - Check: can a second entry bypass the budget check that follows?
  - Verify `existingPositions[0].entryPrice` is never 0 (division by zero in priceDiffPct)
  - Check: does `budget.totalCapital` correctly reflect current capital including open positions?
  - Verify max exposure check uses actual current exposure, not just the new order

- [ ] **1.4: Smart Rotation (lines ~1760-1870)**
  - Check: all rotation-eligible paths (budget exhausted, max positions, max signal positions)
  - Verify rotation doesn't trigger on positions held < 30 minutes
  - Check: what happens if rotation close fails but the signal was already removed from queue?

- [ ] **1.5: Dynamic SL (lines ~1300-1320)**
  - Verify SL can only move UP (tighten), never down
  - Check: `fetchCurrentATR()` cache TTL — is 60s appropriate?
  - Verify the 0.5% per-cycle guard uses entry price, not current price

- [ ] **1.6: AI Fast-Track (lines ~3781-3795)**
  - SECURITY: Can a manipulated signal with fake 80%+ confidence skip AI validation?
  - Check: does the multi-pattern check (`patterns.length >= 2`) prevent gaming?
  - Verify fast-tracked signals still get proper confidence blending

- [ ] **1.7: Kill Rate phantom tracking (lines ~2628-2730)**
  - Check: `rpush` + `ltrim` ordering — do oldest entries survive to the 4h check?
  - Verify `checkPhantomResults()` doesn't create unbounded API calls (rate limit = 10/cycle)
  - Check: phantom results list — is 500 cap sufficient? Any TTL?

- [ ] **1.8: Post-trade analysis (lines ~2530-2610)**
  - Verify `pos.indicators` is populated when position was created (check executeBuy)
  - Check: does `fetchCurrentATR()` in post-trade context work for all symbols?

- [ ] **1.9: Dust prevention (lines ~1049-1058)**
  - Verify dust threshold uses pair notional ($5 × 1.5 = $7.50), NOT MIN_ORDER_VALUE ($15)
  - Check: can a position slip below $5 (actual Binance notional) without being caught?

- [ ] **1.10: Cross-instance intelligence (lines ~3850-3960)**
  - Check: all Redis reads have try/catch and don't block trading on unavailable data
  - Verify JSON.parse errors are caught for each external data source
  - Check: equity market correlation — what if `psinix:equity:spy` has stale data (>1h)?

---

## Review Task 2: Python Engine + New Services

**Priority:** HIGH — Engine generates all trading signals.

**Files to review:**
- `packages/engine/src/tanks/news_scout.py`
- `packages/engine/src/tanks/market_scout.py`
- `packages/engine/src/tanks/liquidation_scout.py`
- `packages/engine/src/guilds/quant.py`
- `packages/engine/src/main.py`
- `scripts/services/signal-worker.mjs`
- `scripts/services/cvd-monitor.mjs`

**Checklist:**

- [ ] **2.1: NewsScout AI enrichment**
  - Check: `grok-3-mini` model name — is it valid? Should it be `grok-4-1-fast-reasoning`?
  - Verify: `!` prefix parsing for urgency — what if AI returns `"!abc"` (non-numeric)?
  - Check: headline batch size (10) × title length (100) — does it fit in 200 max_tokens?

- [ ] **2.2: Market Scout 5m fast scan**
  - Check: does fast scan only run when 15m returns HOLD? (code says `if signal['action'] != 'BUY'`)
  - Verify: fast scan signals override `trading_signal` dict — are all required fields set?
  - Check: signal cooldown applies to fast scan signals? Or can they spam the queue?

- [ ] **2.3: Liquidation Scout WebSocket**
  - Check: reconnection logic — does it handle `websockets.exceptions.ConnectionClosed`?
  - Verify: aggregation window (5 min) — are events correctly evicted?
  - Check: Redis write interval (30s) — is it possible to miss a cascade between writes?

- [ ] **2.4: CVD Monitor**
  - Check: `isBuyerMaker` interpretation — Binance docs say `true` = buyer is maker = taker SELL
  - Verify: divergence detection thresholds (-0.1% / +0.1%) — is this too sensitive?
  - Check: memory growth — trade buffers eviction (20 min) — is this sufficient?

- [ ] **2.5: Signal Worker (push architecture)**
  - CRITICAL: `processing` flag — is it safe? What if fetch hangs forever?
  - Check: fallback 60s poll — does it also set `processing = true`?
  - Verify: no duplicate execution — instance lock in auto-trade prevents this?

- [ ] **2.6: quant.py price_change_4h**
  - Check: `close.iloc[-17]` — what if DataFrame has exactly 17 rows? Off-by-one?
  - Verify: this is correctly mapped to `signal.indicators.price_change_4h` in market_scout

---

## Review Task 3: Polynix + Copynix Agent Changes

**Priority:** MEDIUM — Paper trading, but Polynix generates real profit tracking.

**Files to review:**
- `packages/agents/src/polynix/whale-detector.ts`
- `packages/agents/src/polynix/polynix-agent.ts`
- `packages/agents/src/polynix/types.ts`
- `packages/agents/src/polynix/config.ts`
- `packages/agents/src/polynix/market-scanner.ts`
- `packages/agents/src/polynix/spread-detector.ts`
- `packages/agents/src/polynix/directional-engine.ts`
- `packages/agents/src/polynix/risk-manager.ts`
- `packages/agents/src/polynix/position-tracker.ts`
- `packages/agents/src/copynix/copynix-agent.ts`
- `packages/agents/src/copynix/wallet-monitor.ts`

**Checklist:**

- [ ] **3.1: Whale Detector**
  - Check: `totalDepth()` calculation — is `price * size` the right metric? Or just `size`?
  - Verify: MIN_ASYMMETRY (5x) — is this calibrated? Could produce false positives on thin books?
  - Check: confidence formula — can it exceed 95? (capped at 95 in code)

- [ ] **3.2: Polynix agent whale integration**
  - Check: whale detection runs on EVERY directional market scan — performance impact?
  - Verify: `lastWhaleSignals` array — bounded to 20, but is conditionId dedup correct?
  - Check: whale boost applied BEFORE risk check — does this affect sizing?

- [ ] **3.3: Market scanner JSON parsing**
  - Verify: `outcomes` JSON string parsing handles malformed data gracefully
  - Check: `extractTokenIds()` — does it handle missing `tokens` AND missing `clobTokenIds`?

- [ ] **3.4: Copynix Smart Money bridge**
  - Check: `SOLANA_TO_CEX` mapping — are all mappings correct? Missing any?
  - Verify: Smart Money data TTL (5 min via StatePublisher) — is this appropriate?
  - Check: `enrichTradePrices()` — does DexScreener batch query work for 20+ mints?

---

## Review Task 4: Config + Infrastructure + Data Integrity

**Priority:** MEDIUM — Config errors can cause silent failures.

**Files to review:**
- `cryonix.toml` (full file)
- `polynix.toml` (full file)
- `docker-compose.prod.yml`
- `Dockerfile.scripts`
- `Dockerfile.polynix`
- `apps/web/src/lib/trading/bayesian.ts`
- `scripts/strategy-lab/metrics.py`

**Checklist:**

- [ ] **4.1: cryonix.toml consistency**
  - Verify: SL=8 ATR, TP=10 ATR → R/R = 1.25 > min_risk_reward (1.2) ✓
  - Check: `max_position_size_pct = 0.45` × $36 = $16.20 > min_order $15 ✓
  - Verify: `signal_pool_pct + scalp_pool_pct + reserve_pct = 0.85 + 0 + 0.15 = 1.0` ✓
  - Check: `min_trades_for_ev = 50` — appropriate given 54 total trades?
  - Check: all new sections ([dca], [htf_filter], [confidence_model], [bayesian], [sizing]) have defaults in code

- [ ] **4.2: Redis key inventory**
  - List ALL Redis keys written by our changes — verify TTLs are set
  - Check: `phantom:rejected` — now unbounded (rpush + safety cap at 2000) — OK?
  - Check: `phantom:results` — ltrim 0 499 — appropriate?
  - Check: `metrics:kill_rate` — 24h TTL — appropriate?
  - Check: `cryonix:post_trade_analyses` — 7d TTL, max 20 entries — OK?
  - Check: `cvd:*` — 2 min TTL — will data be stale between writes (15s)?
  - Check: `liquidation:*` — 10 min TTL — appropriate?
  - Check: `smartmoney:flow:*` — 5 min TTL via StatePublisher — appropriate?

- [ ] **4.3: Docker infrastructure**
  - Check: signal-worker depends_on web (healthy) — what if web restarts?
  - Check: cvd-monitor has no healthcheck — should it?
  - Verify: Dockerfile.scripts copies all required .mjs files
  - Check: docker-compose new services have proper restart policies

- [ ] **4.4: Bayesian softmax bug fix**
  - Verify: `sig.confidence` (0-1 range) is now used correctly instead of `sig.confidence / 100`
  - Check: when all priors have n < MIN_OBSERVATIONS, does softmax degrade gracefully?

- [ ] **4.5: metrics.py**
  - Check: SQL injection risk in `%s` interpolation (uses `%` operator, not parameterized)
  - Verify: ECR calculation — `theoretical_max` based on HWM only, not full market move
  - Check: Alpha Decay — handles missing/null patterns_json gracefully?
