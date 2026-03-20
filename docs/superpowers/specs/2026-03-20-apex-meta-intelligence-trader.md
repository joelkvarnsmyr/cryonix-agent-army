# APEX — Adaptive Profit EXtraction

## Overview

APEX is the 8th trading instance in the Cryonix Agent Army. Unlike the other 7 instances which generate their own signals, APEX is a **meta-intelligence layer** that consumes signals from all existing instances and only trades when multiple independent sources confirm a high-conviction setup.

**Core thesis**: Each instance has a proven edge buried under noise. Cryonix dip patterns: 80-100% WR. Vedic Venus Rx shorts: 96.4% WR. Copynix single-whale: ~100% WR. APEX extracts only these proven edges and requires cross-instance confirmation before executing.

**Capital**: $950 USDC (paper trading)
**Autonomy**: Fully autonomous, Telegram alerts only
**Risk profile**: Aggressive on proven edges, zero exposure otherwise

---

## Architecture

### Signal Consumption (No Signal Generation)

APEX creates zero signals. It reads all 7 instances via Redis:

| Source | Redis Keys | Data Consumed |
|--------|------------|---------------|
| Cryonix | `trades:pending`, `positions:open` | DIP_BUY/DEEP_VALUE signals + confidence scores |
| Copynix | `copynix:positions`, `copynix:status`, `copynix:signals` (NEW) | Whale buy events with score, token, timestamp |
| Ψnix | `psinix:positions`, `psinix:status` | Kuramoto order parameter Ψ, coherence C, regime |
| Polymarket | `polymarket:crypto`, `polymarket:summary` | Sentiment 0-100, delta shifts ≥20pt |
| Aktienix | `aktienix:signals`, `aktienix:status` | Macro signals, crypto-correlated ticker moves |
| Solanix | `solanix:positions`, `solanix:status`, `solanix:stablecoin` | DexScreener momentum, token unlock warnings |
| Vedic | `vedic:planets` (EXISTING) | Venus/Mercury retrograde status, Moon speed |
| CMC | `cmc:fear_greed`, `cmc:global` | Fear & Greed index, BTC dominance trend |

**New Redis publishers required**:
- **Copynix**: Add `copynix:signals` key — publish whale buy events (score, token, direction, timestamp) from `copynix-agent.ts` consensus logic. Currently consensus data stays in-memory and is not exposed.
- **Aktienix**: The existing `aktienix:signals` key from `state-publisher.ts` can be read directly.

**No new external API integrations required** — all market data already flows through the other instances into Redis.

### Vedic Data (Existing `vedic:planets` Key)

The Vedic subsystem already publishes planetary data to `vedic:planets` via the VedicScout tank. This key contains retrograde status for all planets including Venus. APEX reads `vedic:planets` and extracts:
- `Venus.is_retrograde` → Venus Rx active/inactive
- `Mercury.is_retrograde` → Mercury Rx status
- Planet retrograde count (sum of `is_retrograde` across all planets)

No new publisher needed — the data is already there.

---

## Trading Modes

APEX operates in 3 distinct modes, each optimized for a specific proven edge:

### Mode 1: Venus Rx Harvest

**When**: Vedic Venus Retrograde cycle is active (~40 days, occurs ~once every 18 months)
**Market**: Binance Spot — simulated short via inverse position (sell at entry, rebuy lower). Binance Futures can be enabled later if account-level futures permissions are activated.
**Sizing**: 24% of capital per trade (quarter-Kelly optimal for WR=0.964)
**Symbols**: BTC, ETH, SOL, BNB (same as Vedic research validation set)

**Entry logic**:
- Venus Rx flag active in `vedic:planets` (Venus.is_retrograde = true)
- Wait for bearish confirmation from any source:
  - Cryonix RSI_OVERBOUGHT or MACD_BEARISH_CROSS signal
  - Ψnix coherence C ≥ 0.7 with bearish regime
  - CMC Fear & Greed dropping (delta ≤ -10 in 24h)
  - Polymarket crypto sentiment falling (delta ≤ -15)
