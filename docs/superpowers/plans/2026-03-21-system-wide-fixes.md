# System-Wide Audit Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 5 production problems identified in the 2026-03-21 deep audit across Cryonix, Copynix, Aktienix, and infrastructure (Telegram).

**Architecture:** Each fix is isolated to one subsystem with no cross-dependencies, so all 5 tasks can execute in parallel. Changes are config-level or small code patches — no architectural refactors.

**Tech Stack:** TypeScript (agents), Python (engine), TOML (configs), Docker Compose (infrastructure)

---

## File Map

```
MODIFY  cryonix.toml                                          # Task 1: R/R threshold + ATR
MODIFY  copynix.toml                                          # Task 2: Safety thresholds
MODIFY  packages/agents/src/copynix/bayesian-scorer.ts         # Task 2: Demotion asymmetry
MODIFY  aktienix.toml                                          # Task 3: Signal floor + SL width
MODIFY  packages/agents/src/aktienix/signals/stock-signal-generator.ts  # Task 3: RSI logic
MODIFY  docker-compose.prod.yml                                # Task 4: Telegram restart policy
MODIFY  apps/web/src/app/api/auto-trade/route.ts               # Task 5: R/R debug logging
```

---

## Task 1: Cryonix — Unblock R/R Rejections

**Problem:** Auto-trader rejects ALL signals — engine produces R/R 0.92–1.38, but threshold on VM is 1.5 (despite config showing 1.2). ATOM, UNI, LINK all rejected 40+ times/hour.

**Root cause:** ATR multipliers give theoretical R/R of 10/8=1.25, but real R/R drops below this due to price drift between signal generation and execution. The threshold (likely modified by AI Brain or cached) is too high for current market conditions.

**Files:**
- Modify: `cryonix.toml` (lines 227, 310-311)
- Modify: `apps/web/src/app/api/auto-trade/route.ts` (line ~2177, add debug log)

- [ ] **Step 1: SSH to VM and verify actual runtime min_risk_reward**

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-web-1 node -e \"
  const fs = require('fs');
  const toml = require('@iarna/toml');
  const cfg = toml.parse(fs.readFileSync('/app/cryonix.toml','utf8'));
  console.log('min_risk_reward:', cfg.risk?.min_risk_reward);
  console.log('sl_atr:', cfg.exits?.sl_atr_multiplier);
  console.log('tp_atr:', cfg.exits?.tp_atr_multiplier);
\""
```

Expected: Reveals the actual parsed value causing `< 1.5` in logs.

- [ ] **Step 2: Fix cryonix.toml — lower R/R threshold + widen TP/SL ratio**

In `cryonix.toml`:
```toml
# Line 227: Lower threshold to match ATR ratio
min_risk_reward = 1.0

# Lines 310-311: Widen TP ratio for better R/R
sl_atr_multiplier = 6.0    # was 8.0 — tighter SL
tp_atr_multiplier = 10.0   # keep at 10.0
# New ratio: 10.0/6.0 = 1.67 R/R — comfortably above 1.0
```

**Rationale:**
- Current ATR R/R: 10/8 = 1.25, barely above 1.2 threshold
- After fix: 10/6 = 1.67, well above 1.0 threshold
- Tighter SL (6x ATR) means smaller losses per trade
- Lower threshold (1.0) prevents blocking — quality ensured by other gates (confidence, HTF filter, dip focus)

- [ ] **Step 3: Add R/R debug logging to auto-trade route**

In `apps/web/src/app/api/auto-trade/route.ts`, after the R/R check (~line 2175):
```typescript
const risk = Math.abs(signal.entry_price - signal.stop_loss);
const reward = Math.abs(signal.target_price - signal.entry_price);
const minRR = TOML?.risk?.min_risk_reward ?? 1.3;
// Debug: log every R/R check so we can see distribution
console.log(`[R/R] ${signal.symbol}: reward=${reward.toFixed(6)} risk=${risk.toFixed(6)} R/R=${risk > 0 ? (reward/risk).toFixed(2) : 'N/A'} threshold=${minRR}`);
```

- [ ] **Step 4: Deploy and verify signals start passing**

```bash
# Copy files to VM
tar cf - cryonix.toml apps/web/src/app/api/auto-trade/route.ts | \
  ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"

