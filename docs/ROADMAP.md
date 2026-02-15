# 🗺️ Cryonix Agent Army — Long-Term Roadmap

> **$42 → $10,000+** — Economic targets tied to technical milestones.  
> Last updated: 2026-02-15  
> Status: Active — Currently in **Fas 1**

---

## Legend

### KPI Keys
- **Win Rate** — % winning trades (rolling 30-day)
- **EV** — Expected Value per trade (from calibration model)
- **Sharpe** — Risk-adjusted return (annualized)
- **Max Drawdown** — Largest peak-to-trough decline (%)
- **Uptime** — % system time without crash per 24h

### Symbols
- 💸 Portfolio target
- 📈 Minimum P&L target
- 🟢 Fee/efficiency improvement
- 🟩 Software gate (must ship before progressing)
- 🟦 Measurement/data gate
- 🟪 Process/methodology gate

---

## Fas 0–1: Proof of Survivability

> **Goal**: System doesn't die and doesn't lose money fast.  
> **Timeline**: Now → 30 days of stable data  
> **Capital**: $42+

| Target | Value | How |
|--------|-------|-----|
| 💸 Starting capital | $42+ | Current balance |
| 📈 Daily P&L | ≥ $0 (break-even) | Metrics dashboard |
| Win Rate | >45% (current baseline) | Track via Postgres |
| Uptime | >96%/day (>23h without crash) | Heartbeat monitor |
| Max Drawdown | <15% | Circuit breaker (existing) |

### 🟩 Technical Gates

- [ ] **Python Engine crash fix** — Identify and fix root cause of 4-6h crash cycle (exception handling in MarketScout scan loop, Redis connection drops, CCXT rate-limit errors, pandas memory leaks)
- [ ] **Trailing stop patch** — Don't activate trailing stop until position has reached ≥1×ATR profit. Current `TRAILING_STOP_PCT: 3.0%` conflicts with `3×ATR` initial SL when ATR < 3% of price
- [ ] **Heartbeat/liveness monitor** — Alert via Telegram when Python Engine or Auto-Trader goes silent for >5 min

### 🟦 Measurement Gates

- [ ] Daily P&L tracking in Postgres (already partially exists via `trades` table)
- [ ] Uptime metric logged per service (engine, auto-trader, web)
- [ ] Win rate calculated on rolling 30-day window

### Existing Code Status
```
✅ 3×ATR stop-loss (quant.py)
✅ Telegram alerts (telegram-interactive.mjs)
✅ Morning brief + daily summary scheduled
✅ Telegram Signal Scraper (3 channels, log-only Phase 1)
⚠️  Trailing stop needs ATR-gating (config exists, logic needs update)
🔴 Python Engine crash stability
```

---

## Fas 2: Systematic Edge (Break-even → +EV)

> **Goal**: Proven positive expected value over 30 days.  
> **Timeline**: Month 2–3  
> **Capital**: $100+ (manual deposit when Fas 1 KPIs met)

| Target | Value | How |
|--------|-------|-----|
| 💸 Portfolio | $100+ | Manual top-up after Fas 1 proof |
| 📈 Monthly P&L | ≥ $0, targeting +$1–5/month | Calibration + EV filter |
| Win Rate | ≥ 55% (rolling 30d) | Pattern EV filter |
| Sharpe | > 0.5 | Metrics dashboard |
| Max Drawdown | < 10% | RiskManager limits |
| Uptime | > 98% (max 1 crash/week) | Improved error handling |

### 🟩 Technical Gates

- [ ] **Calibration EV → mechanical trade filter** — Currently `calibrate.py` generates weights and `route.ts` passes `evCtx` to GROK AI as context only. Must mechanically reject patterns with negative EV (weight = 0)
- [ ] **Central Capital Allocator** — New component that budgets capital between Signal strategy (60%), Grid strategy (30%), Reserve (10%). Currently no budget boundary exists — grid's hardcoded `$6/level` can consume 35% of total capital
- [ ] **Unified Risk Manager** — Replace 3 separate risk managers (Python `risk_manager.py`, TS `risk-manager-agent.ts`, inline in `route.ts`) with single source of truth via Redis state
- [ ] **GainerScanner pipeline verification** — Code reads `scanner:top_movers` from Redis and boosts signals +10% confidence. Verify GainerScanner process writes consistently (especially during crash recovery)
- [ ] **Activate Telegram Signal Boost** — Scraper deployed (Phase 1, log-only since 2026-02-15). After 1-2 weeks of quality data from 3 channels (CoinCodeCap, Fat Pig Signals, Raven Trading Pro), set `CONFIDENCE_BOOST_ENABLED=true` to enable +5-12% confidence boost when external signals converge with internal QuantGuild signals

