# Ψnix Activation — Fix Dead Signals + Realistic Fee Gate

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Ψnix actually trade by fixing 3 root causes: dead signal sources (5 of 8 offline), broken fee-edge formula, and Kuramoto underperforming with only 2 signals.

**Architecture:** Fix fee-edge to use coherence-weighted ATR (not Ψ-scaled). Add diagnostic logging so we can see WHY trades are rejected. Lower min_signals to 2 but weight N into position sizing. Ensure price-based signals (Hurst/OU/momentum) always produce output by lowering their null-thresholds.

**Tech Stack:** TypeScript, psinix-agent.ts, price-signals.ts, signal-collector.ts, psinix.toml

---

## Root Cause Analysis

**Why 0 trades in 24h:**

1. **Only 2 of 8 signal sources alive.** Smartmoney: 0 Redis keys. F&G: missing. TA: 0 pending. Regime: "ranging" → null. Only price-based + polymarket:composite active.

2. **Price signals too conservative.** Hurst returns null unless H outside [0.42, 0.58]. OU returns null unless halflife ∈ [2, 50]. In practice, only momentum fires consistently → 1 price signal + 1 polymarket = 2 total.

3. **Fee-edge formula broken.** `expectedEdge = |Ψ| × avgAbsRet × holdBars`. With |Ψ|≈0.1, this scales expected return down 90%. Fee-edge should represent the MARKET's expected move scaled by COHERENCE, not by Ψ (which already incorporates position sizing). The correct formula: `expectedEdge = C × avgAbsRet × holdBars` — coherence measures signal quality, not position size.

4. **market:regime "ranging" treated as null.** This is valid information — a ranging market should contribute as neutral/slightly bearish, not disappear.

## File Structure

| File | Changes |
|------|---------|
| `packages/agents/src/psinix/psinix-agent.ts` | Fix fee-edge formula, add rejection logging, adjust min_edge |
| `packages/agents/src/psinix/price-signals.ts` | Loosen null-thresholds so Hurst/OU fire more often |
| `packages/agents/src/psinix/signal-collector.ts` | Fix regime signal to include "ranging" as weak signal |
| `psinix.toml` | Tune min_edge_after_fees down |

---

### Task 1: Fix fee-edge formula

The core bug. Fee-edge currently uses `|Ψ| × avgAbsRet × holdBars` but Ψ already incorporates Kelly × C² sizing. The edge check should measure whether the MARKET OPPORTUNITY justifies fees, not whether the POSITION SIZE does.

**Files:**
- Modify: `packages/agents/src/psinix/psinix-agent.ts` (fee-edge section ~line 333-353)

- [ ] **Step 1: Fix the formula + add rejection logging**

Replace the fee-edge block with:

```typescript
        // ── Fee-aware edge check ──
        // Edge = C × avgAbsReturn × holdBars (coherence = signal quality)
        // Must exceed round-trip fees to justify the trade
        const roundTripFeePct = risk.fee_pct * 2 / 100; // 0.002 for 0.1% per side
        let expectedEdgePct = 0;
        if (recentPrices.length >= 10) {
            let sumAbsRet = 0;
            for (let i = 1; i < recentPrices.length; i++) {
                sumAbsRet += Math.abs(recentPrices[i] - recentPrices[i - 1]) / recentPrices[i - 1];
            }
            const avgAbsRetPerBar = sumAbsRet / (recentPrices.length - 1);
            const estimatedHoldBars = Math.max(risk.min_hold_bars, 10);
            // Use COHERENCE as edge multiplier, not Ψ (which includes sizing)
            expectedEdgePct = psi.coherence * avgAbsRetPerBar * estimatedHoldBars;
        } else {
            expectedEdgePct = psi.coherence * 0.0013 * 10;
        }
        const minRequiredEdge = roundTripFeePct + risk.min_edge_after_fees / 100;
        if (expectedEdgePct < minRequiredEdge) {
            if (Math.abs(psi.psi) > 0.05) {
                console.log(`[psinix] REJECTED ${symbol} — edge ${(expectedEdgePct * 100).toFixed(3)}% < required ${(minRequiredEdge * 100).toFixed(3)}%`);
            }
            return;
        }
```

- [ ] **Step 2: Run tests**

Run: `npx tsx packages/agents/src/psinix/psi-engine.test.ts`
Expected: All pass (fee-edge is in agent, not engine)

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/psinix/psinix-agent.ts
git commit -m "fix(psinix): fee-edge uses coherence not Ψ — was blocking all trades"
```

---

### Task 2: Loosen price signal thresholds

Hurst and OU rarely fire because their null-thresholds are too strict for 15m crypto data. Hurst requires H outside [0.42, 0.58] — BTC 15m Hurst typically hovers around 0.45-0.55. OU requires halflife ∈ [2, 50] — often outside this range on 15m.

**Files:**
- Modify: `packages/agents/src/psinix/price-signals.ts`

- [ ] **Step 1: Widen Hurst detection range**

In `hurst()` method, change:

```typescript
// OLD:
if (H > 0.58) {
    direction = clamp(Math.sign(recentMean) * (H - 0.5) * 5, -1, 1);
} else if (H < 0.42) {
    direction = clamp(-Math.sign(recentMean) * (0.5 - H) * 5, -1, 1);
} else {
    return null;
}