# Rebuild web container (auto-trader uses web API)
ssh azureuser@openclaw-vm "cd ~/cryonix && \
  docker compose -f docker-compose.prod.yml up -d --build web"

# Wait 2 min, then check logs
ssh azureuser@openclaw-vm "docker logs cryonix-auto-trader-1 --tail 20"
```

Expected: Signals start showing `[R/R]` debug lines instead of rejections.

- [ ] **Step 5: Commit**

```bash
git add cryonix.toml apps/web/src/app/api/auto-trade/route.ts
git commit -m "fix(cryonix): lower R/R threshold 1.5→1.0 + tighten SL ATR 8→6

Audit showed ALL signals rejected for 24h due to R/R < threshold.
ATR ratio 10/8=1.25 was borderline. New 10/6=1.67 gives safe margin.
Added R/R debug logging for future diagnosis."
```

---

## Task 2: Copynix — Stop Memecoin Losses

**Problem:** Copynix bought HelloWorld!, HELLO, RULEBOOK (garbage memecoins) and lost $78. Safety thresholds are too loose: `min_token_age_hours=0`, `min_liquidity_usd=5000`, `min_holders=0`.

**Files:**
- Modify: `copynix.toml` (lines 131-139)
- Modify: `packages/agents/src/copynix/bayesian-scorer.ts` (lines 60-73)

- [ ] **Step 1: Tighten safety thresholds in copynix.toml**

```toml
[safety]
min_token_age_hours = 12          # was 0 — require 12h history
min_liquidity_usd = 50000         # was 5000 — require $50K liquidity
min_holders = 100                 # was 0 — require 100+ holders
min_lp_burnt_pct = 0              # keep 0 (not all tokens burn LP)
require_immutable_supply = false  # keep false
max_fdv_liquidity_ratio = 50     # NEW — reject if FDV/Liq > 50x (rug indicator)
```

- [ ] **Step 2: Fix Bayesian scorer asymmetry**

In `packages/agents/src/copynix/bayesian-scorer.ts`, change promotion/demotion thresholds:

```typescript
// Old values — too easy to promote, too hard to demote
// const MIN_TRADES_PROMOTE = 8;
// const MIN_TRADES_DEMOTE = 20;

// New values — symmetric, faster demotion
const MIN_TRADES_PROMOTE = 10;   // was 8 — need more evidence to promote
const MIN_TRADES_DEMOTE = 10;    // was 20 — demote faster on bad streaks
```

- [ ] **Step 3: Update risk-gate to use configurable max FDV/Liq ratio**

In `packages/agents/src/copynix/risk-gate.ts`:

Add `maxFdvLiquidityRatio` field to the class (line 14) and constructor (line 22):

```typescript
// Add to class fields (after line 14):
private maxFdvLiquidityRatio: number;

// Update constructor interface (add to config type):
constructor(config: {
    min_token_age_hours: number;
    min_liquidity_usd: number;
    min_holders: number;
    min_lp_burnt_pct: number;
    require_immutable_supply: boolean;
    max_fdv_liquidity_ratio?: number;  // NEW
}) {
    // ... existing assignments ...
    this.maxFdvLiquidityRatio = config.max_fdv_liquidity_ratio ?? 50;
}
```

Then update the FDV/Liq check at line 82:

```typescript
// Old:
// if (ratio > 100) {
// New:
if (ratio > this.maxFdvLiquidityRatio) {
    safe = false;
    reasons.push(`FDV/Liq ratio suspicious: ${ratio.toFixed(0)}x (max ${this.maxFdvLiquidityRatio}x)`);
}
```

- [ ] **Step 4: Deploy copynix**

```bash
tar cf - copynix.toml packages/agents/src/copynix/ | \
  ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && \
  docker compose -f docker-compose.prod.yml up -d --build copynix"
ssh azureuser@openclaw-vm "docker logs cryonix-copynix-1 --tail 20"
```

Expected: Copynix restarts, logs show new safety thresholds loaded.

- [ ] **Step 5: Commit**

```bash
git add copynix.toml packages/agents/src/copynix/bayesian-scorer.ts \
        packages/agents/src/copynix/risk-gate.ts
git commit -m "fix(copynix): tighten safety thresholds to block memecoin rugs

