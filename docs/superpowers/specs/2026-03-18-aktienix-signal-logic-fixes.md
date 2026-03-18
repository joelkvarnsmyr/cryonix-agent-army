# Aktienix Signal Logic Fixes — Design Spec

**Date:** 2026-03-18
**Status:** Approved
**Scope:** Fix 6 logical flaws identified through mathematical formalization of the trading system

---

## Background

Mathematical analysis of the Aktienix trading pipeline revealed 6 logical flaws that reduce profitability. The system currently generates correct macro intelligence (Grok + Polymarket) but fails to convert it into trades due to signal pipeline ordering issues.

**Key metric:** $34k (34%) of capital sits idle because macro-boosted signals never reach execution.

---

## Phase 1 — Implement Now (4 fixes, profit-critical)

### Fix #2 (CRITICAL): Signal generator returns all symbols, not just actionable

**Problem:** `stock-signal-generator.ts` filters signals with `score < 0.30` to `WAIT` and discards them. `evaluateSignal()` in `aktienix-agent.ts` only receives non-WAIT signals. Macro boost (+0.15 from Grok) is applied inside `evaluateSignal()` — so it NEVER reaches symbols filtered to WAIT.

**Example:** XOM has `S_buy = 0.28` (under 0.30 threshold) → filtered to WAIT → macro boost +0.15 never applied → XOM never bought despite Grok flagging it BULLISH.

**Solution (approach B):** Signal generator returns ALL symbols with their scores, including low-score ones. `evaluateSignal()` becomes the sole gatekeeper using `min_confidence` (after macro overlay).

**Implementation:**
1. In `stock-signal-generator.ts`, change line 214-223:
   - Remove the `buyScore >= 0.35` / `sellScore >= 0.35` threshold for action determination
   - Use a much lower floor (0.10) — just enough to filter pure noise
   - Let the downstream `min_confidence` check (0.40) in `evaluateSignal()` be the real gate
2. In `aktienix-agent.ts`, `evaluateSignal()` already checks `min_confidence` — no change needed there

**Before:**
```
if (buyScore > sellScore && buyScore >= 0.35) → BUY
else if (sellScore > buyScore && sellScore >= 0.35) → SELL
else → WAIT (discarded, never reaches macro boost)
```

**After:**
```
if (buyScore > sellScore && buyScore >= 0.10) → BUY (reaches evaluateSignal for macro overlay)
else if (sellScore > buyScore && sellScore >= 0.10) → SELL
else → WAIT
```

**Safety:** `min_confidence = 0.40` in evaluateSignal() still blocks weak signals. The difference: macro boost (+0.15) and Polymarket overlay (+0.08) can now push borderline signals over the threshold.

---

### Fix #1 (MEDIUM): Trend-aware RSI zones

**Problem:** RSI 60-70 generates SELL points ("approaching overbought") even in strong uptrends. This penalizes momentum — exactly wrong in a trending market like the current energy rally.

**Solution (approach C):** Dynamic RSI thresholds that shift based on trend direction and strength.

**Implementation:**
In `stock-signal-generator.ts`, replace hardcoded RSI thresholds with trend-adjusted values:

```typescript
// Base thresholds from TOML
const baseOversold = 30;
const baseApproachingOversold = 40;
const baseOverbought = 70;
const baseApproachingOverbought = 60;

// Shift thresholds based on trend
// In uptrend: raise overbought zone (momentum = strength, not weakness)
// In downtrend: lower oversold zone (falling knife, not value)
const trendShift = Math.round(structure.trendStrength * 10); // 0-10 points

if (structure.trend === 'uptrend') {
    overbought = baseOverbought + trendShift;          // 70 → up to 80
    approachingOverbought = baseApproachingOverbought + trendShift; // 60 → up to 70
    // Oversold zones unchanged (dips in uptrend are still buying opportunities)
} else if (structure.trend === 'downtrend') {
    oversold = baseOversold - trendShift;              // 30 → down to 20
    approachingOversold = baseApproachingOversold - trendShift; // 40 → down to 30
    // Overbought zones unchanged (bounces in downtrend are still sell opportunities)
}
```

**Effect:** XOM with RSI 65 in strong uptrend (trendStrength=0.8):
- Before: `approachingOverbought = 60` → RSI 65 generates SELL points
- After: `approachingOverbought = 68` → RSI 65 is neutral (no SELL points)

---

### Fix #6 (MEDIUM): Net-score filter

**Problem:** `S_buy = 0.35` and `S_sell = 0.30` → system picks BUY at 0.35 confidence. But net confidence is only 0.05 — an uncertain signal that should be WAIT.

**Solution (approach A):** Add a `min_net_score` check. Signal only generated if `|S_buy - S_sell| >= min_net_score`.

**Implementation:**
In `stock-signal-generator.ts`, after calculating buyScore and sellScore:

```typescript
const netScore = Math.abs(buyScore - sellScore);
const minNetScore = 0.15; // configurable via TOML later

if (netScore < minNetScore) {
    action = 'WAIT'; // Too uncertain
    confidence = 0;
}
```

**Effect:** Eliminates ambiguous signals where both BUY and SELL have similar strength. Only trades with clear directional conviction pass through.

**TOML config (future):**
```toml
[signals]
min_net_score = 0.15
```

---

### Fix #3 (MEDIUM): Bayesian tiered position sizing

**Problem:** All positions get the same `max_position_size_usd` regardless of Bayesian win probability. A symbol with 80% historical win-rate gets the same size as one with 50%.

**Solution (approach C):** Three tiers based on Bayesian win-rate:

| Bayesian Win Rate | Tier | Size Multiplier |
|-------------------|------|-----------------|
| < 50% or n < 10  | Low  | 0.5x            |
| 50% - 65%        | Normal | 1.0x          |
| > 65%            | High | 1.5x            |

**Implementation:**
In `aktienix-agent.ts`, in the position sizing section (before `submitOrder`):

```typescript
// Read Bayesian prior for this symbol
let sizeMultiplier = 1.0;
if (this.statePublisher) {
    try {
        const bayesRaw = await this.statePublisher.get(`bayes:aktienix:symbol:${symbol}`);
        if (bayesRaw) {
            const prior = JSON.parse(bayesRaw);
            if (prior.n >= 10) {
                const winRate = prior.alpha / (prior.alpha + prior.beta);
                if (winRate > 0.65) sizeMultiplier = 1.5;
                else if (winRate < 0.50) sizeMultiplier = 0.5;
                // else: 1.0x (default)
            }
        }
    } catch { /* non-critical */ }
}

const adjustedMaxSize = config.capital.max_position_size_usd * sizeMultiplier;
```

**Safety:** Capped at 1.5x → max $15k per position (within `max_single_position_pct = 15%` on $100k portfolio). Requires n >= 10 trades before any adjustment — default 1.0x until then.

---

## Phase 2 — Implement After FOMC (2 fixes, safety-focused)

### Fix #4 (MEDIUM): Extended-hours exit monitoring

**Problem:** Exit monitor only runs during regular hours (09:30-16:00 ET). Pre/after-hours price moves bypass stop-loss. A stock can gap down -5% overnight and SL at -3% never triggers.

**Solution:** Run a lightweight exit check during pre-market intelligence loop. Only check SL (not TP/trailing/stagnation — those need regular-hours liquidity).

**Implementation (deferred):**
In the pre-market block of `aktienix-agent.ts`, after portfolio refresh:

```typescript
// Emergency SL check during extended hours
for (const pos of this.positions) {
    const pnlPct = (pos.unrealizedPl / (pos.avgEntryPrice * pos.qty)) * 100;
    if (pnlPct <= -(config.exits.stop_loss_pct * 1.5)) { // Wider SL for extended hours (4.5%)
        // Extended hours SL — use wider threshold due to lower liquidity
        // Submit market order (Alpaca supports extended hours)
        await this.brokerClient.submitOrder({
            symbol: pos.symbol, action: 'SELL', qty: pos.qty,
            orderType: 'MARKET', extendedHours: true,
        });
    }
}
```

**Note:** Extended-hours SL uses 1.5x normal SL (4.5% instead of 3%) because spreads are wider and prices more volatile. Only catastrophic drops trigger it.

**Timing:** Implement after FOMC volatility settles (2026-03-19 or later).

---

### Fix #5 (LOW): Disambiguate geopolitik delta signal

**Problem:** `geopolitik:delta direction='bullish'` is assumed to mean ceasefire (bearish for energy). But "bullish geopolitik" could also mean defense stocks rallying — not ceasefire at all.

**Solution:** Don't use geopolitik delta for energy exits. Instead, only use `oil:delta` (which directly measures oil/energy sentiment) and add a specific ceasefire market tracker.

**Implementation (deferred):**
1. Remove geopolitik delta from the energy exit trigger in `aktienix-agent.ts`
2. Add specific Polymarket ceasefire market tracking:
   - Search for markets containing "ceasefire", "peace deal", "Hormuz reopen"
   - Track probability directly, not through category aggregation
3. Trigger energy exit only on: `oil:delta bearish >= 15` OR `ceasefire_probability > 40%`

**Timing:** Implement when Iran situation evolves (ongoing monitoring).

---

## Files Modified

### Phase 1 (now)
| File | Changes |
|------|---------|
| `packages/agents/src/aktienix/signals/stock-signal-generator.ts` | Lower signal floor (0.10), trend-aware RSI, net-score filter |
| `packages/agents/src/aktienix/aktienix-agent.ts` | Bayesian tiered sizing in evaluateSignal() |
| `aktienix.toml` | Add `min_net_score` parameter |

### Phase 2 (after FOMC)
| File | Changes |
|------|---------|
| `packages/agents/src/aktienix/aktienix-agent.ts` | Extended-hours SL check in pre-market loop |
| `packages/agents/src/aktienix/aktienix-agent.ts` | Remove geopolitik delta from energy exit |
| `scripts/services/polymarket-scanner.ts` | Ceasefire-specific market tracking |

---

## Risk Assessment

| Change | Risk | Mitigation |
|--------|------|------------|
| Lower signal floor (0.10) | More signals pass → more trades | `min_confidence = 0.40` still gates execution |
| Trend-aware RSI | May miss genuine overbought signals | Only shifts 0-10 RSI points, never removes zone entirely |
| Net-score filter | May reduce trade count | 0.15 threshold is modest — clear signals still pass |
| Bayesian sizing | Larger positions in "winning" symbols | Capped at 1.5x, requires n >= 10 data points |

## Expected Impact

Based on last week's data:
- **XOM (+5.35%)** and **CVX (+4.35%)** would have been bought (fix #2 + #1)
- **MSTR (+3.94%)** would have been bought (fix #2, crypto macro boost)
- Ambiguous signals (buy=0.35, sell=0.30) would be filtered (fix #6)
- High-conviction trades (XLE with 2.62% Bayesian win-rate data) would get 1.5x sizing (fix #3)

**Estimated additional weekly profit: $400-$1,200** (based on missed XOM/CVX/MSTR trades)