// NEW — wider range, weaker signal in boundary zone:
if (H > 0.55) {
    direction = clamp(Math.sign(recentMean) * (H - 0.5) * 6, -1, 1);
} else if (H < 0.45) {
    direction = clamp(-Math.sign(recentMean) * (0.5 - H) * 6, -1, 1);
} else {
    return null;
}
```

- [ ] **Step 2: Widen OU halflife range**

In `ouSpread()` method, change:

```typescript
// OLD:
if (halfLife < 2 || halfLife > 50) return null;

// NEW — wider range for 15m bars:
if (halfLife < 1 || halfLife > 100) return null;
```

- [ ] **Step 3: Lower minimum direction thresholds**

In all three methods, change the `Math.abs(direction) < 0.05` filter to `< 0.03`:

```typescript
if (Math.abs(direction) < 0.03) return null;
```

- [ ] **Step 4: Run tests**

Run: `npx tsx packages/agents/src/psinix/price-signals.test.ts`
Expected: All 11 pass

- [ ] **Step 5: Commit**

```bash
git add packages/agents/src/psinix/price-signals.ts
git commit -m "fix(psinix): widen Hurst/OU thresholds — fire more often on 15m crypto data"
```

---

### Task 3: Fix market regime signal

"ranging" is currently mapped to direction=0 → returns null. But ranging IS information — it means "no strong trend" which should be a weak bearish/neutral signal for trend-followers.

**Files:**
- Modify: `packages/agents/src/psinix/signal-collector.ts`

- [ ] **Step 1: Make regime always produce a signal when data exists**

Replace the regime method:

```typescript
    private async getMarketRegime(): Promise<PsiSignal | null> {
        try {
            const raw = await this.redis.get('market:regime');
            if (!raw) return null;

            let data: any;
            try { data = JSON.parse(raw); } catch {
                // market:regime might be a plain string like "ranging"
                data = { regime: raw };
            }

            const regimeMap: Record<string, number> = {
                'bullish': 0.6, 'trending_up': 0.5,
                'bearish': -0.6, 'trending_down': -0.5,
                'volatile': -0.3,   // Volatile = risk-off
                'choppy': -0.2,
                'ranging': -0.1,    // Ranging = slight bearish bias (no momentum)
                'neutral': 0,
            };

            const regimeStr = (data.regime ?? data.state ?? data ?? '').toString().toLowerCase().trim();
            const direction = regimeMap[regimeStr] ?? 0;
            if (direction === 0) return null;

            return {
                sourceId: 'market:regime',
                direction,
                weight: 0.3,
                timestamp: Date.now(),
            };
        } catch {
            return null;
        }
    }
```

Note: `market:regime` stores a plain string "ranging" not JSON. The current `JSON.parse("ranging")` throws → returns null. Fix: try/catch JSON parse, fallback to raw string.

- [ ] **Step 2: Run tests**

Run: `npx tsx packages/agents/src/psinix/psi-engine.test.ts`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add packages/agents/src/psinix/signal-collector.ts
git commit -m "fix(psinix): regime signal handles plain string + ranging gives weak bearish"
```

---

### Task 4: Tune config for activation

Lower min_edge_after_fees from 0.1% to 0.05% — the fee-edge formula now uses coherence which is more realistic.

**Files:**
- Modify: `psinix.toml`

- [ ] **Step 1: Update config**

```toml
# Change:
min_edge_after_fees = 0.1
# To:
min_edge_after_fees = 0.05
```

- [ ] **Step 2: Commit**

```bash
git add psinix.toml
git commit -m "tune(psinix): lower min_edge 0.1→0.05% — fee formula now uses coherence"
```

---

### Task 5: Deploy and verify trading starts

- [ ] **Step 1: Run all tests locally**

```bash
npx tsx packages/agents/src/psinix/psi-engine.test.ts
npx tsx packages/agents/src/psinix/bayesian-weights.test.ts
npx tsx packages/agents/src/psinix/price-signals.test.ts
```

- [ ] **Step 2: Deploy**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build psinix"
```

- [ ] **Step 3: Wait 2 minutes, verify**

```bash
ssh azureuser@openclaw-vm "docker logs cryonix-psinix-1 --tail 20"
```

Expected: 3+ signals per symbol, phase transitions detected, trades opened.
If still REJECTED: logs will show exactly why (edge % vs required %).

- [ ] **Step 4: Commit deploy verification**

Only if trades are executing successfully.
