# Cryonix Trading Engine V2 — 5-Gap Fix Design Spec

**Date:** 2026-03-18
**Status:** Approved for implementation
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

**Example:** BTC signal, 75% base:
- Old (additive): 75% + 5% + 4% + 5% + 3% = 92% (overconfident)
- New (multiplicative): 75% × 1.05 × 1.04 × 1.00 = 81.9% (realistic)

**Implementation:**
- File: `apps/web/src/app/api/auto-trade/route.ts`
- Replace the sequential `signal.confidence +=` chain (lines ~3496-3590) with grouped multiplicative model
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
- Replace `parsed.sort((a,b) => confidence)` with `rankSignalsBySoftmax()`
- EV-weighted: signals with historically profitable patterns ranked higher
- Temperature=2.0 allows exploration (not purely greedy)

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

**Solution:** Scale position size inversely with ATR.

```
baseline_atr_pct = 0.3  # BTC-like baseline
current_atr_pct = signal.indicators.atr_pct
vol_factor = baseline_atr_pct / max(current_atr_pct, 0.1)
vol_factor = clamp(vol_factor, 0.5, 1.5)
adjusted_size = base_size × vol_factor
```

**Examples:**
| Coin | ATR% | vol_factor | Position |
|------|------|------------|----------|
| BTC | 0.3% | 1.0 | $15.00 |
| ETH | 0.35% | 0.86 | $12.86 |
| ATOM | 0.5% | 0.60 | $9.00 |
| DOT | 0.8% | 0.375→0.5 | $7.50 |

**Min order guard:** If vol-adjusted size < MIN_ORDER_VALUE × 0.95 ($14.25), signal is rejected as "too volatile for account size". This is correct behavior — the signal is genuine but our account can't afford the risk.

**Implementation:**
- File: `apps/web/src/app/api/auto-trade/route.ts`, `calculatePositionSize()` (line 2426)
- Add vol_factor after Kelly sizing, before min-order check
- `atr_pct` already available in `signal.indicators.atr_percent`

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

**Solution:** Each monitor cycle (30s), recalculate SL with current ATR. SL can only TIGHTEN (move up), never widen.

```
// In monitorPositions(), for each open position:
current_atr = signal.indicators.atr  // from latest engine scan
dynamic_sl = entry_price - (current_atr × sl_multiplier)

// SL ratchets UP only (never gives back ground)
pos.stopLoss = max(pos.stopLoss, dynamic_sl)
```

**Guard:** SL can never move more than 1% per cycle (prevents ATR spikes from causing whiplash).

**Implementation:**
- File: `apps/web/src/app/api/auto-trade/route.ts`, `monitorPositions()` (line ~1000)
- Need current ATR: fetch from Redis `engine:indicators:{SYMBOL}` or from Binance ticker
- Store `original_sl` for audit trail

**Config:**
```toml
[exits]
dynamic_sl = true
max_sl_move_per_cycle_pct = 1.0  # max 1% SL adjustment per 30s
```

---

### Gap 1: 5-Minute Parallel Scan

**Problem:** Engine scans 15m candles only. Dips on 5m timeframe detected 10-15 min late.

**Solution:** Add parallel 5m scan for dip-specific patterns only.

```
Primary scan (15m): All 8 patterns, full analysis — unchanged
Fast scan (5m):     DIP_BUY + BOLLINGER_SQUEEZE only
                    Higher confidence threshold (70% vs 55%)
                    Tagged as source="fast_5m"
```

**Noise control:**
- Only 2 patterns eligible on 5m (mean-reversion patterns that work on short TF)
- Higher confidence threshold (70%) filters noise
- 5m signals get slightly lower rotation priority (they're less confirmed)
- Rate limit: max 1 fast-scan signal per symbol per 5 minutes

**Implementation:**
- File: `packages/engine/src/tanks/market_scout.py`
- Add second scan pass with 5m timeframe after primary 15m scan
- Tag signals with `source: "fast_5m"` vs `source: "standard_15m"`
- Auto-trader treats both the same (confidence threshold handles quality)

**Config:**
```toml
[engine]
fast_scan_enabled = true
fast_scan_timeframe = "5m"
fast_scan_patterns = ["DIP_BUY", "BOLLINGER_SQUEEZE"]
fast_scan_min_confidence = 0.70
fast_scan_cooldown_seconds = 300
```

---

## Implementation Order

1. **Gap 2** (multiplicative confidence) — Highest impact, simplest change
2. **Gap 5** (Bayesian ranking + Kelly) — Wires in existing code
3. **Gap 3** (vol-sizing) — Small change in calculatePositionSize
4. **Gap 4** (dynamic SL) — Moderate complexity, needs ATR source
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
- Average loss per trade should decrease (vol-sizing)
- Fewer "chase" trades (momentum gate already deployed)
- Faster entry on dips (5m scan + 60s cooldown)
- Better signal selection (Bayesian ranking)