- Grok AI validation (fail-closed)
- Execute simulated SHORT (sell existing holding or paper-track short entry)

**Exit**:
- TP: +8%
- SL: -3%
- Trailing: 3% (activation at +4%)
- Max hold: 15 days

**Expected performance**: 96.4% WR × +6.5% avg = exceptional risk-adjusted returns during active cycles. Dormant ~90% of the time (Venus Rx occurs ~once every 18 months). When active, this is the highest-edge mode in the entire system.

### Mode 2: Dip Sniper

**When**: Cryonix detects DIP_BUY or DEEP_VALUE_CRASH with cross-instance confirmation
**Market**: Binance Spot (USDC pairs)
**Sizing**: 20% of capital per trade (fractional Kelly based on 80-100% historical WR)

**Entry logic**:
- Cryonix DIP_BUY (confidence ≥70%) or DEEP_VALUE_CRASH (confidence ≥75%)
- PLUS at least one of:
  - Copynix whale buy on same symbol (score ≥80)
  - CMC Fear & Greed ≤ 25 (extreme fear)
  - Polymarket crypto sentiment rising (delta ≥+20)
  - Ψnix coherence C ≥ 0.7
- Grok AI validation (fail-closed)
- Execute BUY on Binance Spot

**Exit**:
- TP: +5%
- SL: -2.5%
- Trailing: 2% (activation at +2.5%)
- Max hold: 48 hours

**Expected performance**: 85%+ WR with tight exits. Higher frequency than Venus Rx — estimated 5-15 trades/month.

### Mode 3: Cross-Signal Confluence

**When**: 3+ independent instances signal the same direction on the same asset within a 5-minute window
**Market**: Best available (Binance spot for CEX crypto, Jupiter for Solana tokens, Alpaca for stocks)
**Sizing**: 15% of capital per trade

**Entry logic**:
- 3 or more instances produce a signal on the same asset (or correlated asset) within 5 minutes
- Confluence score ≥ 40 (see scoring below)
- Grok AI validation (fail-closed)
- Execute on the most liquid market for that asset

**Exit**:
- TP: +6%
- SL: -3%
- Trailing: 2.5% (activation at +3%)
- Max hold: 72 hours

**Expected performance**: 70%+ WR. Lower frequency — estimated 2-5 trades/month. Highest conviction when it fires.

---

## Confluence Scoring System

Every signal from every instance contributes points based on historical edge strength. Signals are direction-aware (bullish or bearish) — only signals matching the trade direction contribute.

**Bullish signals (BUY):**

| Signal | Points | Condition |
|--------|--------|-----------|
| Cryonix DEEP_VALUE_CRASH | +30 | confidence ≥ 75% |
| Cryonix DIP_BUY | +25 | confidence ≥ 70% |
| Copynix single-whale buy (≥80 score) | +25 | Same symbol, within 5min |
| Polymarket crypto sentiment rising | +15 | Delta ≥ +20 points |
| CMC Fear & Greed ≤ 25 (extreme fear) | +15 | Contrarian dip signal |
| Ψnix coherence C ≥ 0.7 (bullish regime) | +10 | Phase alignment confirmed, bullish |
| Solanix DexScreener volume spike | +10 | Top 10 trending + >$50K volume |
| Aktienix macro bullish signal | +5 | Crypto-correlated tickers rising |
| CMC BTC dominance falling | +5 | Altcoin rotation signal |

**Bearish signals (SHORT — Venus Rx mode only):**

| Signal | Points | Condition |
|--------|--------|-----------|
| Vedic Venus Rx active | +40 | Venus.is_retrograde = true in `vedic:planets` |
| Cryonix RSI_OVERBOUGHT | +20 | confidence ≥ 70% |
| Cryonix MACD_BEARISH_CROSS | +15 | confidence ≥ 65% |
| Polymarket crypto sentiment falling | +15 | Delta ≤ -15 points |
| CMC Fear & Greed dropping | +10 | F&G delta ≤ -10 in 24h |
| Ψnix coherence C ≥ 0.7 (bearish regime) | +10 | Phase alignment confirmed, bearish |
| CMC BTC dominance rising | +5 | Capital flight from alts |

