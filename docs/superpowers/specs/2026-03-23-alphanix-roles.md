# Alphanix — Agent Role Descriptions

**Date:** 2026-03-23
**Status:** Draft
**Companion to:** [alphanix-design.md](./2026-03-23-alphanix-design.md)

## Purpose

This document describes the five core roles in the Alphanix pod system. Each role maps directly to an AI agent implementation, but is described here in terms of its real-world hedge fund equivalent — the "pod model" pioneered by firms like Millennium Management, Citadel, and Jane Street.

Understanding the human role is essential for building the AI agent correctly: the agent must replicate not just the tasks, but the decision-making style, information diet, and failure modes of its human counterpart.

---

## 1. Portfolio Manager (PM) / Orchestrator Agent

### The Role

The Portfolio Manager is the pod's CEO and chief strategist. In a pod fund, the PM has one job that supersedes all others: **allocate capital to maximize risk-adjusted returns while keeping drawdown within the fund's tolerance**. They do not write models. They do not execute trades. They decide *where the money goes* and *when to pull the plug*.

At Millennium, each PM runs a pod with a hard drawdown limit (typically 5%). Breach it and the pod is liquidated — no second chances. This brutal Darwinism is what makes the pod model work: only strategies that survive real capital allocation persist.

### Responsibilities

| Area | Description |
|------|-------------|
| **Capital allocation** | Distribute capital across strategies, models, and pods. Shift allocation dynamically based on regime, volatility, and strategy performance. |
| **Macro awareness** | Synthesize macro trends (interest rates, geopolitical risk, sector rotation) into strategic directives for quants. |
| **Strategy activation** | Decide which strategies are active, paused, or retired. A strategy with decaying alpha gets cut, regardless of how elegant the model is. |
| **Team coordination** | Ensure quant, risk, execution, and data agents are aligned. Resolve conflicting signals between agents. |
| **Drawdown management** | Monitor portfolio-level drawdown. Trigger de-risking (reduce position sizes, pause new entries) before hard limits are breached. |
| **Pod lifecycle** | Spawn new pods when alpha opportunities emerge in new markets. Shut down pods that consistently underperform. |

### KPIs

| Metric | Target | Description |
|--------|--------|-------------|
| **Sharpe Ratio** | > 1.5 | Risk-adjusted returns (annualized) |
| **Total P&L** | Positive monthly | Net profit across all pods |
| **Max Drawdown** | < 10% | Worst peak-to-trough decline |
| **Capital Utilization** | 60-90% | Avoid both over-exposure and idle capital |
| **Pod Health Score** | All pods green | Composite of per-pod metrics |

### Technical Profile

- Deep macro understanding: can interpret central bank minutes, yield curve inversions, sector rotation signals
- Can read Python/C++ code and review quant models at a conceptual level — does not need to be the best coder
- Strong intuition for statistical distributions: knows when a Sharpe of 4.0 is too good to be true
- Familiar with portfolio construction theory (mean-variance, risk parity, Black-Litterman)

### Psychological Profile

- **Extreme stress tolerance** — Must function cleanly during drawdowns, flash crashes, and regime changes
- **Decisive** — When data says cut a strategy, the PM cuts it. Hesitation costs money
- **Ego-free about data** — Kills losing models regardless of personal belief or sunk cost. The PM who falls in love with a strategy is the PM who blows up
- **Zoomed-out perspective** — While quants optimize individual signals, the PM thinks in terms of portfolio-level risk/reward
- **Communication clarity** — Every directive to the pod must be unambiguous. Vague instructions cause execution errors

### In Alphanix

Maps to the **Orchestrator agent** that sits above all pods. Implemented as the top-level decision loop that:
- Reads global state from Redis (all pod P&L, risk metrics, market regime)
- Runs capital allocation logic (regime-aware, strategy-budget-based)
- Issues directives to pods (increase/decrease allocation, pause/resume, spawn/kill)
- Owns the **global kill switch** — can halt all trading across all pods instantly
- Spawns global-level swarms (Macro analysis, ESG audit, cross-pod correlation checks)

### Hour-by-Hour in Alphanix

