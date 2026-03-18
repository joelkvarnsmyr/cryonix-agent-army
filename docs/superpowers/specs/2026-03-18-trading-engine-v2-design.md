# Cryonix Trading Engine V2 — 5-Gap Fix Design Spec

**Date:** 2026-03-18
**Status:** Approved for implementation (post spec-review)
**Scope:** 5 critical gaps identified via mathematical formula analysis

## Context

Cryonix missed a 10% BTC / 18% ETH / 15% SOL rally because:
- Capital was locked in stagnant positions (DOT -1.6%, AVAX -0.3%)
- Signals were rejected due to budget exhaustion (no rotation)
- When we finally bought BTC, we bought AFTER the rally (+4%) and hit SL on reversal

Post-mortem analysis identified 5 structural gaps. This spec fixes all 5 in two groups.

## Constraints

- $40 live account, 2 position slots, $15 min order
- auto-trade/route.ts is ~3500 lines — changes must be surgical
- Python engine in Docker, TypeScript in Next.js
- All changes backward-compatible via TOML config with defaults
- VM: 8GB RAM, 16 containers

---

## Group 1: Signal Quality (low risk, high impact)

### Gap 2: Multiplicative Confidence Model

**Problem:** 29 additive confidence adjustments double-count correlated signals. A whale buy triggers X buzz + Polymarket movement + Smart Money detection = +14% instead of recognizing ONE event.

**Solution:** Group intelligence sources by correlation, take max within each group, multiply across groups.

**Groups:**
- **Group A (Market Sentiment):** X sentiment, Smart Money (Copynix), Solanix DEX — all measure "what do people/whales think about this coin?"
- **Group B (Macro/Structural):** Polymarket, Aktienix macro events, CoinGlass funding/OI — all measure "is the market risk-on or risk-off?"
- **Group C (Historical Edge):** Bayesian self-learning — unique data from our own trades, independent of A and B.

**Formula:**
```
groupA_modifier = max(x_sentiment, smart_money, solanix_dex)  // take strongest
groupB_modifier = max(polymarket, macro_events, coinglass)     // take strongest
groupC_modifier = bayesian_adjustment                          // independent

conf_final = conf_blended × (1 + groupA) × (1 + groupB) × (1 + groupC)
conf_final = clamp(conf_final, 0, 0.95)
```

**Asymmetry note:** The multiplicative model is less punitive for negative adjustments (3 × -5% additive = -15%, vs multiplicative 0.95³ = -14.3%). This is acceptable — the primary goal is preventing overconfidence on the upside. Negative penalties are secondary.

**Example:** BTC signal, 75% base:
- Old (additive): 75% + 5% + 4% + 5% + 3% = 92% (overconfident)
- New (multiplicative): 75% × 1.05 × 1.04 × 1.00 = 81.9% (realistic)

**Implementation:**
- File: `apps/web/src/app/api/auto-trade/route.ts`
- Replace the sequential `signal.confidence +=` chain (lines ~3496-3590) with grouped multiplicative model
- Collect all modifiers into groupA/B/C arrays, take max per group, then multiply
- GainerScanner boost, Telegram boost, CMC adjustments stay additive (pre-AI, different pipeline stage)
- Only post-AI adjustments change to multiplicative

**Config (cryonix.toml):**
```toml
[confidence_model]
mode = "multiplicative"  # "additive" for rollback
max_group_modifier = 0.15  # cap each group at ±15%
```

---

### Gap 5: Bayesian Signal Ranking + Kelly Sizing

**Problem:** Signals processed FIFO by confidence. `rankSignalsBySoftmax()` and Bayesian Kelly exist but aren't wired in.

**Solution A: Softmax ranking replaces confidence sort.**

- File: `apps/web/src/app/api/auto-trade/route.ts`, line 3333
- **Placement:** BEFORE the for-loop (line 3344), AFTER all pre-loop adjustments (Polymarket, Vedic, etc.) but BEFORE AI validation (which happens inside the loop)
- Replace `parsed.sort((a,b) => confidence)` with `rankSignalsBySoftmax()`
- EV-weighted: signals with historically profitable patterns ranked higher
- Temperature=2.0 allows exploration (not purely greedy)

