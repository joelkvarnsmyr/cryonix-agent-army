# Copynix Exit Strategy V2 — Data-Driven Optimization

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 0.29 R:R ratio by implementing time-aware stop loss, disabling medium consensus (25% WR), and letting winners run longer.

**Architecture:** Three surgical changes to copynix-agent.ts exit logic, consensus-engine.ts signal filtering, and copynix.toml parameters. No new files needed — all modifications to existing code.

**Tech Stack:** TypeScript, TOML config

**Evidence driving these changes (24h data, 10 completed trades):**
- Stop loss: 5 of 10 exits, avg -$8.75 each = -$43.77 total
- Medium consensus: 25% WR, -$46.12 PnL. Single whale: 100% WR, +$5.64
- Trailing stop works perfectly but activates too early (+10%), exits too tight (8%)
- Instant rugs (commotitty, SEC) dump >15% within 1 minute — identifiable by speed

---

### Task 1: Time-Aware Stop Loss

Replace the flat `-25%` SL in `checkExits()` with speed-aware logic:
- **Fast dump** (>15% loss within first 2 min): exit immediately = rug detection
- **Slow decline** (position held >30 min): widen SL to -35% = memecoin breathing room
- **Middle zone** (2-30 min): keep current -25% SL

**Files:**
- Modify: `packages/agents/src/copynix/copynix-agent.ts:636-644` (checkExits SL block)
- Modify: `copynix.toml:139-143` (exits config — add new params)
- Modify: `packages/agents/src/copynix/config.ts:13` (CopynixTomlConfig type)

- [ ] **Step 1: Add new config fields to TOML**

In `copynix.toml`, replace the exits section:
```toml
[exits]
take_profit_pct = 25.0
# Time-aware stop loss: fast dumps = rug detection, slow declines = wider tolerance
# Phase 1 (0-2 min): rug detection — exit if loss > 15%
rug_sl_pct = 15.0
rug_window_minutes = 2
# Phase 2 (2-30 min): standard SL
standard_sl_pct = 25.0
# Phase 3 (>30 min): wide SL — memecoins need room to breathe
wide_sl_pct = 35.0
wide_sl_after_minutes = 30
trailing_stop_pct = 12.0
trailing_activation_pct = 15.0
leader_exit_enabled = true
leader_exit_timeout_s = 60
stagnation_timeout_hours = 24
stagnation_min_pnl_pct = 3.0
```

- [ ] **Step 2: Update CopynixTomlConfig type**

In `packages/agents/src/copynix/config.ts` line 13, update the exits type:
```typescript
exits: {
    take_profit_pct: number;
    rug_sl_pct: number;
    rug_window_minutes: number;
    standard_sl_pct: number;
    wide_sl_pct: number;
    wide_sl_after_minutes: number;
    trailing_stop_pct: number;
    trailing_activation_pct: number;
    leader_exit_enabled: boolean;
    leader_exit_timeout_s: number;
    stagnation_timeout_hours: number;
    stagnation_min_pnl_pct: number;
};
```

Also update COPYNIX_DEFAULTS exits (line 25):
```typescript
exits: {
    take_profit_pct: 25.0, rug_sl_pct: 15.0, rug_window_minutes: 2,
    standard_sl_pct: 25.0, wide_sl_pct: 35.0, wide_sl_after_minutes: 30,
    trailing_stop_pct: 12.0, trailing_activation_pct: 15.0,
    leader_exit_enabled: true, leader_exit_timeout_s: 60,
    stagnation_timeout_hours: 24, stagnation_min_pnl_pct: 2.0,
},
```

- [ ] **Step 3: Replace SL logic in checkExits()**

In `copynix-agent.ts`, replace lines 636-644 (the current flat SL block):
```typescript
// Stop loss — time-aware: fast dump = rug, slow decline = wider tolerance
const holdMinutes = (Date.now() - pos.entryTime) / 60_000;
let effectiveSL = config.standard_sl_pct; // Default: 25%

if (holdMinutes <= config.rug_window_minutes) {
    // Phase 1: Rug detection — fast dump within 2 min
    effectiveSL = config.rug_sl_pct; // 15%
} else if (holdMinutes >= config.wide_sl_after_minutes) {
    // Phase 3: Wide SL — position has survived initial volatility
    effectiveSL = config.wide_sl_pct; // 35%
}

if (pnlPct <= -effectiveSL) {
    const phase = holdMinutes <= config.rug_window_minutes ? 'RUG' :
                  holdMinutes >= config.wide_sl_after_minutes ? 'WIDE-SL' : 'SL';
    const result = this.executor!.executeSell(pos.tokenMint, pos.currentPrice,
        `${phase} hit (${pnlPct.toFixed(1)}% in ${holdMinutes.toFixed(0)}min)`);
    if (result.success) {
        this.log('info', `[${phase}] ${result.message}`);
        await this.logSell(pos, pos.currentPrice, phase.toLowerCase(), result.pnl);
    }
    continue;
}
```

- [ ] **Step 4: Remove old `stop_loss_pct` references**