| Window | Activity |
|--------|----------|
| **Pre-market (04:00-08:00)** | Ingest overnight macro data (Asia session close, futures, FX). Run macro swarm for regime classification. Review overnight alerts from Risk agents. Compute fresh capital allocation targets for the day. Issue pre-market directives to each pod. |
| **Market open (08:30-10:30)** | Monitor opening volatility spike. Validate that execution agents are filling within slippage tolerance. Watch for gap opens that invalidate overnight analysis. Adjust allocation in real-time if regime shifts on open. |
| **Intraday (10:30-15:00)** | Steady-state monitoring. Review pod-level P&L every 15 minutes. Check cross-pod correlation (are all pods long the same risk factor?). Spawn research swarms if new alpha signals emerge from data feeds. |
| **Market close (15:00-17:30)** | Review daily P&L across all pods. Trigger end-of-day risk reconciliation. Decide overnight exposure (flatten, hold, hedge). Issue close-of-day report to Telegram. |
| **Post-market (18:00-19:00)** | Run daily performance attribution (which strategies contributed, which detracted). Update strategy scores and decay tracking. Plan next-day allocation. Archive daily state snapshot to Postgres. |

---

## 2. Quantitative Researcher ("The Brain") / Quant Agent

### The Role

The Quantitative Researcher is the intellectual engine of the pod. In the real world, this person often holds a PhD in physics, mathematics, statistics, or computer science. They are hired not for their knowledge of finance (which can be taught) but for their ability to find hidden structure in noisy data.

At Jane Street, quants are expected to build, test, and deploy a new trading model within weeks. The model does not need to be revolutionary — it needs to be *correct*, statistically robust, and profitable after transaction costs. The best quants are not the ones with the most complex models; they are the ones who know when a model is broken.

### Responsibilities

| Area | Description |
|------|-------------|
| **Alpha research** | Analyze massive datasets for statistical edges that survive out-of-sample testing. Sources include price data, order flow, sentiment, alternative data (satellite, social, on-chain). |
| **Model development** | Build and iterate on mathematical trading models. Combine weak signals into strong composite signals using ensemble methods. |
| **Backtesting** | Rigorous historical testing with proper methodology: walk-forward validation, no look-ahead bias, realistic transaction costs, slippage modeling. |
| **Strategy decay tracking** | Monitor the "half-life" of each strategy. All alpha decays — the question is how fast. When a strategy's edge erodes below transaction costs, flag it for retirement. |
| **Signal combination** | Merge signals from multiple timeframes, data sources, and model types into a unified confidence score. |
| **Feature engineering** | Transform raw market data into predictive features. This is where most alpha lives — not in the model architecture, but in the input features. |

### KPIs

| Metric | Target | Description |
|--------|--------|-------------|
| **Information Coefficient (IC)** | > 0.03 | Correlation between predicted and actual returns |
| **Strategies in production** | 3-8 per pod | Diversification of alpha sources |
| **Strategy shelf life** | > 3 months | Time before edge decays below threshold |
| **Backtest-to-live ratio** | > 0.5 | Live performance should be at least 50% of backtest |
| **False discovery rate** | < 10% | Percentage of "alpha" that was actually overfitting |

### Technical Profile

- Master of Python, Pandas, NumPy, SciPy, and at least one ML framework (TensorFlow, PyTorch, XGBoost)
- Extreme probability theory and linear algebra — can derive a Kelly criterion from scratch
- Comfortable with time-series analysis: autocorrelation, cointegration, regime switching models
- Understands information theory (entropy, mutual information) for feature selection
- Can implement custom statistical tests (permutation tests, bootstrap confidence intervals)

### Psychological Profile

- **Patient** — Alpha research takes weeks or months. Premature deployment of an unfinished model is worse than no model at all
- **Extremely detail-oriented** — A single indexing error in a backtest can turn a losing strategy into a false winner. The quant checks everything twice
- **Skeptical by default** — Assumes any model that looks too good probably has a bug. The first reaction to a Sharpe of 5.0 is not excitement but suspicion
- **Comfortable with ambiguity** — Markets are not physics. There are no exact solutions, only probabilistic edges
- **Intellectually honest** — Reports negative results with the same rigor as positive ones. Hiding a failed experiment wastes everyone's time