### Execution Thresholds

| Confluence Score | Action | Sizing |
|-----------------|--------|--------|
| ≥ 60 | **TRADE** | Full fractional Kelly |
| 40-59 | **TRADE** | Half fractional Kelly |
| < 40 | **SKIP** | No trade |

### Example Scenarios

**Scenario A — Full Kelly BUY (score 70)**:
Cryonix DEEP_VALUE_CRASH on ETH (30) + Copynix whale buys ETH (25) + CMC F&G at 20 (15) = 70 → Full Kelly spot BUY

**Scenario B — Full Kelly SHORT (score 75)**:
Venus Rx active (40) + Cryonix RSI_OVERBOUGHT (20) + Polymarket crypto falling (15) = 75 → Full Kelly simulated SHORT

**Scenario C — Half Kelly BUY (score 50)**:
Cryonix DIP_BUY on SOL (25) + Polymarket crypto sentiment surging (15) + Ψnix coherence 0.75 (10) = 50 → Half Kelly spot BUY

**Scenario D — SKIP (score 25)**:
Only Cryonix DIP_BUY on DOGE (25), no other confirmation = 25 → SKIP

---

## Risk Management

### Position Sizing (Fractional Kelly)

Kelly fraction = 0.25 (quarter Kelly for survivability)

```
Kelly % = 0.25 × (WR × avg_win - (1 - WR) × avg_loss) / avg_win
```

Per-mode Kelly inputs (quarter-Kelly = cap):
- Venus Rx: WR=0.964, avg_win=8%, avg_loss=3% → quarter-Kelly ~24% per trade
- Dip Sniper: WR=0.85, avg_win=5%, avg_loss=2.5% → quarter-Kelly ~16% per trade → use 20% (slight overbet OK given high WR)
- Confluence: WR=0.70, avg_win=6%, avg_loss=3% → quarter-Kelly ~11% per trade → use 15%

### Circuit Breakers

| Rule | Threshold | Action |
|------|-----------|--------|
| Max drawdown | -10% from peak | Pause all trading for 24 hours |
| Daily loss limit | -5% in single day | Stop trading until next day |
| Consecutive losses | 3 in a row | Reduce sizing to 50% for next 5 trades |
| Max concurrent positions | 3 | Queue new signals until slot opens |

### Capital Allocation

```
Total: $950 USDC
├── Active trading: 80% ($760)
│   ├── Venus Rx reserve: 24% when active
│   ├── Dip Sniper: 20% per trade
│   └── Confluence: 15% per trade
└── Cash reserve: 20% ($190) — never deployed, emergency buffer
```

---

## Scan Loop

```
Every 15 seconds:
  1. Redis batch MGET — read all source keys in one roundtrip
  2. Normalize signals to common format { symbol, direction, source, confidence, timestamp }
  3. Run confluence scorer across all active signals
  4. For signals with score ≥ 40:
     a. Check risk gate (drawdown, daily limit, position count)
     b. Determine mode (Venus Rx > Dip Sniper > Confluence)
     c. Calculate Kelly sizing
     d. Grok AI validation (fail-closed)
     e. Execute on appropriate exchange
  5. Monitor open positions:
     a. Check TP/SL/trailing for each position
     b. Check max hold time
     c. Update trailing stop high-water marks
  6. Publish state to Redis `apex:state`
  7. Send Telegram alerts for entries/exits
```

---

## File Structure

