# Cryonix Agent Army — Long-Term Roadmap

> **$42 → $10,000+** — Economic targets tied to technical milestones.
> Last updated: 2026-02-15
> Status: Active — Currently in **Fas 1** (final validation)

---

## Legend

### KPI Keys
- **Win Rate** — % winning trades (rolling 30-day)
- **EV** — Expected Value per trade (from calibration model)
- **Sharpe** — Risk-adjusted return (annualized)
- **Max Drawdown** — Largest peak-to-trough decline (%)
- **Uptime** — % system time without crash per 24h

### Symbols
- [x] = Done / shipped
- [ ] = Not yet done
- **Bold** = Critical gate

---

## Fas 0–1: Proof of Survivability

> **Goal**: System doesn't die and doesn't lose money fast.
> **Timeline**: Now → 30 days of stable data
> **Capital**: $42+ (current: ~$41.47 live on Binance)

| Target | Value | Status |
|--------|-------|--------|
| Starting capital | $42+ | ~$41.47 (dynamic from Binance) |
| Daily P&L | >= $0 (break-even) | Tracking via trades table |
| Win Rate | >45% (baseline) | Tracking via Postgres |
| Uptime | >96%/day (>23h) | 0 crashes last 24h, all 8 containers UP |
| Max Drawdown | <15% | Circuit breaker active |

### Technical Gates

- [x] **Python Engine crash fix** — Fixed CCXT connection leak (singleton pattern), improved exception handling in MarketScout scan loop, Redis reconnection logic. Engine now shows 0 tracebacks, 0 restarts, 41min+ stable uptime after latest deploy.
- [x] **Heartbeat/liveness monitor** — `scripts/health-monitor.sh` runs every 5 min via cron. Checks all containers + services. Alerts via Telegram if anything is down.
- [x] **NOTIONAL dust handling** — Positions below Binance's $5 minimum order value are detected and written off as dust (close-side). Buy-side adds 1.5x buffer ($7.50 minimum) to prevent future dust positions.
- [x] **Instance lock (multi-instance safety)** — Redis distributed lock (`instance:trading_lock`) with SET NX + 90s TTL prevents multiple Docker environments from trading the same Binance account. Returns 409 if lock held by another instance.
- [x] **Auto-deploy** — Cron-based pull deploy (every 1 min) checks `origin/main` for new commits, auto-builds all containers. Stashes uncommitted changes before reset to protect agent work-in-progress.
- [x] **Engine diagnostics** — `scripts/strategy-lab/engine_diagnostik.py` — full diagnostic report: container health, resource usage, crash analysis, connectivity checks, all container statuses.
- [x] **X-sentiment standalone** — `scripts/strategy-lab/x_sentiment.py` — standalone Python script replacing broken HTTP-based cron. Calls Grok API directly, writes to Redis with same key schema.
- [x] **Strategy optimization** — Widened SL (3*ATR → 3.5*ATR), widened TP (4.5*ATR → 5*ATR), $7.50 position floor, dynamic capital from Binance, 25% per position sizing for small accounts.
- [ ] **Trailing stop ATR-gating** — Don't activate trailing stop until position has reached >=1*ATR profit. Config exists (`TRAILING_STOP_PCT: 3.0%`), logic needs update to gate on ATR profit threshold.

### Measurement Gates

- [x] Daily P&L tracking in Postgres (via `trades` table — 24 trades logged)
- [x] Uptime metric via health-monitor.sh (every 5 min)
- [ ] Win rate calculated on rolling 30-day window (needs dashboard view)

### Current Code Status
```
[x] 3.5*ATR stop-loss (quant.py) — widened from 3*ATR
[x] 5*ATR take-profit (quant.py) — widened from 4.5*ATR
[x] Telegram alerts (telegram-interactive.mjs)
[x] Morning brief + daily summary scheduled
[x] Health monitor cron (every 5 min)
[x] Auto-deploy cron (every 1 min)
[x] Instance lock (Redis SET NX)
[x] NOTIONAL dust handling
[x] Dynamic capital from Binance (no hardcoded value)
[x] $7.50 minimum position size
[ ] Trailing stop ATR-gating
```