### In Alphanix

Maps to the **Quant agent** in each pod. Implemented as the signal generation and model management layer that:
- Receives normalized market data from the Data agent (never touches raw broker APIs)
- Runs signal generation models (pattern detection, statistical arbitrage, momentum, mean-reversion)
- Spawns **backtest swarms** — ephemeral worker threads that run walk-forward backtests on new model candidates
- Publishes signals with confidence scores, expected value, and decay metadata
- Maintains a model registry: active models, paused models, retired models with full performance history
- Tracks IC and strategy decay in real-time, auto-flags degrading models to the PM

### Hour-by-Hour in Alphanix

| Window | Activity |
|--------|----------|
| **Pre-market (04:00-08:00)** | Ingest overnight data. Run feature engineering pipeline on new data. Check for regime changes that invalidate active models. Recalibrate model parameters if needed (adaptive, not overfitting). Spawn pre-market backtest swarm for any overnight research ideas. |
| **Market open (08:30-10:30)** | Generate opening signals based on gap analysis and overnight flow. Feed high-confidence signals to Risk agent for validation. Monitor live signal accuracy in real-time (does the market move in the predicted direction?). |
| **Intraday (10:30-15:00)** | Continuous signal generation on every new data tick. Run real-time IC tracking (rolling 20-trade window). If IC drops below threshold, flag model degradation. Spawn research swarms for anomaly investigation when unusual patterns appear. |
| **Market close (15:00-17:30)** | Generate end-of-day signals (different alpha factors dominate at close). Run daily model performance scoring. Update strategy decay curves. Publish daily signal accuracy report. |
| **Post-market (18:00-19:00)** | Run full backtest refresh on all active models with today's data included. Compare live performance to backtest expectations. Queue overnight research tasks (new feature candidates, alternative data exploration). Archive model state to Postgres. |

---

## 3. Execution Trader / Execution Engine Agent

### The Role

The Execution Trader is the tactical bridge between model and market. The quant says "buy 10,000 shares of AAPL." The execution trader's job is to buy those 10,000 shares at the best possible price, ideally without anyone noticing that a large buyer has entered the market.

This is harder than it sounds. Modern markets are adversarial environments. High-frequency trading (HFT) algorithms constantly scan order flow for signs of large institutional orders. If they detect one, they front-run it — buying ahead of you and selling back at a higher price. The execution trader's art is stealth and precision.

At Citadel Securities, execution algorithms are the firm's core product. They route orders across dozens of venues (exchanges, dark pools, ATS), splitting a single large order into thousands of micro-transactions timed to minimize market impact.

### Responsibilities

| Area | Description |
|------|-------------|
| **Order execution** | Translate signal instructions into market orders. Choose the right order type (limit, market, stop-limit, iceberg) based on urgency and market conditions. |
| **Execution algorithms** | Implement and select from execution strategies: VWAP (Volume-Weighted Average Price), TWAP (Time-Weighted Average Price), Iceberg (hidden quantity), Sniper (aggressive fill). |
| **Order splitting** | Break large orders into smaller child orders to minimize market impact. Timing and sizing of child orders is critical. |
| **Venue selection** | Route orders to the venue with the best price, lowest fee, and deepest liquidity. In crypto, this means choosing between CEX order books, DEX AMMs, and aggregators. |
| **Detection avoidance** | Randomize order timing and sizing to avoid pattern detection by adversarial HFT algorithms. |
| **Market microstructure** | Understand bid-ask spreads, order book depth, hidden liquidity, fee tiers, and maker/taker dynamics for each venue. |

### KPIs

| Metric | Target | Description |
|--------|--------|-------------|
| **Slippage** | < 0.1% avg | Difference between expected and actual fill price |
| **TCA (Transaction Cost Analysis)** | Minimize | Total cost including fees, spread, and market impact |
| **Fill rate** | > 95% | Percentage of orders successfully filled |
| **Execution speed** | < 100ms | Time from signal receipt to order submission |
| **Detection rate** | 0% | Times our order pattern was front-run |

### Technical Profile

