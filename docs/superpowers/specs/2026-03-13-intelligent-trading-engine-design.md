# Intelligent Trading Engine — Design Spec

**Date:** 2026-03-13
**Status:** Approved
**Scope:** Three interconnected systems that replace the current single-TP/binary-alert approach with a modular, context-aware trading engine.

## Problem Statement

Three architectural gaps identified through backtesting (30d, 9 coins, 3 timeframes) and production data (37 trades):

1. **Single TP target** — `tp_atr_multiplier=12` gives 8-15% TP targets. Only 6/37 trades reached TP. Winning trades average 4.6% but stagnated trades average 8.6% distance. A 20-90% moonshot would be caught, but 80% of trades stagnate before reaching TP.
2. **Binary alert system** — Whale transfers classified as `warning` trigger SL tightening to breakeven, but Presto Research shows single whale transfers have R²=0.002-0.05 (near zero predictive power). 4/6 production alerts were harmless whale moves.
3. **No trade classification** — All trades get identical exit logic regardless of pattern, momentum, or volatility context. A dip buy bounce and a breakout moonshot share the same 16h stagnation timeout.

## System 1: Tiered Exit Engine

Replaces the single TP/SL with a 3-tier partial exit system.

### Exit Tiers

At entry, the position is logically split into three tiers. Each tier has its own target and exit method.

| Tier | % of Position | Target | Method | After Fill |
|------|--------------|--------|--------|------------|
| T1 | `t1_pct_{type}` (50/40/25%) | `t1_atr_mult × ATR` above entry | Software-managed check each cycle | Move SL to breakeven |
| T2 | `t2_pct_{type}` (30/30/30%) | `t2_atr_mult × ATR` above entry | Software-managed check each cycle | Activate ratcheting trail on T3 |
| T3 | `t3_pct_{type}` (20/30/45%) | No fixed target | Ratcheting trailing stop | Rides until trail triggers |

### ATR Multipliers by Trade Type

| Trade Type | T1 mult | T2 mult | Trail mult | Stagnation |
|------------|---------|---------|------------|------------|
| Scalp | 1.5 | 3.0 | 1.5 | 4h |
| Standard | 2.0 | 4.0 | 2.0 | 16h |
| Moonshot | 3.0 | 6.0 | 2.5 | 48h |

### Ratcheting Trailing Stop (T3)

The trailing distance widens as unrealized profit increases — gives winners more room to fluctuate:

| Unrealized Profit | Trail Distance |
|-------------------|---------------|
| 0-5% | `trail_atr_mult_{type}` (from trade type table above) |
| 5-10% | `ratchet_5pct_mult` × ATR |
| 10-20% | `ratchet_10pct_mult` × ATR |
| 20%+ | `ratchet_20pct_mult` × ATR |

The initial trail distance (0-5% band) uses the trade type's `trail_atr_mult` — no separate config key needed.

Additionally, if the position hasn't made a new high in `ratchet_stale_hours` (default 24h), tighten trail by `ratchet_stale_reduction` × ATR (prevents stagnant positions from giving back gains).

**ATR source:** The signal payload from Python engine already includes `atr` and `atr_percent` fields (computed by QuantGuild). TypeScript reads ATR from the signal — no independent OHLCV fetch needed. ATR period is controlled by `indicators.atr_period` in cryonix.toml (default 14).

### Position Data Model

Current Redis position object extended with exit plan:

```typescript
interface ExitPlan {
  tradeType: 'scalp' | 'standard' | 'moonshot';
  moonshotScore: number;          // 0-100 at entry
  atr: number;                    // ATR(12) at entry time
  t1Price: number;                // T1 target price
  t1Pct: number;                  // Fraction to sell at T1 (0.4)
  t1Filled: boolean;
  t2Price: number;
  t2Pct: number;                  // Fraction to sell at T2 (0.3)
  t2Filled: boolean;
  t3TrailMult: number;            // Current trail multiplier (ratchets up)
  t3TrailPrice: number;           // Current trail stop price
  originalQuantity: number;       // Full position size at entry
  remainingQuantity: number;      // After partial sells
  breakeven: boolean;             // SL moved to breakeven after T1
  highWaterMarkAt: string;            // ISO timestamp of last new highWaterMark
}
```