### Current Risk Limits (Fas 1)
```
TOTAL_CAPITAL: 0               (dynamic from Binance, currently ~$41.47)
MAX_POSITION_SIZE_PCT: 0.25    (25% per position, ~$10 at current capital)
MAX_OPEN_POSITIONS: 3          (realistic for ~$41 capital)
MAX_SIGNAL_POSITIONS: 2
MAX_GRID_POSITIONS: 1
MAX_TRADES_PER_DAY: 6
MAX_DAILY_LOSS_PCT: 0.05       (5%)
MIN_CONFIDENCE: 0.65
SAFE_MIN_POSITION: $7.50       (1.5x Binance NOTIONAL minimum)
```

### Fas 1 Remaining Work
1. **Trailing stop ATR-gating** — gate on >=1*ATR profit before activating
2. **30-day rolling win rate dashboard** — aggregate from trades table
3. **Collect 30 days of stable data** — validate KPIs before Fas 2 transition
4. **GROK AI approval rate** — Currently ~8% (12 signals → 1 approved). May need prompt tuning to avoid being too conservative

---

## Fas 2: Systematic Edge (Break-even → +EV)

> **Goal**: Proven positive expected value over 30 days.
> **Timeline**: Month 2–3
> **Capital**: $100+ (manual deposit when Fas 1 KPIs met)

| Target | Value | How |
|--------|-------|-----|
| Portfolio | $100+ | Manual top-up after Fas 1 proof |
| Monthly P&L | >= $0, targeting +$1–5/month | Calibration + EV filter |
| Win Rate | >= 55% (rolling 30d) | Pattern EV filter |
| Sharpe | > 0.5 | Metrics dashboard |
| Max Drawdown | < 10% | RiskManager limits |
| Uptime | > 98% (max 1 crash/week) | Improved error handling |

### Technical Gates

- [ ] **Calibration EV → mechanical trade filter** — `calibrate.py` generates weights and `route.ts` passes `evCtx` to GROK AI as context only. Must mechanically reject patterns with negative EV (weight = 0)
- [x] **Central Capital Allocator** — Budgets capital between Signal strategy (60%), Grid strategy (30%), Reserve (10%). Regime-aware (volatile → pause grid, halve signal sizes).
- [ ] **Unified Risk Manager** — Replace 3 separate risk managers (Python `risk_manager.py`, TS `risk-manager-agent.ts`, inline in `route.ts`) with single source of truth via Redis state
- [x] **GainerScanner pipeline** — Reads `scanner:top_movers` from Redis, boosts signals +10% confidence. Verified working.
- [ ] **Python backtester** — Current TS backtester uses its own pattern detectors, NOT quant.py. Must build Python backtester that tests actual strategy (3.5*ATR SL, 5*ATR TP, QuantGuild patterns). See Backtesting Gap section below.

### Measurement Gates

- [ ] Weekly performance report (automated, Telegram)
- [ ] Pattern-level P&L breakdown (per-pattern win rate, EV, sample size)
- [ ] Fee drag tracking (total fees paid / total capital as monthly %)

### Existing Code Status
```
[x] calibrate.py generates EV weights per pattern
[x] GainerScanner boost logic in auto-trader route
[x] Evolution pipeline (GROK + Copilot CLI, every 2h)
[x] Capital Allocator (regime-aware, strategy budgets)
[ ] EV weights used as AI context, not mechanical filter
[ ] Unified RiskManager (3 separate ones exist)
[ ] Python backtester for quant.py strategy
```

### Key Risk Limits for Fas 2
```
MAX_POSITION_SIZE_PCT: 0.12    (12% per position)
MAX_OPEN_POSITIONS: 6          (reduced from 10)
MAX_TRADES_PER_DAY: 4          (reduced from 6 to lower fee drag)
MAX_DAILY_LOSS_PCT: 0.05       (5%)
MIN_CONFIDENCE: 0.65
```

---

## Fas 3: Compounding & Margin/Micro-Leverage

> **Goal**: Stable growth, unlock short-selling and margin.
> **Timeline**: Month 4–6
> **Capital**: $500+

| Target | Value | How |
|--------|-------|-----|
| Portfolio | $500+ | Compounding + manual deposit |
| Monthly P&L | >= $10/month (+2%/month) | Margin efficiency |
| Win Rate | >= 57–58% | Refined patterns |
| Sharpe | > 1.0 | Clear risk-adjusted edge |
| Max Drawdown | < 12% | Tighter risk controls |
| Fee drag | < 30% of Fas 1 levels | Fewer trades, better entries |