- Strong in C++, Rust, or high-performance TypeScript — execution code must be fast
- Intuitive understanding of game theory: every order is a move in a game against other market participants
- Deep knowledge of market microstructure: order book mechanics, price-time priority, maker/taker fee structures
- Experience with exchange APIs (REST, WebSocket, FIX protocol) and their latency characteristics
- Understanding of network optimization: co-location, connection pooling, message serialization

### Psychological Profile

- **Lightning-fast reactions** — When a flash crash happens, the execution agent must halt fills or exploit the dislocation within milliseconds
- **Ice-cold under volatile conditions** — A 5% candle is not a reason to panic; it is a data point that changes the optimal execution strategy
- **Extremely disciplined** — Follows the execution algorithm precisely. Deviating because "it feels right" is how you get caught by HFT predators
- **Detail-obsessed about fees** — A 1 basis point fee difference across 10,000 trades is real money
- **Zero ego** — The execution trader's job is not to have opinions about direction. The quant decided the direction. The execution trader's only job is to fill at the best price

### In Alphanix

Maps to the **Execution Engine** that routes through the adapter layer. Implemented as the order management system that:
- Receives validated signals from Risk (never directly from Quant — Risk must approve first)
- Selects execution algorithm based on order size, urgency, and market conditions
- Routes through the appropriate adapter (BinanceAdapter, AlpacaAdapter, etc.)
- Monitors fill quality in real-time and adjusts child order strategy dynamically
- Reports execution quality metrics (slippage, TCA) back to the PM and Quant for feedback
- Places native stop-loss orders as a safety net immediately after entry fill

### Hour-by-Hour in Alphanix

| Window | Activity |
|--------|----------|
| **Pre-market (04:00-08:00)** | Check exchange/broker connectivity and API health. Verify fee tier status. Pre-cache order book snapshots for watchlist symbols. Validate that all adapter connections are live. Review overnight queue for any pre-market orders (crypto markets are 24/7). |
| **Market open (08:30-10:30)** | Execute opening signals with wide slippage tolerance (opening auction is chaotic). Use TWAP for large orders to spread across the high-volume opening window. Monitor fill quality aggressively — opening spreads can be 3-5x normal. Avoid iceberg orders at open (too easy to detect in thin pre-market books). |
| **Intraday (10:30-15:00)** | Steady-state execution. Use VWAP as default algorithm. Switch to Sniper for urgent risk-reduction orders from CRO. Monitor spread widening as a signal of deteriorating liquidity. Continuously report TCA metrics. Handle partial fills and re-queue unfilled portions. |
| **Market close (15:00-17:30)** | Execute closing orders with awareness of end-of-day volume patterns. Flatten positions that the PM has marked for overnight de-risk. Handle MOC (Market-On-Close) equivalent orders. Final reconciliation: verify all fills match expected positions. |
| **Post-market (18:00-19:00)** | Run daily TCA report (per-order slippage, per-venue cost analysis). Identify execution quality outliers. Report any failed or rejected orders. Update venue ranking based on today's fill quality. For crypto pods: continue 24/7 execution with reduced size limits. |

---

## 4. Chief Risk Officer (CRO) / Risk Manager Agent

### The Role

The Chief Risk Officer is the pod's immune system. Every other role in the pod exists to make money. The CRO's primary job is **not to make money, but to prevent catastrophic loss**. This asymmetry is intentional and critical.

In the real world, the CRO has veto power over the PM. If the CRO says "cut this position," it gets cut — even if the PM disagrees. This independence is what prevents the kind of concentrated bets that destroyed Long-Term Capital Management, Archegos, and FTX. The CRO answers to the fund level, not the pod level.

At Millennium, risk management is so strict that pods are automatically liquidated if they breach their drawdown limit. The risk system is not advisory — it is autonomous and has kill authority.

### Responsibilities