### 🟦 Measurement Gates

- [ ] Weekly performance report (automated, Telegram)
- [ ] Pattern-level P&L breakdown (per-pattern win rate, EV, sample size)
- [ ] Fee drag tracking (total fees paid / total capital as monthly %)

### Existing Code Status
```
✅ calibrate.py generates EV weights per pattern
✅ GainerScanner boost logic in auto-trader route
✅ Evolution pipeline (GROK + Copilot CLI, every 2h)
✅ Telegram Signal Scraper live (3 channels → Redis + Postgres)
⚠️  Telegram boost disabled (Phase 1 observation period)
⚠️  EV weights used as AI context, not mechanical filter
🔴 No Capital Allocator between strategies
🔴 3 separate RiskManagers with different limits
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
| 💸 Portfolio | $500+ | Compounding + manual deposit |
| 📈 Monthly P&L | ≥ $10/month (+2%/month) | Margin efficiency |
| Win Rate | ≥ 57–58% | Refined patterns |
| Sharpe | > 1.0 | Clear risk-adjusted edge |
| Max Drawdown | < 12% | Tighter risk controls |
| 🟢 Fee drag | < 30% of Fas 1 levels | Fewer trades, better entries |

### 🟩 Technical Gates

- [ ] **Activate margin mode** — Already fully implemented! Change `SPOT_ONLY: true` → `false`, set `TRADING_MODE: 'margin'`, sync Python engine config
- [ ] **Short-selling operational** — `executeMarginSell()` exists in `route.ts`. SELL signals currently generated but never executed. Enable execution path
- [ ] **Exit optimization** — Implement break-even stop (move SL to entry after 2×ATR profit), partial take-profit (sell 50% at 3×ATR, let rest ride)
- [ ] **Fee monitoring** — Track maker/taker fees per trade, optimize for maker orders where possible
- [ ] **>99% uptime** — System must auto-recover from crashes without manual intervention

### 🟦 Measurement Gates

- [ ] Monthly Sharpe ratio calculation
- [ ] Margin utilization tracking
- [ ] Short vs long performance comparison

### Existing Code Status
```
✅ Margin mode fully coded (config.py: TRADING_MODE="margin", MARGIN_TYPE="cross")
✅ executeMarginSell() complete with margin params
✅ Liquidation buffer in RiskManager (15%)
✅ Leverage safety check (liquidation distance calculation)
⚠️  SPOT_ONLY hardcoded to true in auto-trader
⚠️  Python engine defaults to margin but auto-trader defaults to spot (mismatch)
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
| 💸 Portfolio | $1,500–$5,000 | Compounding + deposits + loans |
| 📈 Monthly P&L | $25–$100/month | Leveraged positions |
| Win Rate | ≥ 60% (rolling 30–90d) | Mature strategy |
| Sharpe | > 1.2 | Consistent risk-adjusted returns |
| Max Drawdown | < 15% | Loan-aware risk management |
| 🟢 Fee drag | < 15% monthly, EV > 0.3/trade | Optimized execution |

### 🟩 Technical Gates