```
packages/agents/src/apex/
  apex-agent.ts            # Main orchestrator — scan loop, mode selection
  confluence-scorer.ts     # Scoring system — reads Redis, computes points per symbol
  signal-aggregator.ts     # Normalizes signals from all 7 instances to common format
  risk-gate.ts             # Kelly sizing, circuit breakers, drawdown tracking
  exit-monitor.ts          # TP/SL/trailing per mode, max hold enforcement
  config.ts                # TOML loader for apex.toml

scripts/services/
  apex-runner.ts           # Docker entrypoint (same pattern as solanix-runner.ts)

apps/web/src/app/
  apex/page.tsx            # Dashboard page
  api/apex/status/route.ts # Status API endpoint

apex.toml                  # Configuration file
Dockerfile.apex            # Docker image (based on Dockerfile.solanix)
```

### apex.toml Structure

```toml
[general]
name = "APEX"
description = "Adaptive Profit EXtraction — Meta-Intelligence Trader"
mode = "paper"
capital = 950.0
currency = "USDC"
scan_interval_seconds = 15

[confluence]
min_score_full_kelly = 60
min_score_half_kelly = 40

[confluence.weights]
vedic_venus_rx = 40
cryonix_deep_value = 30
cryonix_dip_buy = 25
copynix_single_whale = 25
polymarket_sentiment_shift = 15
cmc_extreme_fear = 15
psinix_coherence = 10
solanix_volume_spike = 10
aktienix_macro_bullish = 5
cmc_btc_dom_falling = 5

[confluence.thresholds]
cryonix_min_confidence = 70
copynix_min_whale_score = 80
polymarket_min_delta = 20
cmc_max_fear_greed = 25
psinix_min_coherence = 0.7
confluence_window_seconds = 300

[risk]
kelly_fraction = 0.25
max_drawdown_pct = 10.0
daily_loss_limit_pct = 5.0
max_consecutive_losses = 3
loss_reduction_factor = 0.5
loss_reduction_trades = 5
max_concurrent_positions = 3
cash_reserve_pct = 20.0

[modes.venus_rx]
enabled = true
leverage = 2
max_leverage = 3
symbols = ["BTC/USDC", "ETH/USDC", "SOL/USDC", "BNB/USDC"]
sizing_pct = 24.0
tp_pct = 8.0
sl_pct = 3.0
trailing_pct = 3.0
trailing_activation_pct = 4.0
max_hold_hours = 360

[modes.dip_sniper]
enabled = true
sizing_pct = 20.0
tp_pct = 5.0
sl_pct = 2.5
trailing_pct = 2.0
trailing_activation_pct = 2.5
max_hold_hours = 48

[modes.confluence]
enabled = true
sizing_pct = 15.0
tp_pct = 6.0
sl_pct = 3.0
trailing_pct = 2.5
trailing_activation_pct = 3.0
max_hold_hours = 72

[telegram]
enabled = true
alert_on_entry = true
alert_on_exit = true
alert_on_circuit_breaker = true
```

---

## Dashboard — `/apex`

### Components

1. **Confluence Board** — Real-time table showing all symbols with their current confluence score, contributing signals, and score breakdown. Symbols above threshold highlighted.

2. **Mode Status** — Card showing which mode is currently active (Venus Rx Harvest / Dip Sniper / Confluence / Idle), with mode-specific metrics.

3. **Open Positions** — Table with: symbol, entry price, current price, P&L%, confluence score at entry, contributing signals, exit targets (TP/SL/trailing), time remaining before max hold.

4. **Trade History** — Table with: timestamp, symbol, mode, direction, entry/exit prices, P&L, confluence score, signals that triggered, hold duration.

5. **Performance Summary** — Total P&L, win rate, average trade, Sharpe ratio, max drawdown, per-mode breakdown.

### API Endpoint — `/api/apex/status`