### Technical Gates

- [ ] **Activate margin mode** — Fully implemented. Change `SPOT_ONLY: true` → `false`, set `TRADING_MODE: 'margin'`, sync Python engine config
- [ ] **Short-selling operational** — `executeMarginSell()` exists in `route.ts`. SELL signals generated but never executed. Enable execution path
- [ ] **Exit optimization** — Break-even stop (move SL to entry after 2*ATR profit), partial take-profit (sell 50% at 3*ATR, let rest ride)
- [ ] **Fee monitoring** — Track maker/taker fees per trade, optimize for maker orders
- [ ] **>99% uptime** — System must auto-recover from crashes without manual intervention

### Measurement Gates

- [ ] Monthly Sharpe ratio calculation
- [ ] Margin utilization tracking
- [ ] Short vs long performance comparison

### Existing Code Status
```
[x] Margin mode fully coded (config.py: TRADING_MODE="margin", MARGIN_TYPE="cross")
[x] executeMarginSell() complete with margin params
[x] Liquidation buffer in RiskManager (15%)
[x] Leverage safety check (liquidation distance calculation)
[ ] SPOT_ONLY hardcoded to true in auto-trader
[ ] Python engine defaults to margin but auto-trader defaults to spot (mismatch)
```

### Margin Risk Limits
```
DEFAULT_LEVERAGE: 3              (conservative)
MARGIN_TYPE: 'cross'
max_leverage: 3
liquidation_buffer_pct: 0.15     (15% buffer before liquidation)
```

---

## Fas 4: Loans & External Capitalization

> **Goal**: Leverage via Binance Crypto Loans when edge is proven.
> **Timeline**: Month 7–12
> **Capital**: $1,500–$5,000

| Target | Value | How |
|--------|-------|-----|
| Portfolio | $1,500–$5,000 | Compounding + deposits + loans |
| Monthly P&L | $25–$100/month | Leveraged positions |
| Win Rate | >= 60% (rolling 30–90d) | Mature strategy |
| Sharpe | > 1.2 | Consistent risk-adjusted returns |
| Max Drawdown | < 15% | Loan-aware risk management |
| Fee drag | < 15% monthly, EV > 0.3/trade | Optimized execution |

### Technical Gates

- [ ] **Binance Loan API integration** — New endpoints: borrow, repay, adjust LTV
- [ ] **LoanManager Agent** — Monitor LTV, auto-repay >70%, auto-deleverage >73%, emergency sell >78%, max 30% of collateral
- [ ] **Loan cost tracking** — Track interest per loan, include in P&L
- [ ] **Failover/backup** — No single point of failure. Binance-native SL orders as safety net
- [ ] **Multi-strategy position sizing** — All strategies budgeted from Central Capital Allocator

### Prerequisites
```
CRITICAL: Do NOT enter Fas 4 without:
  - 30+ days of Fas 3 KPIs met (Sharpe >1.0, WR >57%, DD <12%)
  - 0 unplanned system crashes in past 14 days
  - Automated risk de-escalation proven working
  - LoanManager agent built and tested on testnet
```

---

## Fas 5: Mini-Fund — External Capital & Audit-Ready

> **Goal**: Professional-grade system capable of managing external capital.
> **Timeline**: Year 2+
> **Capital**: $10,000+

| Target | Value | How |
|--------|-------|-----|
| Portfolio | $10,000+ | External capital + compounding |
| Monthly P&L | $150+/month | Scaled strategies |
| Win Rate | >= 62% | ML-optimized patterns |
| Sharpe | > 1.5 | Institutional-grade risk-adjusted returns |
| Max Drawdown | < 20% | Multi-layer protection |

### Technical Gates

- [ ] **Multi-exchange support** — Add Bybit/OKX (CCXT abstracts this)
- [ ] **ML-driven position sizing** — Replace static Kelly with learned parameters
- [ ] **Compliance ready** — KYC/AML at >$10k levels
- [ ] **Client reporting** — Status page, performance emails, audit trail
- [ ] **Full redundancy** — Failover servers, DB replication, position reconciliation

---

## Backtesting Gap (Priority: Fas 2)

