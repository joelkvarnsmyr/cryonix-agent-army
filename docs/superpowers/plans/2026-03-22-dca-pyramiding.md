# DCA / Pyramiding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow buying more of a symbol we already hold — DCA on dips and pyramiding on confirmations — instead of hard-blocking with "Already in".

**Architecture:** Replace the hard dedup block in `passesRiskChecks()` with smart rules that allow a second entry under strict conditions. Each entry creates a separate position in Redis (no merging). Monitor loop handles each independently.

**Tech Stack:** TypeScript, cryonix.toml config, auto-trade/route.ts

---

## File Map

| File | Change | Responsibility |
|------|--------|---------------|
| `apps/web/src/app/api/auto-trade/route.ts:2076-2078` | MODIFY | Replace hard dedup with DCA/pyramid rules |
| `cryonix.toml` | MODIFY | Add `[dca]` config section |

---

### Task 1: Add DCA config to cryonix.toml

**Files:**
- Modify: `cryonix.toml`

- [ ] **Step 1: Add config section**

Add to end of `cryonix.toml`:
```toml
[dca]
enabled = true
max_entries_per_symbol = 2          # Max buys of same symbol (1 = current behavior)
second_entry_min_confidence = 0.75  # 75% confidence required for 2nd entry
dip_threshold_pct = 2.0             # Price must dip >2% from entry for DCA
max_symbol_exposure_pct = 60        # Max 60% of capital in one symbol
```

- [ ] **Step 2: Commit**

```bash
git add cryonix.toml
git commit -m "chore(config): add [dca] section for DCA/pyramiding rules"
```

---

### Task 2: Replace hard dedup with smart DCA/pyramid rules

**Files:**
- Modify: `apps/web/src/app/api/auto-trade/route.ts:2076-2078`

- [ ] **Step 1: Replace the "Already in" block**

In `auto-trade/route.ts`, find lines 2076-2078:
```typescript
  if (openPositions.some(p => p.symbol === signal.symbol)) {
    return { pass: false, reason: `Already in ${signal.symbol}` };
  }
```

Replace with:
```typescript
  // DCA / Pyramiding: allow additional entries under strict conditions
  const existingPositions = openPositions.filter(p => p.symbol === signal.symbol);
  if (existingPositions.length > 0) {
    const dcaEnabled = (TOML as any)?.dca?.enabled ?? false;
    const maxEntries = (TOML as any)?.dca?.max_entries_per_symbol ?? 1;
    const minConf = (TOML as any)?.dca?.second_entry_min_confidence ?? 0.75;
    const dipThreshold = (TOML as any)?.dca?.dip_threshold_pct ?? 2.0;
    const maxExposurePct = (TOML as any)?.dca?.max_symbol_exposure_pct ?? 60;

    if (!dcaEnabled) {
      return { pass: false, reason: `Already in ${signal.symbol} (DCA disabled)` };
    }

    // Rule 1: Max entries per symbol
    if (existingPositions.length >= maxEntries) {
      return { pass: false, reason: `Already ${existingPositions.length}/${maxEntries} entries in ${signal.symbol}` };
    }

    // Rule 2: Higher confidence required for additional entries
    if (signal.confidence < minConf) {
      return { pass: false, reason: `DCA ${signal.symbol}: conf ${(signal.confidence * 100).toFixed(0)}% < ${(minConf * 100).toFixed(0)}% required for 2nd entry` };
    }

    // Rule 3: Price must have dipped (DCA) or risen (pyramid) meaningfully
    const firstEntry = existingPositions[0];
    const currentPrice = signal.entry_price;
    const priceDiffPct = ((currentPrice - firstEntry.entryPrice) / firstEntry.entryPrice) * 100;

    if (priceDiffPct > -dipThreshold && priceDiffPct < dipThreshold) {
      return { pass: false, reason: `DCA ${signal.symbol}: price ${priceDiffPct >= 0 ? '+' : ''}${priceDiffPct.toFixed(1)}% from entry (need >${dipThreshold}% move)` };
    }

    // Rule 4: Max exposure per symbol
    const existingExposure = existingPositions.reduce((sum, p) => sum + (p.entryPrice * p.quantity), 0);
    const newExposure = existingExposure + (signal.entry_price * (signal.position_size || 0));
    const maxExposure = capital * (maxExposurePct / 100);
    if (newExposure > maxExposure) {
      return { pass: false, reason: `DCA ${signal.symbol}: exposure $${newExposure.toFixed(2)} > $${maxExposure.toFixed(2)} max (${maxExposurePct}%)` };
    }

    const dcaType = priceDiffPct < 0 ? 'DCA' : 'PYRAMID';
    console.log(`[${dcaType}] ${signal.symbol}: 2nd entry allowed (conf=${(signal.confidence * 100).toFixed(0)}%, price ${priceDiffPct >= 0 ? '+' : ''}${priceDiffPct.toFixed(1)}% from 1st entry)`);
  }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit --project apps/web/tsconfig.json
```
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/auto-trade/route.ts
git commit -m "feat(auto-trade): replace hard dedup with DCA/pyramiding rules

Allow 2nd entry in same symbol under strict conditions:
- Max 2 entries per symbol (configurable)
- 2nd entry requires 75%+ confidence (vs 55% for 1st)
- Price must move >2% from 1st entry (DCA on dip or pyramid on rise)
- Max 60% of capital in one symbol
- Each entry creates separate position (independent SL/TP/trailing)"
```

---

### Task 3: Deploy and verify

- [ ] **Step 1: Push to VM and update TOML**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build web && docker exec cryonix-redis-1 redis-cli DEL instance:trading_lock && docker compose -f docker-compose.prod.yml restart auto-trader"
```

- [ ] **Step 2: Verify in logs**

```bash
ssh azureuser@openclaw-vm "docker logs cryonix-signal-worker-1 --tail 10 | grep -E 'DCA|PYRAMID|Already'"
```

Expected: Signals for held symbols now show `DCA` reasons instead of `Already in`.

- [ ] **Step 3: Verify config on VM**

```bash
ssh azureuser@openclaw-vm "grep -A5 '\[dca\]' ~/cryonix/cryonix.toml"
```

Expected: `[dca]` section with `enabled = true`.