- [ ] **Binance Loan API integration** — New endpoints: borrow, repay, adjust LTV ([API docs](https://developers.binance.com/docs/crypto_loan/Introduction))
- [ ] **LoanManager Agent** — New agent that:
  - Monitors loan LTV every minute
  - Auto-repays if LTV > 70%
  - Auto-deleverages positions if LTV > 73%
  - Emergency: sell all + repay if LTV > 78%
  - Never borrows more than 30% of collateral value (not 65% max)
- [ ] **Loan cost tracking** — Track interest paid per loan, include in P&L calculations
- [ ] **Failover/backup** — No single point of failure. If primary goes down, positions are protected by Binance-native SL orders (already partially implemented)
- [ ] **Multi-strategy position sizing** — All strategies (signal, grid, loan-boosted) budgeted from Central Capital Allocator

### 🟦 Measurement Gates

- [ ] Loan health dashboard (LTV, interest accrued, collateral value)
- [ ] Risk/reward ratio per strategy type
- [ ] Stress test results (what happens in 20% market crash with current loan exposure)

### Prerequisites
```
⚠️ CRITICAL: Do NOT enter Fas 4 without:
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
| 💸 Portfolio | $10,000+ | External capital + compounding |
| 📈 Monthly P&L | $150+/month | Scaled strategies |
| Win Rate | ≥ 62% | ML-optimized patterns |
| Sharpe | > 1.5 | Institutional-grade risk-adjusted returns |
| Max Drawdown | < 20% | Multi-layer protection |

### 🟩 Technical Gates

- [ ] **Multi-exchange support** — CCXT abstracts this, but only Binance configured. Add Bybit/OKX for diversification
- [ ] **ML-driven position sizing** — Replace static Kelly with learned parameters from historical performance
- [ ] **Compliance ready** — KYC/AML requirements at >$10k levels. Legal review needed
- [ ] **Client reporting** — Status page, daily performance emails, audit trail
- [ ] **Full redundancy** — Failover servers, database replication, position reconciliation

### 🟦 Measurement Gates

- [ ] External audit of trading history
- [ ] Stress test documentation
- [ ] 12+ months of continuous positive performance data

---

## Progress Summary

| Fas | Capital | Monthly P&L | Key Technical Gate | Key KPI |
|-----|---------|-------------|-------------------|---------|
| **1** ← Current | $42–$100 | ±$0 | Crash fix + trailing SL | Uptime >96%, WR >45% |
| **2** | $100–$500 | $0–$10 | EV filter + Capital Allocator | WR ≥55%, Sharpe >0.5 |
| **3** | $500–$1,500 | $10–$30 | Margin mode + short selling | WR ≥57%, Sharpe >1.0 |
| **4** | $1,500–$5,000 | $25–$100 | Loan API + LoanManager | WR ≥60%, Sharpe >1.2 |
| **5** | $10,000+ | $150+ | Multi-exchange + ML sizing | WR ≥62%, Sharpe >1.5 |

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

## Existing Infrastructure Map

| Component | Status | Relevant Fas |
|-----------|--------|-------------|
| QuantGuild (8 pattern detectors) | ✅ Production | All |
| GROK AI validation (second opinion) | ✅ Production | All |
| Kelly Criterion position sizing | ✅ Production (3 implementations) | All |
| Market regime detection (ADX) | ✅ Production | All |
| Higher timeframe filter (1h+4h) | ✅ Production | All |
| Evolution pipeline (GROK+Copilot) | ✅ Production | All |
| Telegram bot (commands + alerts) | ✅ Production | All |
| Grid trading (GridGuild) | ✅ Production | All |
| Backtest engine | ✅ Production | All |
| Calibration EV model | ✅ Production | Fas 2+ |
| GainerScanner boost | ✅ Production | Fas 2+ |
| X/Twitter sentiment scanning | ✅ Production | Fas 2+ |
| Telegram Signal Scraper (3 channels) | ✅ Production (log-only) | Fas 1–2 |
| Telegram convergence boost (+5-12%) | ⚠️ Coded, disabled (Phase 1) | Fas 2 |
| Margin mode (cross, 3x) | ✅ Coded, disabled | Fas 3 |
| Short selling (executeMarginSell) | ✅ Coded, disabled | Fas 3 |
| Binance native SL orders | ✅ Production | Fas 3+ |
| Capital Allocator | ✅ Production | Fas 2 |
| Unified RiskManager | 🔴 Not built | Fas 2 |
| LoanManager Agent | 🔴 Not built | Fas 4 |
| Multi-exchange | 🔴 Not built | Fas 5 |
| ML position sizing | 🔴 Not built | Fas 5 |