### Current State
A TypeScript backtester exists at `packages/agents/src/backtester/` with:
- Full OHLCV simulation engine (`backtester-engine.ts`)
- Walk-forward analysis, Monte Carlo simulation
- Web UI (`apps/web/src/app/backtest/page.tsx`) + API (`api/backtest/route.ts`)
- Performance metrics (40+ KPIs in `performance-metrics.ts`)
- CCXT historical data integration (`backtester-agent.ts`)

### Critical Problem
**The TS backtester uses its own TypeScript pattern detectors, NOT the Python `quant.py` engine.** This means:
- Cannot test the actual 3.5*ATR SL / 5*ATR TP strategy
- Cannot validate QuantGuild's 8 pattern detectors with historical data
- Cannot verify calibration weights against real performance
- Any parameter changes (like the SL/TP widening) cannot be backtested

### Recommended Solution
Build a **Python backtester** that calls `quant.py` directly:
- Feed historical OHLCV data into QuantGuild pattern detection
- Simulate position management with actual SL/TP/trailing stop logic
- Output standard metrics (win rate, Sharpe, max drawdown, per-pattern P&L)
- Compare against current TS backtester results for validation

This is a **Fas 2 priority** — without it, we cannot prove positive EV mechanically.

---

## Progress Summary

| Fas | Capital | Monthly P&L | Key Remaining Gate | Key KPI |
|-----|---------|-------------|-------------------|---------|
| **1** <- Current | $42 | +/-$0 | Trailing SL + 30d data | Uptime >96%, WR >45% |
| **2** | $100–$500 | $0–$10 | EV filter + Python backtest | WR >=55%, Sharpe >0.5 |
| **3** | $500–$1,500 | $10–$30 | Margin mode + shorts | WR >=57%, Sharpe >1.0 |
| **4** | $1,500–$5,000 | $25–$100 | Loan API + LoanManager | WR >=60%, Sharpe >1.2 |
| **5** | $10,000+ | $150+ | Multi-exchange + ML | WR >=62%, Sharpe >1.5 |

---

## Decision Framework

At each phase transition, ask:

> **"Should we invest more capital/tech — or evaluate and pause?"**

### Rules
1. **No phase transition without 30 days of KPI data** — No shortcuts
2. **Never add leverage/loans before edge is proven** — First survive, then scale
3. **Monthly post-mortem** — What failed, what worked, next checkpoint
4. **Automated risk de-escalation must exist before any leverage** — Market regime "volatile" → pause grid, halve position sizes, widen stops

---

## Infrastructure Map

| Component | Status | Relevant Fas |
|-----------|--------|-------------|
| QuantGuild (8 pattern detectors) | [x] Production | All |
| GROK AI validation (second opinion) | [x] Production | All |
| Kelly Criterion position sizing | [x] Production | All |
| Market regime detection (ADX) | [x] Production | All |
| Higher timeframe filter (1h+4h) | [x] Production | All |
| Evolution pipeline (GROK+Copilot) | [x] Production (every 2h) | All |
| Telegram bot (commands + alerts) | [x] Production (2 bots) | All |
| Grid trading (GridGuild) | [x] Production | All |
| Capital Allocator (regime-aware) | [x] Production | All |
| GainerScanner boost (+10%) | [x] Production | All |
| Binance native SL orders | [x] Production | All |
| Health monitor (5min cron) | [x] Production | All |
| Auto-deploy (1min cron) | [x] Production | All |
| Instance lock (Redis) | [x] Production | All |
| NOTIONAL dust handling | [x] Production | All |
| Engine diagnostics script | [x] Production | All |
| Calibration EV model | [x] Production | Fas 2+ |
| X/Twitter sentiment scanning | [x] Production (standalone Python) | Fas 2+ |
| Telegram signal scraper | [x] Production (Telethon/Docker) | Fas 2+ |
| TS Backtest engine | [x] Production (limited — see gap) | Fas 2+ |
| Margin mode (cross, 3x) | Coded, disabled | Fas 3 |
| Short selling (executeMarginSell) | Coded, disabled | Fas 3 |
| Python backtester (quant.py) | Not built | Fas 2 |
| Unified RiskManager | Not built | Fas 2 |
| LoanManager Agent | Not built | Fas 4 |
| Multi-exchange | Not built | Fas 5 |
| ML position sizing | Not built | Fas 5 |