### Execution Mechanics

**Partial sell flow:**
1. Monitor loop detects `currentPrice >= t1Price` and `!t1Filled`
2. Calculate sell quantity: `Math.floor(originalQuantity * t1Pct)` (round down to avoid dust)
3. Check minimum order value: `sellQty * currentPrice >= MIN_ORDER_VALUE`
4. If too small to split: sell 100% at T1 instead (graceful fallback for tiny positions)
5. Execute market sell for T1 quantity via CCXT
6. Update position: `remainingQuantity -= sellQty`, `t1Filled = true`
7. Move SL to entry price (breakeven)
8. Cancel and replace native SL order on Binance
9. Log partial exit to `position_history` with `close_reason: 'SOLD_TP'` and `metadata: { tier: 'T1', partial: true, remaining_qty: ... }`. Use existing close_reason taxonomy (SOLD_TP/SOLD_SL/SOLD_TRAILING/SOLD_STAGNATION) — tier info goes in metadata JSONB to avoid breaking analytics/calibration consumers.

**Minimum split threshold:** If `originalQuantity * t1Pct * currentPrice < MIN_ORDER_VALUE`, skip tiered exits and use single TP at T2 price. This prevents dust orders on small positions.

**Native SL order lifecycle:**
- At entry: place native SL for full quantity at original SL price
- After T1 fill: cancel old SL, place new SL for remaining quantity at breakeven price
- After T2 fill: cancel old SL, place new SL for T3 quantity at current trail price
- Trail updates: cancel and replace native SL every time trail price changes by > 0.5%

### Stagnation Handling

Stagnation timeout is set per trade type (see table above) but can be overridden by Grok's `stagnationOverrideHours` (already wired in production).

Stagnation exit sells the **entire remaining position**, not just one tier. If T1 has filled but T2/T3 haven't, stagnation sells all remaining quantity.

## System 2: Trade Classification (Moonshot Detection)

At entry time, each signal receives a **moonshot score** (0-100) that determines which exit profile to use.

### Scoring Factors

| Factor | Score | Detection Method |
|--------|-------|-----------------|
| Volume > 2× 20-period average | +30 | Already available in QuantGuild volume_spike detection |
| Bollinger squeeze → expansion | +20 | Already detected as BOLLINGER_SQUEEZE pattern |
| Multi-timeframe alignment (15m + 4h both bullish) | +25 | Requires HTF context fetch (already fetched by backtester) |
| ATR expanding (current ATR > 1.5× ATR 20 periods ago) | +15 | Computed from OHLCV data |
| RSI between 50-65 (momentum building, not overbought) | +10 | Already computed in QuantGuild |

### Classification Thresholds

| Score | Trade Type | Exit Profile |
|-------|-----------|-------------|
| 0-29 | Scalp | Tight targets, fast exits |
| 30-69 | Standard | Current-like behavior with tiered exits |
| 70-100 | Moonshot | Wide targets, long stagnation, big T3 allocation |

### Implementation Location

Moonshot scoring happens in two places:

1. **Python engine (QuantGuild):** Compute score alongside pattern detection. Add `moonshot_score` field to signal payload pushed to Redis.
2. **Auto-trade route (TypeScript):** Read score from signal. If missing (legacy signals), default to Standard (score=50).

### Pattern-to-Type Mapping (Fallback)

If moonshot scoring is not yet computed, use pattern-based heuristics:

| Pattern | Default Type |
|---------|-------------|
| DIP_BUY | Scalp |
| DEEP_VALUE_CRASH | Standard |
| BOLLINGER_SQUEEZE | Standard |
| BOLLINGER_SQUEEZE + VOLUME_SPIKE | Moonshot candidate |
| Any pattern + volume > 2x | Upgrade one tier |