| Area | Description |
|------|-------------|
| **Stress testing** | Run historical crash scenarios (2008 GFC, 2020 COVID, 2022 LUNA/FTX) and hypothetical scenarios (50% BTC crash, Fed emergency hike, exchange hack) against current portfolio. |
| **Exposure control** | Monitor and limit concentration risk: sector exposure, currency exposure, single-asset exposure, volatility regime exposure. No single position should threaten the portfolio. |
| **Kill switches** | Program and monitor algorithmic circuit breakers. Daily loss limit, position-level stop-loss, portfolio drawdown limit, correlation spike detector. |
| **Independent validation** | Validate every signal from Quant before it reaches Execution. Reject signals that violate risk parameters, regardless of confidence score. |
| **Correlation monitoring** | Detect when seemingly independent strategies become correlated (a hidden risk that killed many funds in 2008). |
| **Regulatory compliance** | Ensure trading stays within legal limits: position size limits, wash trading prevention, PDT rules (equities), leverage limits. |

### KPIs

| Metric | Target | Description |
|--------|--------|-------------|
| **Portfolio Volatility** | Within regime target | Annualized vol matching the PM's risk budget |
| **Beta** | < 0.3 | Low correlation to broad market (alpha, not beta) |
| **Max Drawdown** | < 10% | Worst peak-to-trough, ever |
| **VaR Breach Rate** | < 5% | Daily losses exceeding 95% VaR should be rare |
| **Black Swan Survival** | 100% | Must survive 3-sigma events without liquidation |
| **Signal Rejection Rate** | 15-40% | Too low means rubber-stamping; too high means over-filtering |

### Technical Profile

- Deep statistics: Value at Risk (VaR), Conditional VaR (CVaR/Expected Shortfall), extreme value theory
- Portfolio risk decomposition: factor models, PCA on returns, Greek calculations (delta, gamma, vega)
- Monte Carlo simulation for scenario generation
- Knowledge of financial regulation (SEC, MiFID II, exchange-specific rules)
- Codes in Python/R for risk model development; reads C++/Rust execution code for audit

### Psychological Profile

- **Analytically pessimistic** — The CRO's job is to imagine everything that can go wrong. Optimism is a liability in this role
- **Integrity-driven** — Must be comfortable saying "no" to the PM, even when the PM is convinced. The CRO who capitulates under pressure is useless
- **Independent thinker** — Cannot be swayed by groupthink or recent performance ("we've been winning, so we can take more risk" is how funds die)
- **Calm in crisis** — During a market crash, the CRO must think clearly while everyone else is panicking. This is when the CRO earns their salary
- **Process-oriented** — Risk management is about systems, not heroics. The CRO who "has a feeling" about risk is dangerous; the CRO who has a model is valuable

### In Alphanix

Maps to the **Risk Manager agent** with ESG/Planetary Boundary checks added. Implemented as the validation and monitoring layer that:
- Sits between Quant and Execution — every signal must pass Risk validation before execution
- Has **veto power** — can reject signals regardless of confidence score
- Runs continuous portfolio risk monitoring (exposure, correlation, drawdown)
- Owns all circuit breakers: daily loss limit, position-level stops, portfolio kill switch
- Performs stress tests on-demand and on-schedule (daily pre-market, after significant events)
- Monitors cross-pod correlation (alerts the Orchestrator if pods become correlated)
- Includes **ESG/Planetary Boundary checks** — can block investments that violate sustainability criteria
- Reports directly to the Orchestrator, not to the pod's PM (independence by design)

### Hour-by-Hour in Alphanix

| Window | Activity |
|--------|----------|
| **Pre-market (04:00-08:00)** | Run overnight stress tests against current portfolio (flash crash, exchange hack, regulatory announcement scenarios). Check all circuit breaker thresholds. Review overnight news for risk events. Calculate fresh VaR and exposure limits for the day. Validate pre-market signals from Quant. |
| **Market open (08:30-10:30)** | Heightened monitoring mode. Watch for gap opens that blow through stop levels. Validate all opening signals with tighter-than-normal risk parameters (opening is the most dangerous period). Monitor portfolio beta in real-time — opening moves can spike correlation. Ready to trigger kill switch if daily loss limit approaches in the first hour. |
| **Intraday (10:30-15:00)** | Continuous monitoring: position-level P&L, portfolio drawdown, sector exposure, correlation matrix. Validate intraday signals from Quant. Run ad-hoc stress tests if unusual market conditions emerge (VIX spike, bond market dislocation, stablecoin depeg). Flag concentration risk to PM if any single position exceeds 15% of portfolio. |
| **Market close (15:00-17:30)** | Review end-of-day exposure. Validate PM's overnight holding decisions against risk parameters. Calculate overnight VaR (wider confidence interval for overnight gaps). Verify all stop-loss orders are correctly placed for held positions. Final daily risk report to PM and Orchestrator. |
| **Post-market (18:00-19:00)** | Run full daily risk reconciliation. Compare actual losses to VaR predictions (backtest the risk model itself). Update correlation matrices with today's data. Archive risk state snapshot. Generate risk report for Telegram. Flag any positions that need attention overnight (crypto pods running 24/7). |