min_token_age 0→12h, min_liquidity $5K→$50K, min_holders 0→100,
max_fdv_liq_ratio 100→50x. Bayesian demotion 20→10 trades (symmetric).
Prevents HelloWorld/HELLO/RULEBOOK type losses."
```

---

## Task 3: Aktienix — Fix Signal Quality + Exit Strategy

**Problem:** 14% WR, -$1,158 on 7 trades. Root causes: 0.10 confidence floor (single RSI triggers), 3% SL too tight for high-IV stocks, inverted downtrend RSI logic.

**Files:**
- Modify: `aktienix.toml` (lines 174-179, 267-297)
- Modify: `packages/agents/src/aktienix/signals/stock-signal-generator.ts` (lines 140-163, 232-243)

- [ ] **Step 1: Raise signal floor and widen SL in aktienix.toml**

```toml
# Line 179: Raise minimum signal score
min_signal_score = 0.35           # was 0.10 — require 2+ confirming factors

# Line 272: Widen stop-loss for stock volatility
stop_loss_pct = 5.0               # was 3.0 — stocks need more room
trailing_stop_pct = 3.0           # was 2.0 — wider trail
trailing_activation_pct = 4.0    # was 3.0 — activate later
```

- [ ] **Step 2: Penalize RSI score in downtrends (stock-signal-generator.ts)**

RSI thresholds stay the same (they correctly require deeper oversold in downtrends). The fix is to **halve the score awarded** when trend is down — prevents catching falling knives.

In `packages/agents/src/aktienix/signals/stock-signal-generator.ts`, around line 151-153, change:

```typescript
// OLD:
if (indicators.rsi14 < oversold) {
    buyScore += 0.25;
    reasoning.push(`RSI oversold (${indicators.rsi14.toFixed(1)}, threshold ${oversold})`);
}

// NEW: half credit in downtrend
if (indicators.rsi14 < oversold) {
    const downtrendPenalty = structure.trend === 'downtrend' ? 0.5 : 1.0;
    buyScore += 0.25 * downtrendPenalty;
    reasoning.push(`RSI oversold (${indicators.rsi14.toFixed(1)}, threshold ${oversold})${structure.trend === 'downtrend' ? ' [downtrend: half credit]' : ''}`);
}
```

- [ ] **Step 3: Add volume confirmation requirement**

In `stock-signal-generator.ts`, after the RSI scoring block (~line 163), add a gate using the existing `structure.volumeState` property (NOT `indicators.volumeRatio` which doesn't exist):

```typescript
// Require volume confirmation for single-factor RSI signals
if (buyScore > 0 && buyScore <= 0.25 && structure.volumeState !== 'high') {
    buyScore = 0;  // Reset: RSI without volume is noise
    reasoning.push('RSI signal cancelled: no volume confirmation (volumeState=' + structure.volumeState + ')');
}
```

- [ ] **Step 4: Deploy aktienix**

```bash
tar cf - aktienix.toml packages/agents/src/aktienix/ | \
  ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && \
  docker compose -f docker-compose.prod.yml up -d --build aktienix"
ssh azureuser@openclaw-vm "docker logs aktienix --tail 20"
```

Expected: Aktienix restarts with new config. Fewer signals but higher quality.

- [ ] **Step 5: Commit**

```bash
git add aktienix.toml packages/agents/src/aktienix/signals/stock-signal-generator.ts
git commit -m "fix(aktienix): raise signal floor 0.10→0.35 + widen SL 3→5%

14% WR caused by: single-factor RSI entries, tight 3% SL on high-IV stocks,
full scoring credit in downtrends. Fix: require 2+ factors (0.35 floor),
half RSI credit in downtrends, volume confirmation gate, 5% SL for room."
```

---

## Task 4: Telegram — Fix Restart Loops

**Problem:** `telegram-bot` and `telegram-scraper` containers are in restart loops (exit code 1). Both crash on missing env vars.

**Root cause:** `TELEGRAM_INTERACTIVE_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION` are not set in VM `.env`.

**Files:**
- Modify: `docker-compose.prod.yml` (telegram-bot and telegram-scraper services)

- [ ] **Step 1: Check which Telegram env vars exist on VM**

```bash
ssh azureuser@openclaw-vm "grep -c TELEGRAM ~/cryonix/.env 2>/dev/null || echo 'no .env'"
ssh azureuser@openclaw-vm "grep TELEGRAM ~/cryonix/.env 2>/dev/null | sed 's/=.*/=***/' || echo 'none set'"
```

- [ ] **Step 2: Change restart policy to prevent CPU-wasting restart loops**

In `docker-compose.prod.yml`, for both telegram services:

```yaml
  telegram-bot:
    # ...
    restart: "no"          # was: always — prevent restart loop when env vars missing
    # ...

  telegram-scraper:
    # ...
    restart: "no"          # was: always — prevent restart loop when env vars missing
    # ...