## System 3: Intelligent Alert System

Replaces the current binary (warning/critical) alert system with a 4-tier, context-aware classification.

### Severity Levels

| Severity | TTL | Trigger | Example |
|----------|-----|---------|---------|
| **info** | 30 min | Routine activity, single data point, no confirmed threat | Single whale transfer, market maker rebalancing, cold wallet shuffle |
| **warning** | 2h | Multiple confirming signals, regulatory concern | Cluster of whale deposits, SEC filing, negative regulatory news |
| **critical** | 6h | Confirmed threat to asset value | Verified exploit/hack, smart contract vulnerability, confirmed fund drain |
| **emergency** | 12h | Acute existential threat, multi-source confirmed | Active hack with funds draining, confirmed rug pull, exchange insolvency |

### Alert Data Model (Redis)

Key: `sentiment:alert:{SYMBOL}` (unchanged)

```json
{
  "severity": "info",
  "reason": "Single whale transfer of 5,000 ETH to Binance",
  "source": "@WhalAlert",
  "detected_at": "2026-03-11T09:30:28Z",
  "confirmed_count": 1,
  "context": {
    "direction": "to_exchange",
    "magnitude": "low",
    "wallet_type": "unknown",
    "cluster": false,
    "event_age": "hours",
    "timing_uncertain": false
  }
}
```

Fields:
- **`confirmed_count`** — Starts at 1, incremented each x_sentiment cycle that confirms the same alert type. Resets on severity change.
- **`context`** — Structured metadata from Grok:
  - `direction`: `to_exchange` | `from_exchange` | `internal` | `unknown`
  - `magnitude`: `low` (<1% daily volume) | `medium` (1-5%) | `high` (>5%)
  - `wallet_type`: `exchange` | `market_maker` | `vc_fund` | `whale` | `unknown`
  - `cluster`: whether multiple wallets are making the same move
  - `event_age`: `minutes` | `hours` | `days` | `unknown`
  - `timing_uncertain`: if the tweet doesn't have clear timestamp

### Grok Prompt (x_sentiment.py)

Replace current on-chain alert instructions with:

```
5. On-chain risk assessment: For each coin, search @lookonchain, @WhalAlert,
   @rektfeed, @OnchainLens for on-chain activity.

   CLASSIFICATION RULES:
   - SINGLE whale transfer to exchange = "info" (routine ~80% are benign:
     MM rebalancing, OTC settlement, cold wallet shuffling)
   - Only ESCALATE whale moves to "warning" when:
     * CLUSTER: multiple distinct wallets → same exchange within hours
     * MAGNITUDE: transfer > 5% of coin's daily volume
     * KNOWN SELLER: wallet identified as long-term holder (not MM/exchange)
   - HACK/EXPLOIT/RUG = always "critical" minimum
     * If funds actively draining = "emergency"
   - REGULATORY: SEC action, delist notice = "warning"
     * Confirmed enforcement action = "critical"

   FRESHNESS RULES:
   - Only report events from the LAST 4 HOURS
   - If a tweet references an event without clear timestamp: timing_uncertain=true
   - Old news (>4h) = "info" regardless of content

   For each alert, provide context:
   - direction: "to_exchange" | "from_exchange" | "internal" | "unknown"
   - magnitude: "low" (<1% daily vol) | "medium" (1-5%) | "high" (>5%)
   - wallet_type: "exchange" | "market_maker" | "vc_fund" | "whale" | "unknown"
   - cluster: true if multiple wallets making same move
   - event_age: "minutes" | "hours" | "days" | "unknown"
```

### Confirmation Counter

When `x_sentiment.py` finds an alert for a symbol that already has one in Redis:

1. Read existing alert: `GET sentiment:alert:{SYMBOL}`
2. Parse JSON, compare `severity`:
   - Same severity → increment `confirmed_count`, refresh TTL
   - Higher severity → replace alert, reset `confirmed_count` to 1
   - Lower severity → keep existing (don't downgrade until TTL expires)
3. Write updated alert: `SETEX sentiment:alert:{SYMBOL} {TTL} {json}`

### Consumer Reactions

Each consumer interprets alerts independently based on its context:

**BUY filter (new trades):**

| Severity | confirmed_count | Action |
|----------|----------------|--------|
| info | any | Pass — no impact |
| warning | 1 | Pass — log only |
| warning | ≥2 | Block BUY |
| critical | any | Block BUY |
| emergency | any | Block BUY |

**Position monitor (open positions):**

| Severity | confirmed_count | Action |
|----------|----------------|--------|
| info | any | No action |
| warning | 1 | Log — no SL change |
| warning | ≥2 | Tighten SL to breakeven (entry × 0.9995) |
| critical | any | Tighten SL to breakeven |
| emergency | any | Force close via market sell |

**Freshness guard:** If `timing_uncertain: true`, treat as max `info` regardless of stated severity.

**Grid filter:**

| Severity | Action |
|----------|--------|
| info | Pass |
| warning | Pass |
| critical+ | Block grid buys |

### Key Differences from Current System

1. Single whale transfers: `warning` → `info` (no action)
2. `warning` with 1 confirmation: SL tightened → only logged
3. Grid buys: blocked on all warnings → only blocked on critical+
4. Only `emergency` force-closes (was: `critical`)
5. Freshness check prevents stale tweets from triggering actions
6. Confirmation counter prevents single-source false positives

## Integration Points

### How the three systems connect:

```
Signal arrives from Redis trades:pending
    │
    ├─ Trade Classification (System 2)
    │   └─ Compute moonshot score → assign trade type
    │
    ├─ Alert Check (System 3)
    │   └─ Read sentiment:alert:{SYMBOL} → block/pass per consumer rules
    │
    ├─ Grok AI Validation (existing)
    │   └─ Returns estimatedMinutesToTarget, stagnationThresholdHours
    │
    └─ Entry Execution
        └─ Create position with ExitPlan (System 1)
            ├─ Compute ATR(12) at entry
            ├─ Set T1/T2/T3 prices based on trade type
            ├─ Place native SL on Binance
            └─ Store full exit plan in Redis position

Position Monitoring Loop (every 30s):
    │
    ├─ Check T1 target → partial sell → SL to breakeven
    ├─ Check T2 target → partial sell → activate ratcheting trail
    ├─ Update ratcheting trail (widen with profit)
    ├─ Check trail trigger → sell T3
    ├─ Check stagnation (timeout per trade type)
    ├─ Check alerts (System 3) → react per consumer rules
    └─ Update velocity/ETA (existing TimingService)
```

### Config (cryonix.toml additions)

```toml
[exits]
# Tiered exit system
tiered_exits_enabled = true
min_split_value = 7.50          # Min order value for partial sells ($)

# ATR multipliers per trade type (scalp / standard / moonshot)
t1_atr_mult_scalp = 1.5
t1_atr_mult_standard = 2.0
t1_atr_mult_moonshot = 3.0

t2_atr_mult_scalp = 3.0
t2_atr_mult_standard = 4.0
t2_atr_mult_moonshot = 6.0

trail_atr_mult_scalp = 1.5
trail_atr_mult_standard = 2.0
trail_atr_mult_moonshot = 2.5

# Tier allocation percentages (per trade type)
t1_pct_scalp = 0.50
t1_pct_standard = 0.40
t1_pct_moonshot = 0.25

t2_pct_scalp = 0.30
t2_pct_standard = 0.30
t2_pct_moonshot = 0.30

t3_pct_scalp = 0.20
t3_pct_standard = 0.30
t3_pct_moonshot = 0.45

# Stagnation per trade type (hours)
stagnation_scalp = 4
stagnation_standard = 16
stagnation_moonshot = 48

# Ratcheting trail thresholds
ratchet_5pct_mult = 2.0
ratchet_10pct_mult = 2.5
ratchet_20pct_mult = 3.0
ratchet_stale_hours = 24       # Tighten trail if no new high in this many hours
ratchet_stale_reduction = 0.5  # Reduce trail mult by this when stale

[moonshot]
enabled = true
volume_threshold = 2.0          # Volume vs 20-period avg
atr_expansion_threshold = 1.5   # Current ATR vs ATR 20 periods ago
moonshot_threshold = 70         # Score above this = moonshot
scalp_threshold = 30            # Score below this = scalp

[alerts]
severity_ttl_info = 1800        # 30 min
severity_ttl_warning = 7200     # 2h
severity_ttl_critical = 21600   # 6h
severity_ttl_emergency = 43200  # 12h
freshness_max_hours = 4         # Ignore events older than this
min_confirmations_for_action = 2
```

## Migration Strategy

1. **Phase 1:** Alert system redesign — standalone, no dependencies. Update `x_sentiment.py` prompt + `auto-trade/route.ts` consumer logic.
2. **Phase 2:** Trade classification — add moonshot scoring to QuantGuild + signal payload. Default all existing signals to Standard.
3. **Phase 3:** Tiered exits — the largest change. New exit plan data model, partial sell logic, ratcheting trail. Requires careful testing with min order sizes.

Each phase is independently deployable and provides value on its own. Phase 1 stops false SL tightening today. Phase 2 is informational until Phase 3 lands. Phase 3 is the moonshot enabler.

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Partial sell creates dust (unsellable remainder) | Round quantities down, check min order value before each partial sell. Fallback: sell 100% at T1 if position too small to split. |
| Native SL order management complexity | Cancel-and-replace pattern. If cancel fails, old SL still protects. Log warnings for manual review. |
| Moonshot score miscalibration | Default to Standard (score=50) for unknown patterns. Monitor actual moonshot trade performance in calibration pipeline. Persist `moonshot_score` and `trade_type` in position metadata for calibration analysis. |
| Alert confirmation counter gaming | TTL resets on confirmation, so stale alerts expire. Max TTL is 12h even for emergency. |
| Grok returns timing_uncertain but high severity | Freshness guard caps at `info`. Explicit rule, not dependent on Grok compliance. |
| Existing open positions lack ExitPlan on deploy | Monitor loop null-checks `exitPlan`. If missing, create a default Standard exit plan from the position's existing `takeProfit` and `stopLoss` values. T1 = midpoint(entry, takeProfit), T2 = takeProfit, trail = current trailing stop. |
| Emergency force-close mechanics | Cancel native SL order first, then market sell full remaining quantity. If market sell partially fills, retry once after 5s. Log to position_history with `close_reason: 'SOLD_EMERGENCY'`. Ignore MIN_ORDER_VALUE for emergency exits. |
| Grid positions | Grid positions (`isGridPosition: true`) skip tiered exits and continue using single TP. Grid positions are rare under dip_focus_mode and have separate risk budgets. |
| Multi-timeframe data for moonshot scoring | The HTF alignment factor (+25 points) requires 4h candle data not currently fetched by MarketScoutTank. Phase 2 implementation: fetch 4h candles once per symbol per cycle (cached 4h in Redis). Alternatively, skip this factor initially and cap moonshot score at 75 max without it. |

## Telegram Notifications

Partial exits generate Telegram messages:

| Event | Message |
|-------|---------|
| T1 filled | `📊 T1 HIT: Sold 40% of {SYMBOL} @ ${price} (+{pnl}%). SL → breakeven. Remaining: {qty}` |
| T2 filled | `📊 T2 HIT: Sold 30% of {SYMBOL} @ ${price} (+{pnl}%). Trail active on {qty} remaining.` |
| T3 trail triggered | `📊 TRAIL EXIT: Sold final {qty} of {SYMBOL} @ ${price} (+{pnl}%). Position closed.` |
| Stagnation exit | `⏳ STAGNATION: Sold all remaining {SYMBOL} @ ${price} ({pnl}%). No movement in {hours}h.` |
| Emergency close | `🚨 EMERGENCY CLOSE: {SYMBOL} force-sold @ ${price}. Reason: {alert.reason}` |