Returns:
```json
{
  "status": "running" | "paused" | "circuit_breaker",
  "activeMode": "venus_rx" | "dip_sniper" | "confluence" | "idle",
  "capital": { "total": 950, "deployed": 190, "available": 570, "reserve": 190 },
  "positions": [...],
  "confluenceBoard": [{ "symbol": "BTC/USDC", "score": 45, "signals": [...] }],
  "performance": { "totalPnl": 0, "winRate": 0, "trades": 0, "maxDrawdown": 0 },
  "circuitBreaker": { "drawdown": 0, "dailyLoss": 0, "consecutiveLosses": 0 }
}
```

---

## Exchange Integration

APEX routes trades to the appropriate exchange based on mode and asset:

| Asset Type | Exchange | SDK | Existing? |
|-----------|----------|-----|-----------|
| CEX crypto (BTC, ETH, SOL, BNB) spot | Binance | CCXT | Yes (Cryonix) |
| Venus Rx shorts | Paper-simulated | Internal tracking | New (paper only — no Binance Futures needed) |
| Solana DEX tokens | Jupiter | @jup-ag/api | Yes (Solanix) |
| US stocks (if confluence includes Aktienix) | Alpaca | @alpacahq/alpaca-trade-api | Yes (Aktienix) |

APEX reuses existing exchange clients — no new API keys needed. Venus Rx shorts are paper-simulated (track entry price, compute P&L on exit) until Binance Futures is explicitly enabled at the account level.

### Symbol Normalization

Instances use different symbol formats. APEX normalizes via a mapping table:

| Instance | Format | Example | Normalized |
|----------|--------|---------|------------|
| Cryonix | `{BASE}/USDC` | `BTC/USDC` | `BTC` |
| Copynix | Solana mint address | `So11...` | `SOL` (via mint→symbol lookup) |
| Solanix | Solana mint address | `EPjF...` | `BONK` (via DexScreener metadata) |
| Aktienix | Ticker | `COIN` | `COIN` (stock, not directly tradeable on crypto) |
| Ψnix | `{BASE}/USDC` | `ETH/USDC` | `ETH` |

Cross-market correlation mappings (for Mode 3):
- `BTC` ↔ `MSTR`, `COIN` (crypto-correlated stocks)
- `ETH` ↔ `ETH/USDC` on Binance or wrapped SOL DEX
- Solana memecoins: only match within Solana DEX (no CEX equivalent)

### Deduplication with Source Instances

APEX and source instances may trade the same signal simultaneously. This is **intentional** — APEX only fires on high-confluence setups where doubling exposure is warranted. However:
- APEX tracks which source signals triggered its trade in `apex:trades` metadata
- The Overview dashboard shows combined exposure across all instances
- Circuit breakers operate independently per instance (APEX drawdown ≠ Cryonix drawdown)

### Signal Staleness Protection

Before scoring, APEX checks the `updated_at` or TTL of each Redis key:
- If a source key is older than **5 minutes**, that source's contribution is zeroed (treated as offline)
- If `vedic:planets` is older than **24 hours**, Venus Rx signal is zeroed
- Dashboard shows staleness warnings per source

---

## What APEX Does NOT Include (By Design)

- **No own signal generators** — pure consumer of existing signals
- **No Brain/Evolution system** — premature until edge is proven in paper trading
- **No backtester** — relies on historical data from constituent instances
- **No watchlist management** — trades whatever the other instances surface
- **No new external APIs** — everything comes from Redis

These can be added later if paper trading validates the confluence approach.

---

## Success Criteria

Paper trading for 30 days. Targets:

| Metric | Target | Rationale |
|--------|--------|-----------|
| Win Rate | ≥ 75% | Weighted average of constituent edges |
| Average Trade | ≥ +3% | Conservative vs Vedic 6.5% / Dip 3-5% |
| Max Drawdown | ≤ 10% | Circuit breaker enforced |
| Sharpe Ratio | ≥ 2.0 | High WR + controlled sizing |
| Monthly Return | ≥ +5% | On $950 capital |
| Trade Frequency | 5-20/month | Quality over quantity |

If targets are met after 30 days, consider:
1. Increase capital
2. Add Brain/Evolution system
3. Enable live trading (move from paper to real)