```

**Alternative:** If Telegram tokens ARE available on VM, keep `restart: unless-stopped` but add healthcheck:

```yaml
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "pgrep", "-f", "telegram"]
      interval: 60s
      timeout: 10s
      retries: 3
      start_period: 30s
```

- [ ] **Step 3: Stop the restart-looping containers on VM**

```bash
ssh azureuser@openclaw-vm "cd ~/cryonix && \
  docker compose -f docker-compose.prod.yml stop telegram-bot telegram-scraper"
```

- [ ] **Step 4: Deploy compose change**

```bash
tar cf - docker-compose.prod.yml | \
  ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && \
  docker compose -f docker-compose.prod.yml up -d"
```

Expected: Telegram containers stay stopped. No more restart spam in `docker ps`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "fix(infra): stop telegram restart loops when env vars missing

Changed restart policy to 'no' for telegram-bot and telegram-scraper.
These require TELEGRAM_* env vars that aren't currently set on VM.
Prevents CPU waste from infinite restart cycles."
```

---

## Task 5: Verify APEX + ORAKEL Integration

**Problem:** APEX has 0 trades. This is CORRECT behavior in a sideways market with no confluence — but we should verify the signal pipeline is actually flowing.

**Files:** No code changes — verification only.

- [ ] **Step 1: Verify APEX reads all signal sources**

```bash
curl -s http://openclaw-vm/api/apex/status | python3 -m json.tool
```

Expected: All sources in `staleness` dict. `orakel: false` confirms ORAKEL integration works.

- [ ] **Step 2: Manually inject a test signal to verify scoring works**

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli SET trades:pending \
  '{\"symbol\":\"BTC/USDC\",\"action\":\"BUY\",\"confidence\":85,\"patterns\":[\"DEEP_VALUE_CRASH\"],\"timestamp\":$(date +%s)000}' EX 120"
```

Wait 30s, then check if APEX picked it up:
```bash
curl -s http://openclaw-vm/api/apex/status | python3 -c "
import json,sys
d=json.load(sys.stdin)
print('Board:', d.get('confluenceBoard', []))
print('Staleness:', d.get('staleness', {}))
"
```

Expected: `confluenceBoard` should show BTC with a score from the DEEP_VALUE_CRASH signal (30 pts).

- [ ] **Step 3: Clean up test signal**

```bash
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli DEL trades:pending"
```

---

## Execution Order

All 5 tasks are independent — execute in parallel for fastest results.

| Task | Subsystem | Risk | Time |
|------|-----------|------|------|
| 1 | Cryonix R/R | Low (config + small code) | 5 min |
| 2 | Copynix safety | Low (config + small code) | 5 min |
| 3 | Aktienix signals | Medium (signal logic change) | 10 min |
| 4 | Telegram infra | None (stop services) | 2 min |
| 5 | APEX verify | None (read-only) | 3 min |

**Total estimated: ~15 min with parallel execution.**

---

## Post-Deploy Monitoring

After all deploys, run this check after 1 hour:

```bash
# Cryonix: verify trades are executing
ssh azureuser@openclaw-vm "docker logs cryonix-auto-trader-1 --tail 10 | grep -c 'RISK_REJECTED'"
# Should be 0 or near-zero (was 40+/hr before fix)

# Copynix: verify safety gates active
ssh azureuser@openclaw-vm "docker logs cryonix-copynix-1 --tail 30 | grep -i 'safety\|reject\|liquidity'"

# Aktienix: verify signal quality (weekend — no signals expected)
ssh azureuser@openclaw-vm "docker logs aktienix --tail 20"

# Telegram: verify no restart loops
ssh azureuser@openclaw-vm "docker ps | grep telegram"
# Should show stopped, not restarting

# APEX: verify still running
curl -s http://openclaw-vm/api/apex/status | grep status
```
