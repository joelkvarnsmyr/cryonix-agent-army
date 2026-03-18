# Aktienix Signal Logic Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 4 logical flaws in Aktienix signal pipeline that leave $34k idle and penalize momentum trades.

**Architecture:** All fixes modify the existing signal generation → evaluation → sizing pipeline. Signal generator gets a lower floor + trend-aware RSI + net-score filter. Position sizing gets Bayesian tiered multipliers. No new files created.

**Tech Stack:** TypeScript, Alpaca API, Redis (ioredis), aktienix.toml config

**Spec:** `docs/superpowers/specs/2026-03-18-aktienix-signal-logic-fixes.md`

**Deploy constraint:** FOMC at 14:00 ET today. Deploy after market close (16:00 ET) to avoid mid-session config change.

---

### Task 1: Lower signal floor + trend-aware RSI + net-score filter

All three signal generator fixes are in the same `generateSignal()` method (lines 132-246) and deeply interrelated — splitting them would require redundant context and risk merge conflicts.

**Files:**
- Modify: `packages/agents/src/aktienix/signals/stock-signal-generator.ts:132-246`

- [ ] **Step 1: Implement trend-aware RSI zones (Fix #1)**

Replace the hardcoded RSI thresholds (lines 141-154) with trend-adjusted values:

```typescript
        // --- Factor 1: RSI (weight: 25%) ---
        // Trend-aware zones: shift thresholds based on trend direction + strength
        // In uptrend: raise overbought zone (momentum is strength, not weakness)
        // In downtrend: lower oversold zone (falling knife, not value)
        const trendShift = Math.round(structure.trendStrength * 10); // 0-10 RSI points
        const oversold = structure.trend === 'downtrend' ? 30 - trendShift : 30;
        const approachingOversold = structure.trend === 'downtrend' ? 40 - trendShift : 40;
        const overbought = structure.trend === 'uptrend' ? 70 + trendShift : 70;
        const approachingOverbought = structure.trend === 'uptrend' ? 60 + trendShift : 60;

        if (indicators.rsi14 < oversold) {
            buyScore += 0.25;
            reasoning.push(`RSI oversold (${indicators.rsi14.toFixed(1)}, threshold ${oversold})`);
        } else if (indicators.rsi14 < approachingOversold) {
            buyScore += 0.10;
            reasoning.push(`RSI approaching oversold (${indicators.rsi14.toFixed(1)})`);
        } else if (indicators.rsi14 > overbought) {
            sellScore += 0.25;
            reasoning.push(`RSI overbought (${indicators.rsi14.toFixed(1)}, threshold ${overbought})`);
        } else if (indicators.rsi14 > approachingOverbought) {
            sellScore += 0.10;
            reasoning.push(`RSI approaching overbought (${indicators.rsi14.toFixed(1)})`);
        }
```

- [ ] **Step 2: Add net-score filter + lower signal floor (Fixes #6 and #2)**

Replace the final action determination block (lines 210-223) with:

```typescript
        // --- Determine final action ---
        let action: 'BUY' | 'SELL' | 'WAIT';
        let confidence: number;

        // Net-score filter: require clear directional conviction
        // Prevents ambiguous signals where both BUY and SELL score similarly
        const netScore = Math.abs(buyScore - sellScore);
        const minNetScore = 0.15;

        if (netScore < minNetScore) {
            // Too uncertain — conflicting signals cancel out
            action = 'WAIT';
            confidence = 0;
        } else if (buyScore > sellScore && buyScore >= 0.10) {
            // Low floor (0.10 instead of 0.35): let macro boost in evaluateSignal()
            // push borderline signals over min_confidence threshold (0.40)
            action = 'BUY';
            confidence = Math.min(buyScore, 0.95);
        } else if (sellScore > buyScore && sellScore >= 0.10) {
            action = 'SELL';
            confidence = Math.min(sellScore, 0.95);
        } else {
            action = 'WAIT';
            confidence = 0;
        }
```

- [ ] **Step 3: Verify the changes compile**

Run: `pnpm --filter @cryonix/web type-check 2>&1 | tail -5`
Expected: No errors in `stock-signal-generator.ts`

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/aktienix/signals/stock-signal-generator.ts
git commit -m "fix(aktienix): trend-aware RSI + net-score filter + lower signal floor

- RSI zones shift ±10 points based on trendStrength (momentum = strength)
- Net-score filter: |buy-sell| >= 0.15 required (eliminates ambiguous signals)
- Signal floor lowered 0.35 → 0.10 so macro boost reaches all symbols"
```

---

### Task 2: Bayesian tiered position sizing

**Files:**
- Modify: `packages/agents/src/aktienix/aktienix-agent.ts:848-858`

- [ ] **Step 1: Add Bayesian size multiplier before PositionSizer.calc()**

Insert before line 848 (`// Calculate fractional qty via the position-sizer module`):

```typescript
        // Bayesian tiered position sizing:
        // Adjust max position size based on historical win rate for this symbol
        // Tier: <50% → 0.5x, 50-65% → 1.0x, >65% → 1.5x
        let bayesSizeMultiplier = 1.0;
        if (this.statePublisher) {
            try {
                const bayesRaw = await this.statePublisher.get(`bayes:aktienix:symbol:${symbol}`);
                if (bayesRaw) {
                    const prior = JSON.parse(bayesRaw);
                    if (prior.n >= 10) {
                        const winRate = prior.alpha / (prior.alpha + prior.beta);
                        if (winRate > 0.65) {
                            bayesSizeMultiplier = 1.5;
                            this.log('info', `BAYES SIZE: ${symbol} win rate ${(winRate * 100).toFixed(0)}% (n=${prior.n}) → 1.5x position`);
                        } else if (winRate < 0.50) {
                            bayesSizeMultiplier = 0.5;
                            this.log('info', `BAYES SIZE: ${symbol} win rate ${(winRate * 100).toFixed(0)}% (n=${prior.n}) → 0.5x position`);
                        }
                    }
                }
            } catch { /* non-critical — use default 1.0x */ }
        }

        // Temporarily override config max size with Bayesian multiplier
        const originalMaxSize = config.capital.max_position_size_usd;
        config.capital.max_position_size_usd = originalMaxSize * bayesSizeMultiplier;
```

- [ ] **Step 2: Restore original config after PositionSizer.calc()**

After the existing `PositionSizer.calc()` call and its qty check (lines 849-858), add:

```typescript
        // Restore original config (don't let Bayesian multiplier leak to next signal)
        config.capital.max_position_size_usd = originalMaxSize;
```

- [ ] **Step 3: Verify the changes compile**

Run: `pnpm --filter @cryonix/web type-check 2>&1 | tail -5`
Expected: No errors in `aktienix-agent.ts`

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/aktienix/aktienix-agent.ts
git commit -m "feat(aktienix): Bayesian tiered position sizing

Three tiers based on historical win rate (n >= 10 required):
- <50% win rate → 0.5x max position ($5k)
- 50-65% win rate → 1.0x (default $10k)
- >65% win rate → 1.5x ($15k)

Reads from bayes:aktienix:symbol:{symbol} Redis key.
Falls back to 1.0x if insufficient data or Redis unavailable."
```

---

### Task 3: Update TOML documentation + deploy

**Files:**
- Modify: `aktienix.toml`

- [ ] **Step 1: Update TOML signal section comments**

Update the `[signals]` section to document the new behavior:

```toml
# Minimum combined score to generate a signal. Lowered to 0.10 (was 0.30)
# so that macro intelligence boost (+15%) can reach borderline signals.
# The real gate is min_confidence (0.40) in evaluateSignal(), applied
# AFTER Grok and Polymarket overlays. Net-score filter (|buy-sell| >= 0.15)
# eliminates ambiguous signals where both directions score similarly.
min_signal_score = 0.10
```

- [ ] **Step 2: Commit config update**

```bash
git add aktienix.toml
git commit -m "docs(aktienix): update TOML comments for new signal logic"
```

- [ ] **Step 3: Deploy to VM (after market close, 16:00 ET)**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build aktienix"
```

- [ ] **Step 4: Verify deployment**

```bash
ssh azureuser@openclaw-vm "docker logs aktienix --tail 20"
```

Expected: Aktienix starts successfully, signal scan shows MORE BUY signals than before (including symbols like XOM, CVX that were previously filtered to WAIT).

- [ ] **Step 5: Monitor first signal scan**

Wait for signal scan (every 5 min) and verify:
1. More symbols generate BUY signals (XOM, CVX, MSTR should appear)
2. Ambiguous signals (net < 0.15) are filtered to WAIT
3. RSI thresholds shift in trending symbols
4. Bayesian sizing logs show multiplier for symbols with sufficient data

```bash
ssh azureuser@openclaw-vm "docker logs aktienix --tail 50 | grep -iE 'Signal|MACRO|BAYES|net.score|RSI|threshold'"
```