---

## 5. Data Engineer / Tech Lead / Data Agent

### The Role

The Data Engineer is the system architect who builds the highway that data and orders travel on. Without this role, the quant has no data to analyze, the execution engine has no connection to markets, and the risk manager has no real-time portfolio state to monitor.

In a quantitative fund, the Data Engineer is often the least visible but most critical team member. When the system works, nobody notices. When it breaks — even for seconds — the fund can lose millions. At Two Sigma, the data engineering team maintains petabytes of alternative data (satellite imagery, credit card transactions, shipping manifests) that feed the quant models. The data must be collected, cleaned, normalized, and served with sub-millisecond latency.

### Responsibilities

| Area | Description |
|------|-------------|
| **Data pipelines** | Build and maintain pipelines that collect, clean, validate, and structure terabytes of real-time and historical data from dozens of sources. |
| **System architecture** | Design the overall system for minimal latency and maximum reliability. Every millisecond of latency in the data pipeline is a millisecond of stale data feeding the quant models. |
| **Data quality** | Implement data validation at every stage. A single corrupt data point (wrong price, missing volume, timezone error) can cause a model to generate a catastrophically wrong signal. |
| **Redundancy** | Build failover systems so that trading never goes down. If the primary data feed fails, the backup must take over within milliseconds. |
| **Monitoring** | Real-time system health monitoring: data freshness, pipeline latency, API rate limits, disk usage, memory pressure. |
| **Swarm infrastructure** | Build and manage the swarm spawning system — the mechanism by which ephemeral worker threads are created, prioritized, and cleaned up. |

### KPIs

| Metric | Target | Description |
|--------|--------|-------------|
| **System Uptime** | > 99.99% | Total system availability (4.3 min downtime/month max) |
| **Data Latency** | < 500ms | Time from market event to normalized data available to Quant |
| **Data Quality Score** | > 99.9% | Percentage of data points that pass validation checks |
| **Pipeline Recovery** | < 30s | Time to recover from a data feed failure via failover |
| **Memory Efficiency** | < 80% utilization | Must run within 4GB VM constraint |
| **Swarm Queue Depth** | < 10 pending | Swarm tasks should not accumulate |

### Technical Profile

- Advanced software engineering: system design, distributed systems, event-driven architecture
- Expert in time-series databases and data stores (Redis, Postgres, and in the hedge fund world: KDB+/q, InfluxDB, TimescaleDB)
- Strong in TypeScript/Python for pipeline code; C++/Rust literacy for performance-critical paths
- Deep Linux systems knowledge: process management, memory optimization, network tuning
- Experience with message queues, pub/sub systems, and streaming architectures
- Security awareness: API key management, network isolation, data encryption at rest and in transit

### Psychological Profile

- **Pragmatic** — Chooses boring, reliable technology over exciting, unproven technology. The data pipeline is not the place for experimentation
- **Security-focused** — Treats every API key, database credential, and network endpoint as a potential attack vector
- **Proactive** — Does not wait for failures. Monitors trends (growing latency, increasing error rates) and fixes problems before they become incidents
- **Documentation-driven** — A data pipeline that only one person understands is a single point of failure. Everything is documented, versioned, and reproducible
- **Resource-conscious** — On a 4GB VM, every megabyte matters. The Data Engineer constantly optimizes memory usage, connection pooling, and cache eviction

### In Alphanix