Search for any remaining references to `config.stop_loss_pct` in copynix-agent.ts and ensure they use the new field names. The dashboard `SL_PCT` constant (page.tsx line 32) should update to `const SL_PCT = 25;` (display only, uses standard_sl_pct visually).

- [ ] **Step 5: Commit**
```bash
git add copynix.toml packages/agents/src/copynix/config.ts packages/agents/src/copynix/copynix-agent.ts
git commit -m "feat(copynix): time-aware stop loss — rug detection (2min/15%) + wide SL (30min+/35%)"
```

---

### Task 2: Disable Medium Consensus

Data shows medium consensus (2 wallets) has 25% WR and -$46 PnL. It adds latency (waiting for 2nd wallet) without improving signal quality. Keep only strong (3+) and single whale.

**Files:**
- Modify: `packages/agents/src/copynix/consensus-engine.ts:72-86` (consensus level check)
- Modify: `packages/agents/src/copynix/copynix-agent.ts:462-463` (signal logging)

- [ ] **Step 1: Skip medium consensus in consensus-engine.ts**

In `consensus-engine.ts`, modify lines 72-86. Replace the medium consensus block:
```typescript
let consensusLevel: CopySignal['consensusLevel'] | null = null;
if (walletCount >= this.minWalletsStrong) {
    consensusLevel = 'strong';
}
// Medium consensus DISABLED — data shows 25% WR vs 100% for single whale.
// Waiting for 2nd wallet adds latency without improving signal quality.
// Trades fire via strong (3+) or single-whale only.

if (!consensusLevel) return null;

// Strong consensus reached — fire signal and set cooldown
this.cooldowns.set(trade.tokenMint, now + this.cooldownMs);
this.pending.delete(trade.tokenMint);
```

This removes the `medium` branch entirely, the `_mediumFired` hack, and the conditional cooldown logic (lines 82-86, 112-118).

- [ ] **Step 2: Update executeSignal log to note medium is disabled**

In `copynix-agent.ts` line 462-463, the `executeSignal` method logs consensus level. No code change needed — medium signals simply won't arrive. But update the comment above `processTrade()` to clarify:

```typescript
// Single-whale mode: high-score wallets can trigger alone.
// Medium consensus disabled — only strong (3+) or single whale trades.
```

- [ ] **Step 3: Commit**
```bash
git add packages/agents/src/copynix/consensus-engine.ts packages/agents/src/copynix/copynix-agent.ts
git commit -m "fix(copynix): disable medium consensus — 25% WR, -$46 PnL vs single whale 100% WR"
```

---

### Task 3: Widen Trailing Stop + Raise Activation

Let winners run longer. Currently trailing activates at +10% with 8% trail. DISLIKE went +36% — we should capture more of that upside.

**Files:**
- Modify: `copynix.toml:144-145` (already done in Task 1 — values set to 12% trail, 15% activation)

- [ ] **Step 1: Verify TOML values from Task 1**

Confirm `copynix.toml` has:
```toml
trailing_stop_pct = 12.0
trailing_activation_pct = 15.0
```

These were set in Task 1's TOML update. No additional code changes needed — `checkExits()` already reads these values from config.

- [ ] **Step 2: Verify dynamic trailing still works**

The existing dynamic trailing logic in `checkExits()` (lines 646-663) multiplies `config.trailing_stop_pct` by consensus-level factors:
- strong: `trailPct * 0.6` = 12% * 0.6 = **7.2%** (tighter, lock gains)
- single: `trailPct * 1.3` = 12% * 1.3 = **15.6%** (wider, let it run)

These new values are reasonable. No code change needed.

- [ ] **Step 3: Commit (if separate from Task 1)**

If Task 1 already committed the TOML changes, this step is a no-op.

---

### Task 4: Deploy + Verify

- [ ] **Step 1: Push code to VM**
```bash
git archive --format=tar HEAD -- copynix.toml packages/agents/src/copynix/ | \
  ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
```

- [ ] **Step 2: Rebuild + restart copynix container**
```bash
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --no-deps --build copynix"
```

- [ ] **Step 3: Verify startup logs**
```bash
ssh azureuser@openclaw-vm "sleep 15 && docker logs cryonix-copynix-1 --tail 10"
```

Expected: No errors, heartbeat showing `WS:live`, positions restored.

- [ ] **Step 4: Verify new SL logic fires correctly**

Wait for a trade or check logs for `[RUG]`, `[SL]`, or `[WIDE-SL]` tags in exit messages. The log format should show hold time: `RUG hit (-18.2% in 1min)`.

- [ ] **Step 5: Verify medium consensus is disabled**

Check logs — should see only `[WHALE]` (single) and `[CONSENSUS] strong signal` entries. No more `[CONSENSUS] medium signal`.

---

### Expected Impact

| Metric | Before | After (expected) |
|--------|--------|-----------------|
| SL exits | 5/10 (50%) | Fewer — wide SL lets memecoins breathe |
| Avg loss | -$8.75 | Smaller rug losses (-15% vs -25%), wider tolerance for survivors |
| Medium consensus WR | 25% | N/A (disabled) |
| Trailing activation | +10% | +15% (more upside captured) |
| Trailing width | 8% | 12% (less premature exits) |
| R:R ratio | 0.29 | Target: >0.5 |