**BUG FIX (Critical):** `bayesian.ts` line 237 has `ev: sig.confidence / 100` but confidence is already 0-1 (not 0-100). Fix to `ev: sig.confidence` so low-data signals rank correctly instead of being buried.

**Fallback behavior:** When Bayesian has 0 data (n=0 for all patterns), softmax falls back to confidence-based ranking (identical to current behavior) since all EV scores will be equal (`sig.confidence`).

**Solution B: Kelly sizing from Bayesian posteriors.**

- File: `apps/web/src/app/api/auto-trade/route.ts`, `calculatePositionSize()` (line 2426)
- After computing RR-Kelly, also fetch `getBayesianAdjustment().kellyFraction`
- Use minimum of both (conservative): `effective_kelly = min(bayesian_kelly, rr_kelly)`
- Fallback: if Bayesian n < 10 (insufficient data), use RR-Kelly only

**Config:**
```toml
[bayesian]
use_softmax_ranking = true
use_kelly_sizing = true
softmax_temperature = 2.0
min_observations_for_kelly = 10
```

---

### Gap 3: Volatility-Adjusted Position Sizing

**Problem:** BTC (0.3% ATR) and ATOM (0.5% ATR) get identical $15 positions. High-vol coins lose more per trade.

**$40 account reality:** With MIN_ORDER_VALUE=$15, vol-sizing will be mostly dormant. The existing code bumps positions below $15 back UP to $15. Vol-sizing becomes active when account grows past ~$100 (where $15 min order isn't the binding constraint). We implement it now so it's ready, but acknowledge it's a future-proofing change.

**Solution:** Scale position size inversely with ATR.

```
baseline_atr_pct = 0.3  # BTC-like baseline
current_atr_pct = signal.indicators.atr_percent

# Safety: missing/zero ATR defaults to factor 1.0, NOT inflated
if current_atr_pct <= 0:
  vol_factor = 1.0  # no data = no adjustment
else:
  vol_factor = baseline_atr_pct / current_atr_pct
  vol_factor = clamp(vol_factor, 0.5, 1.5)

adjusted_size = base_size × vol_factor
```

**Implementation:**
- File: `apps/web/src/app/api/auto-trade/route.ts`, `calculatePositionSize()` (line 2426)
- Add vol_factor after Kelly sizing, before min-order check
- `atr_percent` already available in `signal.indicators.atr_percent` (quant.py line 146)

**Config:**
```toml
[sizing]
vol_adjusted = true
baseline_atr_pct = 0.3
min_vol_factor = 0.5
max_vol_factor = 1.5
```

---

## Group 2: Execution Quality (medium risk)

### Gap 4: Dynamic Stop-Loss

**Problem:** SL = entry - (ATR × multiplier) set once at entry. If volatility increases, SL is too tight → stopped out by noise.

**ATR source solution:** Instead of a non-existent `engine:indicators:{SYMBOL}` Redis key, store the entry-time ATR in the position object (`pos.entryATR`). On each monitor cycle, fetch fresh ATR from Binance via CCXT (`fetchOHLCV` last 14 candles → compute ATR). Cache in Redis with 60s TTL to avoid rate-limiting.

**Solution:** Each monitor cycle (30s), recalculate SL with current ATR. SL can only TIGHTEN (move up), never widen.

```
// In monitorPositions(), for each open position:
current_atr = await fetchCurrentATR(pos.symbol)  // CCXT + Redis cache
dynamic_sl = entry_price - (current_atr × sl_multiplier)

// SL ratchets UP only (never gives back ground)
// Guard: max 0.5% of ENTRY PRICE per cycle (not compounding)
max_move = pos.entryPrice * 0.005
new_sl = min(dynamic_sl, pos.stopLoss + max_move)
pos.stopLoss = max(pos.stopLoss, new_sl)
```

**Guard clarification:** The 0.5% guard is relative to entry price (fixed), not compounding. Over 6 cycles (3 min), SL can move max 3% — which is appropriate for crypto.

**Implementation:**
- File: `apps/web/src/app/api/auto-trade/route.ts`, `monitorPositions()` (line ~1000)
- Add `fetchCurrentATR()` helper that uses CCXT fetchOHLCV + Redis cache
- Store `pos.entryATR` and `pos.originalSL` at entry time for audit trail

**Config:**
```toml
[exits]
dynamic_sl = true
max_sl_move_per_cycle_pct = 0.5  # max 0.5% of entry price per 30s cycle
atr_cache_ttl_seconds = 60       # cache ATR to avoid rate limits
```

---

### Gap 1: 5-Minute Parallel Scan

**Problem:** Engine scans 15m candles only. Dips on 5m timeframe detected 10-15 min late.

**Rate limit impact:** Each OHLCV fetch costs ~1 weight. 15 symbols × 2 TFs = 30 calls per scan cycle. Binance allows 1200 weight/minute. At 10s scan interval = 6 cycles/min × 30 = 180 weight/min. Well within limits.

**Solution:** Add parallel 5m scan for dip-specific patterns only.

```
Primary scan (15m): All 8 patterns, full analysis — unchanged
Fast scan (5m):     DIP_BUY + BOLLINGER_SQUEEZE only
                    Higher confidence threshold (70% vs 55%)
                    Tagged as source="fast_5m"
                    Min ATR threshold: atr_percent > 0.2% (skip dead markets)
```

**Noise control:**
- Only 2 patterns eligible on 5m (mean-reversion patterns that work on short TF)
- Higher confidence threshold (70%) filters noise
- Max 3 fast-scan signals per cycle (prevents flooding top-15 queue)
- Min ATR threshold (0.2%) — skip BOLLINGER_SQUEEZE in dead sideways markets
- Rate limit: max 1 fast-scan signal per symbol per 5 minutes

**Implementation:**
- File: `packages/engine/src/tanks/market_scout.py`
- Add second scan pass within same loop iteration using 5m timeframe
- Only run `_detect_dip_buy()` and `_detect_bollinger_squeeze()` on 5m data
- Tag signals with `source: "fast_5m"` in the signal dict
- Auto-trader treats both the same (confidence threshold handles quality)

**Config:**
```toml
[engine]
fast_scan_enabled = true
fast_scan_timeframe = "5m"
fast_scan_patterns = ["DIP_BUY", "BOLLINGER_SQUEEZE"]
fast_scan_min_confidence = 0.70
fast_scan_cooldown_seconds = 300
fast_scan_min_atr_pct = 0.2
fast_scan_max_signals_per_cycle = 3
```

---

## Implementation Order

1. **Gap 2** (multiplicative confidence) — Highest impact, simplest change
2. **Gap 5** (Bayesian ranking + Kelly) — Wires in existing code, includes softmax bug fix
3. **Gap 3** (vol-sizing) — Small change in calculatePositionSize, dormant at $40
4. **Gap 4** (dynamic SL) — Moderate complexity, adds ATR fetching to monitor loop
5. **Gap 1** (5m scan) — Most complex, Python engine change

## Rollback Strategy

Every change gated by TOML config flag with safe defaults:
- `confidence_model.mode = "additive"` → old behavior
- `bayesian.use_softmax_ranking = false` → old sort
- `sizing.vol_adjusted = false` → old flat sizing
- `exits.dynamic_sl = false` → old static SL
- `engine.fast_scan_enabled = false` → 15m only

## Success Metrics

After 1 week of operation:
- Win rate should improve from 18.8% → target 35%+
- Average loss per trade should decrease (vol-sizing when account grows)
- Fewer "chase" trades (momentum gate already deployed)
- Faster entry on dips (5m scan + 60s cooldown)
- Better signal selection (Bayesian ranking)
- No overconfident trades above 90% (multiplicative model)