Maps to the **data feeds, normalizer pipeline, and swarm spawning infrastructure**. Implemented as the foundational layer that:
- Connects to all market data sources through the Adapter Layer (CCXT for crypto, Alpaca SDK for stocks, etc.)
- Runs the **data normalizer** — transforms raw exchange data into the unified format that Quant agents consume
- Manages the **swarm pool** — spawns worker threads for backtesting, OSINT collection, macro analysis on demand
- Enforces swarm budget limits (max concurrent workers, memory caps, priority queuing)
- Publishes real-time data to Redis for consumption by all pod agents
- Archives historical data to Postgres for backtesting
- Monitors system health: API rate limits, connection pool status, memory pressure, Redis queue depths
- Implements data validation at ingestion (reject corrupt ticks, handle exchange-specific quirks)

### Hour-by-Hour in Alphanix

| Window | Activity |
|--------|----------|
| **Pre-market (04:00-08:00)** | Validate all data feed connections are healthy. Run data quality checks on overnight data (crypto is 24/7 — check for gaps, anomalies, exchange maintenance windows). Pre-warm caches with historical data needed for morning signal generation. Check disk/memory usage and trigger cleanup if needed. Verify swarm pool is clean (no zombie workers from yesterday). |
| **Market open (08:30-10:30)** | Peak load management. Monitor data pipeline latency closely — opening tick volume can be 5-10x normal. Scale swarm budget if needed (allow more concurrent workers during high-activity windows). Watch for exchange API rate limit warnings. Handle data feed failovers if a source drops during the opening rush. |
| **Intraday (10:30-15:00)** | Steady-state monitoring. Serve data to all pod agents with minimal latency. Process swarm task queue (backtests, OSINT tasks, research queries from Quant). Monitor Redis memory usage and Postgres connection pool. Run periodic data integrity checks (compare data across sources for consistency). |
| **Market close (15:00-17:30)** | Handle closing auction data accurately (closing prices are critical for daily P&L calculations). Process end-of-day data snapshots. Archive intraday tick data to Postgres. Clean up completed swarm workers and reclaim memory. |
| **Post-market (18:00-19:00)** | Run daily data quality audit (completeness, accuracy, latency statistics). Compact and optimize data stores. Update data source health scores. Process overnight data collection tasks (alternative data, macro data, on-chain data for crypto pods). Generate system health report. Plan maintenance windows if needed. |

---

## Cross-Role Communication Map

```
         ┌───────────────────┐
         │   ORCHESTRATOR     │
         │   (PM Agent)       │
         │   Capital + Strategy│
         └─────┬───────┬─────┘
               │       │
    directives │       │ risk reports
               ▼       ▲
         ┌─────────────────┐
         │   RISK MANAGER   │◄── independent reporting line
         │   (CRO Agent)    │    to Orchestrator
         │   Veto + Monitor  │
         └───┬─────────┬───┘
    approved │         │ rejected
    signals  │         │ (with reason)
             ▼         │
         ┌─────────────────┐         ┌─────────────────┐
         │   EXECUTION      │◄────────│   QUANT          │
         │   (Exec Agent)   │ signals │   (Quant Agent)  │
         │   Fill + Route    │ (via    │   Model + Signal  │
         └────────┬────────┘ Risk)    └────────┬────────┘
                  │                             │
                  │ orders                      │ data requests
                  ▼                             ▼
         ┌─────────────────────────────────────────────┐
         │              DATA ENGINEER                    │
         │              (Data Agent)                     │
         │   Feeds · Normalization · Swarms · Infra      │
         └─────────────────────────────────────────────┘
```

### Key Communication Rules

1. **Quant never talks directly to Execution.** All signals must pass through Risk first. This prevents a quant bug from executing an unchecked trade.
2. **Risk reports to the Orchestrator independently.** The pod's PM cannot override Risk without the Orchestrator's explicit approval.
3. **Data serves everyone equally.** The Data agent has no trading opinions — it provides the same data quality to Quant, Risk, and Execution.
4. **The Orchestrator issues directives, not orders.** Pods have autonomy within their mandate. The Orchestrator sets the capital budget and strategy constraints; the pod decides how to trade within those constraints.
5. **Every agent logs every decision.** The audit trail is non-negotiable. When something goes wrong, the investigation starts with the logs.
