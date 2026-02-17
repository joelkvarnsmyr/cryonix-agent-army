# Autonomous Evolution System

**Self-improving trading system using GROK AI + GitHub Copilot CLI**

## Overview

Cryonix includes a two-phase autonomous evolution engine:
1. **GROK (xAI)** analyzes performance data, calibration EV, X sentiment, and source code → generates a precise mutation instruction
2. **GitHub Copilot CLI** executes the code changes (1-3 surgical tweaks)

```
┌─────────────────────────────────────────────────────────┐
│  Evolution Cycle (every 2h, cron-triggered)             │
└─────────────────────────────────────────────────────────┘
           │
           ↓
    1. Gather Performance Data
       - Query last 48h trades from Postgres (P&L by pattern)
       - Exit analysis (SL/TP/trailing breakdown)
       - Trade frequency analysis
       - GainerScanner missed opportunities
       - Pattern calibration EV from Redis
       - X/Twitter sentiment context from Redis
           │
           ↓
    2. Smart Trigger Detection
       - P&L < -$2 threshold
       - Structural issues: slTooTight, trailingKillingProfits,
         overTrading, missedBigMovers, lowWinRate
           │
           ↓
    3. Git Stash (protect manual changes)
       - Stashes uncommitted work before mutation
       - Creates file backup of critical files
           │
           ↓
    4. GROK Analysis (Phase 1)
       - Sends performance + calibration + sentiment + source code
       - Priority: structural → exit → EV → sentiment → signal → pattern
       - Returns precise Copilot CLI instruction
           │
           ↓
    5. Copilot CLI Mutation (Phase 2)
       - Executes GROK's instruction via `gh copilot --`
       - 10-minute timeout, up to 3 retry attempts
       - Output validation: `git diff --stat` must show changes
       - Refusal detection: rejects "I cannot", "I'm unable", etc.
           │
           ↓
    6. Diff-Size Guard & Scoped Staging
       - Reject changes >100 lines (via `git diff --cached --numstat`)
       - Stage only CONFIG.CRITICAL_FILES (no `git add .`)
           │
           ↓
    7. Verification Suite
       ✓ Python invariants (verify_deep_value.py, verify_grid.py)
       ✓ TypeScript build (pnpm build)
       ✓ Type checking (pnpm type-check)
       ✓ Unit tests (pnpm test)
           │
           ↓
    8. Deploy or Rollback
       - Success: commit, rebuild Docker, pop stash
         (`hadUncommittedChanges` reset after pop)
       - Failure: restore backup, git reset, pop stash, retry
         (`hadUncommittedChanges` reset in restoreBackup AND max-attempts path)
           │
           ↓
    9. Report via Telegram
       - Sends run summary, GROK token usage, success/failure
```

## GROK Analysis Context

The evolution prompt includes:

| Data Source | Content |
|-------------|---------|
| **Postgres** | Pattern P&L, win rates, exit types, trade frequency |
| **Redis calibration** | Per-pattern EV data: win rate, sample size, EV value (from `/api/calibration`) |
| **Redis sentiment** | X/Twitter sentiment scores and alerts (from `/api/x-sentiment`) |
| **Redis market regime** | Current market regime classification |
| **Indicators** | Full indicator set: MACD, Bollinger Bands, EMAs, ADX, etc. |
| **GainerScanner** | Top movers, missed opportunities, volume surges |
| **Source code** | Full files: quant.py, risk_gate.py, risk_manager.py, route.ts |
| **Diagnostics** | Structural issue flags (slTooTight, overTrading, etc.) |

## Safety Mechanisms

### 1. Git Stash Protection
Manual (uncommitted) changes are stashed before evolution and restored after.

### 2. File Backups
All critical files backed up to `.evolution-backups/{run_id}/` before mutation.

### 3. Verification Pipeline
All mutations must pass Python invariant tests + TypeScript build + type-check.

### 4. Automatic Rollback
Failed verification → restore backup → `git reset --hard` → pop stash.

### 5. Protected Risk Controls
GROK is explicitly instructed to NEVER remove: stop-loss, position size limits, daily loss limits, risk checks.

### 6. Telegram Reporting
Every evolution run reports to Telegram: phase progress, token usage, success/failure.

### 7. Diff-Size Guard
Changes exceeding 100 lines (measured via `git diff --cached --numstat`) are rejected to prevent full-file rewrites.

### 8. Copilot Output Validation
After mutation, `git diff --stat` must show actual changes. Refusal phrases ("I cannot", "I'm unable") in Copilot output trigger a retry.

### 9. Scoped Git Add
Only `CONFIG.CRITICAL_FILES` are staged (`git add` per file), replacing the previous `git add .` which could stage unrelated changes.

### 10. Stash-Pop Safety
`hadUncommittedChanges` is reset in all three exit paths (success, restoreBackup, max-attempts) to prevent double `git stash pop`.

## Configuration

```javascript
const CONFIG = {
  LOOKBACK_HOURS: 48,              // Performance analysis window
  MIN_TRADES_FOR_ANALYSIS: 3,      // Minimum trades to trigger
  PERFORMANCE_THRESHOLD: -2.0,     // P&L trigger threshold
  MAX_EVOLUTION_ATTEMPTS: 3,       // Retry failed mutations
  COPILOT_TIMEOUT: 600000,         // 10 minutes max per attempt
  CRITICAL_FILES: [
    'packages/engine/src/guilds/quant.py',
    'packages/engine/src/core/risk_gate.py',
    'packages/engine/src/core/risk_manager.py',
    'apps/web/src/app/api/auto-trade/route.ts'
  ]
};
```

## Cron Jobs

```cron
# Evolution (active — every 2h)
0 */2 * * * cd ~/cryonix && bash scripts/run_evolution.sh >> /tmp/evolution-cron.log 2>&1

# Pattern calibration + X sentiment (every 6h)
0 */6 * * * cd ~/cryonix && bash scripts/run_calibration.sh >> /tmp/calibration-cron.log 2>&1

# X sentiment refresh (every 15min)
*/15 * * * * cd ~/cryonix && curl -s -X POST https://cryonix.kvarnsmyr.se/api/x-sentiment > /dev/null 2>&1
```

## Manual Operations

```bash
# Run evolution manually
cd ~/cryonix && node scripts/copilot-evolution.mjs

# Run calibration manually
bash scripts/run_calibration.sh

# Check evolution logs
tail -f /tmp/evolution-cron.log

# View evolution commit history
git log --oneline --grep="Auto-Evolution"

# Emergency rollback
ls .evolution-backups/       # List backups
cp -r .evolution-backups/<ID>/* .
git reset --hard HEAD~1
docker compose -f docker-compose.prod.yml restart engine web auto-trader
```

## Known Issues (from peer review)

1. ~~**Double stash-pop risk**~~ — ✅ FIXED: `hadUncommittedChanges` reset in restoreBackup, success, and max-attempts paths
2. ~~**`git add .` too broad**~~ — ✅ FIXED: scoped to `CONFIG.CRITICAL_FILES` loop
3. ~~**No diff-size guard**~~ — ✅ FIXED: reject changes >100 lines via `git diff --cached --numstat`
4. ~~**No Copilot output validation**~~ — ✅ FIXED: `git diff --stat` content check + refusal phrase detection
5. **No semantic parameter validation** — 🟡 PARTIALLY MITIGATED (output validation + diff guard reduce risk)

See peer review: `.copilot/session-state/.../files/peer-review-evolution.md`

---

**Status**: 🟢 Active (evolution cron running every 2h)
**Last Updated**: 2025-07-16
**Version**: 2.1.0 — Phase 11 Evolution Hardening
