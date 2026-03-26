# Alphanix Phase 3 Roadmap — Full Scale & Beyond

**Status:** Scope document (not implementation plan)
**Prerequisites:** Phase 1 fixes + Phase 2 intelligence must be complete
**Estimated effort:** 4-6 weeks of iterative development

---

## 1. Real Broker Integration

### What it does

Replace the Yahoo Finance simulator with a live IBKR (Interactive Brokers) Gateway connection. Support ISK (Investeringssparkonto) accounts for Swedish tax-optimized trading. Handle multi-currency portfolios (USD, SEK, EUR) with automatic FX conversion tracking. Implement real order types beyond simple market orders: limit orders, stop-limit orders, and bracket orders (entry + stop-loss + take-profit as a single atomic order group).

The `IBKRAdapter` stub from the design spec gets fully implemented against the `@stoqey/ib` library, conforming to the existing `MarketAdapter` interface. The adapter handles IBKR's TWS/Gateway connection lifecycle, including automatic reconnection and session management.

### Why it matters

Without a real broker, Alphanix is a simulation. IBKR provides access to 150+ markets across 33 countries from a single account, making it the only broker that matches Alphanix's multi-market ambitions. ISK accounts are critical for Swedish users because ISK is taxed on a flat schablonbelopp (standardized amount) rather than capital gains — for active traders, this can save 10-30% in taxes annually. Multi-currency handling prevents silent losses from untracked FX exposure.

### Key technical challenges

- IBKR Gateway runs as a separate Java process (IB Gateway or TWS). The adapter must manage this external dependency, detect disconnections, and handle the infamous "pacing violations" (max 60 messages/second).
- ISK accounts have restrictions: no short selling, no margin, no derivatives. The adapter must enforce these constraints before orders reach IBKR.
- Multi-currency P&L requires tracking the FX rate at time of trade and at time of close. Unrealized P&L changes with both asset price and FX rate — two moving targets.
- IBKR's API uses request IDs and callbacks, not simple REST. The adapter must bridge this to the promise-based `MarketAdapter` interface.

### Dependencies

- Adapter Layer from Phase 1 must be stable.
- Data Lake (Postgres) must support multi-currency position records.

### Priority: P1

This is the single most important Phase 3 feature. Everything else builds on having a real broker.

---

## 2. Commodity & Futures Adapters

### What it does

Build a CME (Chicago Mercantile Exchange) adapter for US futures markets, accessed through IBKR. Target contracts: natural gas (Henry Hub, NG — nicknamed "The Widowmaker" for its extreme volatility), crude oil (CL), wheat (ZW), and coffee (KC). Integrate NOAA weather data to drive energy and agricultural commodity signals — a polar vortex forecast triggers natural gas longs, a drought warning triggers wheat longs. Monitor USGS seismological data and catastrophe bond pricing as signals for insurance-linked securities.

### Why it matters

Commodities are the bridge between the financial economy and the physical economy — the core thesis of the Finance 2.0 vision document. When Alphanix trades natural gas based on weather models, it is pricing a real-world physical constraint. This is precisely the kind of trading that Finance 2.0 endorses: profit derived from understanding reality, not from microsecond latency advantages. Commodity futures also provide genuine portfolio diversification — historically low correlation with equities and crypto.

### Key technical challenges

- Futures contracts expire. The adapter must handle contract rollover (e.g., switching from NG April to NG May before expiry) without leaving phantom positions.
- Margin requirements for futures are dynamic and can change overnight. The Risk Manager must query IBKR for real-time margin requirements before every trade proposal.
- Weather-driven signals require processing large NOAA datasets (GFS/ECMWF model outputs are multi-GB GRIB files). This is a swarm-level task, not a pod-level task.
- Natural gas in particular has extreme vol-of-vol. Position sizing must be ultra-conservative (Kelly fraction capped at 0.25x).

### Dependencies

- Section 1 (IBKR connection) must be complete — CME futures are accessed via IBKR.
- Section 8 (Kelly sizing) strongly recommended before going live with futures.
- Section 11 (Weather integration) provides the signal source.

### Priority: P2

Valuable diversification, but requires IBKR first and significant domain expertise in futures mechanics.

---

## 3. Advanced Execution Algorithms

### What it does

Implement four execution algorithms in the Execution Engine role:

- **TWAP (Time-Weighted Average Price):** Split a large order into equal-sized slices executed at fixed time intervals. Minimizes market impact by spreading execution over 5-60 minutes.
- **VWAP (Volume-Weighted Average Price):** Split order into slices weighted by historical volume profile. Execute more during high-volume periods, less during low-volume. Targets the day's average price.
- **Iceberg Orders:** Submit only a visible portion (e.g., 10%) of the total order to the exchange. When the visible portion fills, automatically submit the next slice. Hides true order size from other market participants.
- **Smart Order Routing (SOR):** When multiple adapters can execute the same asset (e.g., BTC on Binance vs. IBKR), route to the venue with the best price, lowest fees, or most liquidity.

### Why it matters

On small orders ($50-500, current Cryonix scale), execution algorithms are irrelevant — you just market-buy. But as Alphanix scales to larger positions ($5k-50k+), market impact becomes a real cost. A $20k market buy on a mid-cap stock can move the price 0.5-1% against you. TWAP/VWAP reduce this to near-zero. Iceberg orders prevent front-running by other algorithms that detect large orders in the order book. SOR ensures best execution, which is also a regulatory requirement under MiFID II.

### Key technical challenges

- TWAP/VWAP require a timer system that survives process restarts. If Alphanix crashes mid-TWAP, it must resume the remaining slices on restart, not re-execute the full order.
- Volume profile data for VWAP must be pre-computed daily (historical intraday volume distribution). This is a Data Engineer responsibility.
- Iceberg implementation varies by exchange. Some exchanges support native iceberg orders; others require client-side implementation.
- SOR requires real-time fee comparison across adapters, which means adapters must expose their fee structures dynamically.

### Dependencies

- Section 1 (IBKR) for multi-venue routing.
- Section 7 (State Recovery) for crash-safe execution resumption.

### Priority: P2

Not needed at current scale, but becomes critical as position sizes grow. Should be implemented before trading futures (Section 2) where slippage costs are higher.

---

## 4. ESG Scoring with Real Data

### What it does

Connect the ESG stub infrastructure from Phase 1 (the `esg_score` field on `TradeProposal` and `min_esg_score` config) to real-world data sources:

- **Copernicus Sentinel satellite feeds:** Monitor deforestation, land-use change, and vegetation health for portfolio companies' operational areas. A palm oil company destroying rainforest gets an ESG score of 0.
- **EU ETS carbon credit prices:** Integrate real-time carbon credit pricing from the EU Emissions Trading System. Companies with high emissions face a "carbon cost" that reduces their effective profitability.
- **Planetary boundary stress testing:** Extend the Risk Manager to run Monte Carlo simulations against Rockstrom's 9 planetary boundaries. "If our portfolio companies collectively increase nitrogen runoff by X%, what is the systemic risk to our agriculture-exposed positions?"
- **True Cost Accounting (TCA):** For every position, compute hidden costs (environmental damage, social impact) and hidden benefits (carbon sequestration, ecosystem restoration). Display as "Planetary P&L" alongside financial P&L.

### Why it matters

This is the heart of the Finance 2.0 vision. The entire companion document argues that externalities are real costs that the current financial system ignores. Phase 1 built the plumbing (ESG fields exist on every trade proposal). Phase 2 wires in third-party ESG scores. Phase 3 goes further: we generate our own ESG assessments from raw satellite and emissions data, making greenwashing algorithmically detectable. This transforms the Risk Manager into a Planetary Boundary Officer — the role described in the vision doc.

### Key technical challenges

- Copernicus data is free but massive. Sentinel-2 tiles are 100x100 km at 10m resolution. Processing requires either Google Earth Engine or a custom GDAL pipeline. This is a heavy swarm workload.
- Mapping satellite imagery to specific companies requires a knowledge graph linking companies to their operational sites (factories, farms, mines). Building this mapping is a research project in itself.
- True Cost Accounting is philosophically straightforward but numerically hard. "What does a destroyed river cost?" requires economic modeling that academics still disagree on. We need reasonable defaults, not perfection.
- Carbon credit prices are volatile and thinly traded. Using them as a signal requires careful smoothing.

### Dependencies

- Swarm system must be operational (satellite processing is a swarm task).
- Section 5 (Multi-VM) recommended for heavy satellite processing workloads.
- The Copernicus Sentinel API requires free registration.

### Priority: P3

High philosophical importance but low immediate trading value. Implement after the system is profitable and stable. The Phase 1 stubs ensure we can integrate this without architectural changes.

---

## 5. Multi-VM Distribution

### What it does

Scale Alphanix beyond the single 4GB Azure VM. Distribute pods across multiple VMs, each running a subset of the system:

- **VM 1 (Orchestrator):** Orchestrator + Redis Cluster primary + Postgres primary. The command center.
- **VM 2+ (Pod VMs):** Each runs 2-3 pods. Connects to Redis Cluster for state, Postgres for history.
- **VM Data Lake:** Dedicated VM for heavy swarm workers (satellite processing, backtesting tournaments). Runs TimescaleDB (Postgres extension) for efficient time-series queries on OHLCV data.
- **Redis Cluster:** Replace single Redis instance with a 3-node cluster for high-volume pub/sub and failover.

### Why it matters

The 4GB VM is a hard ceiling. Phase 1 and 2 can run on it (hybrid process model, worker threads). But Phase 3 features — satellite processing, 100+ backtest variants, multi-market real-time data — will exceed single-VM capacity. Multi-VM also provides resilience: if the data lake VM crashes, trading pods continue on stale data rather than halting entirely. TimescaleDB specifically addresses the growing OHLCV storage problem — Postgres with 45 crypto pairs + 50 stocks + futures at multiple timeframes will eventually slow down without time-series optimizations.

### Key technical challenges

- Redis Cluster has different semantics from standalone Redis. Multi-key operations (MGET, pipelines) only work when keys hash to the same slot. All Redis key patterns must be reviewed and possibly redesigned with hash tags.
- Cross-VM latency adds 1-5ms per Redis call. Pod loops that currently do 10 Redis calls per iteration will feel this. Batching and local caching become important.
- Deployment complexity increases dramatically. Docker Compose works for one VM; multi-VM needs either Docker Swarm, Kubernetes (K3s for lightweight), or custom orchestration scripts.
- The current `safe-deploy.sh` flock mechanism is single-VM. Multi-VM deploys need a distributed lock (Redis-based or similar).

### Dependencies

- None technically, but should only be pursued when single-VM performance is actually the bottleneck.
- Section 6 (Backtest Tournament) is the first feature likely to demand a data lake VM.

### Priority: P3

Do not over-engineer prematurely. The 4GB VM runs Cryonix + Aktienix + Solanix + Polynix + Copynix today. Only distribute when you must.

---

## 6. Backtest Tournament System

### What it does

Implement a genetic algorithm that evolves trading strategies:

1. **Spawn:** Generate 100+ strategy variants by mutating parameters (indicator thresholds, timeframes, position sizing rules) from a base strategy.
2. **Backtest:** Run all variants in parallel using `worker_threads` (not async — CPU-bound work needs real parallelism). Each worker gets a historical data slice and simulates the strategy.
3. **Rank:** Score variants by Sharpe ratio, max drawdown, win rate, and profit factor. Apply regularization to prevent overfitting (penalize strategies with too many parameters or suspiciously high Sharpe).
4. **Promote:** Top 5 strategies are promoted to live paper-trading pods. After 2 weeks of live validation, the best performer is promoted to real capital.
5. **Repeat:** Weekly tournament every Saturday (markets closed, VM resources free).

### Why it matters

The current evolution system (Claude Code CLI, every 2h) mutates one parameter at a time and measures impact over days. This is slow and noisy — market regime changes confuse the signal. A backtest tournament tests hundreds of variants against the same historical data simultaneously, eliminating market noise. It is the difference between testing one drug at a time on different patients versus running a controlled trial with hundreds of patients at once. The genetic algorithm also discovers non-obvious parameter combinations that sequential mutation would never find.

### Key technical challenges

- Overfitting is the primary risk. A strategy that returns 500% on historical data but fails live is worse than useless — it destroys capital with high confidence. Multiple safeguards needed: out-of-sample testing, walk-forward analysis, parameter count penalties.
- `worker_threads` share the same V8 heap limit. 100 workers on a 4GB VM is impossible. Realistic limit: 4-8 concurrent workers, processing variants in batches.
- Historical data must be immutable during a tournament. If new candles arrive mid-backtest, results are inconsistent. Need a snapshot mechanism.
- The promotion pipeline (backtest winner -> paper pod -> live pod) requires human approval at the paper-to-live transition. No fully autonomous promotion to real capital.

### Dependencies

- Section 5 (Multi-VM) recommended for running 100+ variants. On single VM, limit to 20-30 variants per tournament.
- Backtester infrastructure from the engine (already exists: `backtest.py`) needs a TypeScript equivalent or a bridge.

### Priority: P2

High impact on strategy quality. Can run in limited form (20 variants) on single VM without Section 5.

---

## 7. Position Recovery & State Management

### What it does

On process restart (crash, deploy, VM reboot), Alphanix must recover its true state:

- **Broker reconciliation:** Read all open positions from the broker API (IBKR, Alpaca, Binance) and compare with Redis state. Resolve discrepancies — if Redis says we hold 100 shares of AAPL but Alpaca says 80, trust the broker and log the discrepancy.
- **High-water mark persistence:** Trailing stops depend on the highest price seen since entry. Currently stored in Redis (volatile). Persist to Postgres so a restart does not reset the trailing stop to the current price, causing premature exits.
- **Execution state recovery:** If a TWAP execution was 60% complete when the process died, resume from slice 7/12 instead of re-executing the full order.
- **Full audit trail:** Every decision at every stage (signal generation, risk check, execution, position monitoring) logged to Postgres with timestamps, reasoning, and the full context that led to the decision.

### Why it matters

The current system (Cryonix, Aktienix) loses state on restart. Redis data survives (RDB snapshots), but in-memory state like trailing stop high-water marks, partial execution progress, and pending decisions vanish. This has caused real issues: positions held without stop-loss monitoring after a deploy, duplicate orders after a crash. For Alphanix to manage real capital at scale, it must be crash-safe. The audit trail is also a regulatory requirement for algorithmic trading under MiFID II.

### Key technical challenges

- Broker position reconciliation must handle partial fills, pending orders, and positions opened manually (outside Alphanix). The reconciliation algorithm must be conservative: when in doubt, reduce exposure rather than assume.
- High-water marks must be updated atomically with position state. A race condition where the price updates but the HWM write fails could cause a trailing stop to fire incorrectly.
- The audit trail generates significant write volume. At 100 decisions/minute across all pods, that is 144k rows/day. Postgres can handle this, but the table needs proper partitioning (by date) and a retention policy.

### Dependencies

- Section 1 (IBKR) for broker-side position reads.
- Should be implemented alongside or immediately after Section 3 (execution algorithms need state recovery).

### Priority: P1

Crash safety is non-negotiable for real capital. Implement alongside Section 1.

---

## 8. Kelly Criterion Position Sizing

### What it does

Replace the current flat percentage allocation (e.g., "10% of capital per trade") with Kelly-optimal position sizing:

- **Kelly fraction:** For each trade, compute `f* = (bp - q) / b` where `b` = odds (expected win/loss ratio), `p` = win probability, `q` = 1-p. Use half-Kelly (f*/2) for safety.
- **Volatility weighting:** Scale position size inversely with realized volatility. A stock with 50% annualized vol gets half the position of one with 25% vol, all else equal.
- **Correlation-aware sizing:** If the portfolio already holds 3 correlated tech stocks, reduce sizing on the 4th tech stock. Use a rolling correlation matrix (30-day window) to detect clusters.
- **Dynamic recalculation:** Recalculate Kelly fractions daily as win rates and payoff ratios update from closed trades.

### Why it matters

Flat percentage sizing is simple but suboptimal. It allocates the same capital to a high-conviction, low-volatility trade as to a speculative, high-volatility trade. Kelly criterion is mathematically proven to maximize long-term growth rate. The catch is that full Kelly is extremely aggressive — half-Kelly sacrifices ~25% of theoretical growth for ~50% reduction in volatility. Correlation-aware sizing prevents the classic blow-up scenario: five "different" positions that are actually one bet on tech sentiment.

### Key technical challenges

- Kelly requires accurate estimates of win probability and payoff ratio. With limited trade history (< 100 trades per strategy), these estimates have wide confidence intervals. Use Bayesian updating with an uninformative prior rather than naive frequency estimates.
- The correlation matrix is O(n^2) in the number of positions. With 50+ positions across pods, this becomes computationally significant. Use a factor model (3-5 factors: market, size, value, momentum, volatility) instead of full pairwise correlations.
- Kelly sizing can produce very large positions (30-50% of capital) for high-edge trades. Hard cap at 15% per position regardless of Kelly output.

### Dependencies

- Sufficient trade history for meaningful win rate estimates. Need at least 30 closed trades per strategy.
- Section 7 (audit trail) for tracking win rates accurately.

### Priority: P2

Significant improvement over flat sizing. Can be implemented independently of other sections.

---

## 9. Podcast & Earnings Call Intelligence

### What it does

Add two new swarm types to the intelligence pipeline:

- **Podcast Transcript Swarm:** Fetch transcripts of financial podcasts (Bloomberg Surveillance, Odd Lots, All-In, Bankless) via YouTube captions API or Whisper transcription. Extract key themes, sentiment shifts, and actionable mentions (specific tickers, sectors, macro calls). Run daily.
- **Earnings Call NLP Swarm:** During earnings season, monitor scheduled earnings calls. Fetch transcripts (SEC EDGAR 8-K exhibits, or services like Seeking Alpha). Analyze CEO/CFO language for sentiment shifts compared to previous quarter: increased use of hedging words ("challenging," "uncertain," "headwinds") is a bearish signal. Detect specific forward guidance changes. Run on event trigger (earnings calendar).

### Why it matters

Earnings calls contain alpha that is not fully priced in for hours or days. Academic research (Hobson et al., 2012) shows that CEO vocal stress patterns predict negative earnings surprises. While we cannot do voice analysis, NLP on transcripts captures a significant portion of the signal: changes in language complexity, hedging word frequency, and specificity of forward guidance are all measurable and predictive. Podcast intelligence captures "smart money narrative" — what macro thinkers are discussing before it becomes consensus.

### Key technical challenges

- Transcript quality varies. YouTube auto-captions are 85-95% accurate; financial jargon reduces this. Whisper API is better but costs $0.006/minute.
- Earnings call timing is critical. The call happens at 16:30, the transcript is available by 17:00, and the stock reacts in after-hours trading. The swarm must process within minutes, not hours.
- Sentiment analysis must be relative, not absolute. A CEO who always sounds optimistic provides no signal. The signal is the delta from their baseline language pattern. This requires maintaining a per-CEO language profile.
- Volume during earnings season is extreme: 500+ companies report in a single week. Swarm budget management (Section 5 of the design spec) must prioritize portfolio holdings and watchlist over the full universe.

### Dependencies

- Swarm system must be operational.
- Earnings calendar data source (SEC EDGAR, financial data API).

### Priority: P3

Valuable alpha source but complex to implement well. Start with podcast transcripts (simpler, lower urgency) before tackling real-time earnings calls.

---

## 10. Telegram Bot Integration

### What it does

Extend the existing Telegram bot infrastructure (`@cryptonixis_bot`) with Alphanix-specific commands:

- `/alphanix status` — Show running pods, capital allocation, global risk state.
- `/alphanix pods` — List all pods with their current P&L, position count, and risk utilization.
- **Trade notifications:** Automatic messages on entry (symbol, side, size, confidence, reasoning) and exit (P&L, hold time, strategy attribution).
- **Geopolitical alerts:** When the OSINT or Macro swarm detects a critical-severity event (sanctions, military escalation, central bank surprise), send an immediate Telegram alert with affected positions.
- **Daily/weekly reports:** Automated P&L summary, best/worst trades, strategy attribution, risk utilization.
- **Manual commands:** `/alphanix pause pod-crypto` (pause a specific pod), `/alphanix capital pod-stocks 5000` (adjust capital allocation), `/alphanix exit AAPL` (force-close a position).

### Why it matters

The existing Cryonix Telegram integration has proven essential for monitoring a system that runs 24/7 without a screen. Alphanix is more complex (multiple pods, multiple markets, swarms) and needs richer notifications. Manual commands provide a safety valve — if you see a pod behaving unexpectedly at 3 AM, you can pause it from your phone without SSH-ing into the VM.

### Key technical challenges

- Message formatting for multi-pod status is verbose. Use Telegram's MarkdownV2 with collapsible sections (inline keyboard buttons to expand/collapse pod details).
- Rate limiting: Telegram allows 30 messages/second per bot. During high-activity periods (multiple pods trading simultaneously), batch notifications into a single message.
- Manual commands must authenticate the sender (only the owner's Telegram user ID can issue control commands). This already exists in `telegram-interactive.mjs` but must be replicated for Alphanix commands.
- Force-exit commands must go through the same Risk Manager pipeline as automated exits. No bypassing safety checks.

### Dependencies

- Existing Telegram bot infrastructure (`scripts/services/telegram-interactive.mjs`).
- Can be implemented incrementally alongside other sections.

### Priority: P1

Low effort, high value. Should be one of the first Phase 3 features since it enables monitoring for everything else.

---

## 11. Weather & Crisis Trading

### What it does

Build weather and crisis event models as signal sources for commodity and energy pods:

- **ECMWF/GFS weather models:** Fetch 10-day forecasts. Detect Polar Vortex events (stratospheric warming → arctic air mass displacement → US heating demand spike → natural gas price surge). Detect hurricane formation and track paths for Gulf of Mexico energy infrastructure exposure.
- **Texas grid stress (ERCOT):** Monitor ERCOT real-time grid data. When Texas grid frequency drops below 59.95 Hz or reserves fall below 3 GW, energy prices spike. Additionally, extreme grid stress forces Bitcoin miners to shut down (demand response programs), reducing BTC hash rate — a signal for crypto pods.
- **Frost/drought detection:** NOAA crop condition reports + satellite NDVI (vegetation index) for agricultural commodity signals. Late frost in Brazil's coffee belt = coffee futures long.
- **Hurricane tracking:** NOAA National Hurricane Center advisories. Category 3+ hurricane approaching Gulf coast = crude oil disruption signal + insurance sector impact.

### Why it matters

Weather is the original "alternative data" — commodity traders have used weather forecasts since the 1800s. The difference today is granularity and speed. ECMWF ensemble models provide probabilistic forecasts that can be directly translated into position sizing (higher forecast confidence = larger position). The ERCOT-Bitcoin connection is a novel signal that most crypto traders ignore entirely. Weather-driven trades also align with the Finance 2.0 vision: we are trading physical reality, not financial abstraction.

### Key technical challenges

- Weather model data (GRIB format) is large and requires specialized libraries (cfgrib, xarray) to parse. This is Python-native work — either run in the engine container or a dedicated weather swarm.
- Forecast skill degrades rapidly beyond 5 days. Models are useful for 1-3 day trades, not swing positions. The signal must include a confidence decay function.
- ERCOT data is real-time but unreliable (their API has frequent outages, especially during the crises when the data is most valuable). Need robust fallback and caching.
- False positive rate on "crisis" signals is high. A hurricane that turns away from the Gulf is not a signal to close energy shorts. Require confirmation from multiple data sources before acting.

### Dependencies

- Section 2 (Commodity adapters) for executing on weather signals.
- Swarm system for processing GRIB data.

### Priority: P2

Tied to Section 2 (commodities). Implement together as a package.

---

## 12. Regulatory & Compliance

### What it does

Build the compliance infrastructure needed for legal algorithmic trading in Sweden:

- **K4 blankett generation:** Automatically generate the data needed for Swedish tax form K4 (Försäljning av värdepapper). For each closed position: acquisition date, sale date, acquisition cost, sale proceeds, profit/loss. Export as CSV compatible with Skatteverket's import format.
- **ISK vs. aktie-/fondkonto optimization:** Track which accounts are ISK (flat tax on standardized amount) vs. regular depository accounts (30% capital gains tax). Recommend which account to use for each trade based on expected hold time and expected return. Short-term high-frequency trades benefit from ISK; long-term holds with small gains may not.
- **MiFID II algorithm testing:** Document that Alphanix's algorithms have been tested under stressed market conditions (required for EU algorithmic trading). Maintain a test log with backtest results under 2008, 2020, and 2022 market conditions.
- **GDPR compliance:** Sentiment data collected from social media (Reddit, X, StockTwits) must not store personally identifiable information. Aggregate sentiment scores only; never store individual posts with usernames. Implement data retention policy (delete raw data after 30 days, keep aggregated scores indefinitely).

### Why it matters

Algorithmic trading in the EU is regulated under MiFID II Article 17. While the regulation primarily targets HFT firms and investment firms, the requirements around algorithm testing, risk controls, and kill switches apply broadly. Building compliance into the architecture now prevents costly retrofitting later. ISK optimization alone can save thousands of SEK per year in taxes — this is not a nice-to-have, it is direct financial value.

### Key technical challenges

- Swedish tax rules have edge cases: currency conversion gains on foreign stocks are taxed separately from the stock gain itself. Multi-currency tracking (Section 1) must feed accurate FX data into the tax calculator.
- ISK schablonbelopp is calculated on the account value at the start of each quarter. The optimizer must model this quarterly snapshot behavior, not just annual returns.
- MiFID II stress testing requires defining "stressed market conditions" quantitatively. Use historical drawdown periods with specific criteria (> 20% drawdown in < 30 days).
- GDPR right-to-erasure is complex for aggregated data. If a user requests deletion, we cannot un-aggregate a sentiment score. Solution: never collect PII in the first place.

### Dependencies

- Section 1 (IBKR + multi-currency) for accurate tax calculations.
- Section 7 (audit trail) for MiFID II compliance documentation.

### Priority: P1

Tax compliance is mandatory, not optional. K4 generation should be implemented as soon as real trades begin. MiFID II documentation should be maintained continuously from day 1 of live trading.

---

## Priority Summary

| Priority | Sections | Rationale |
|----------|----------|-----------|
| **P1** | 1 (IBKR), 7 (Recovery), 10 (Telegram), 12 (Compliance) | Foundation: cannot trade real capital without broker, crash safety, monitoring, and tax compliance |
| **P2** | 2 (Commodities), 3 (Execution Algos), 6 (Backtest Tournament), 8 (Kelly Sizing), 11 (Weather) | Scale: improve strategy quality, diversify markets, optimize execution |
| **P3** | 4 (ESG), 5 (Multi-VM), 9 (Podcast/Earnings) | Vision: long-term differentiation and infrastructure scaling |

---

## Suggested Implementation Order

```
Week 1-2:  Section 1  (IBKR adapter) + Section 10 (Telegram, parallel)
Week 2-3:  Section 7  (State recovery) + Section 12 (K4 tax export)
Week 3-4:  Section 8  (Kelly sizing) + Section 3  (TWAP/VWAP)
Week 4-5:  Section 2  (Commodities) + Section 11 (Weather, parallel)
Week 5-6:  Section 6  (Backtest tournament)
Later:     Section 4  (ESG), Section 5 (Multi-VM), Section 9 (Podcast NLP)
```

This order ensures that every week produces a shippable increment: after week 2, Alphanix can trade real stocks through IBKR with Telegram monitoring. After week 4, it has crash safety and optimized sizing. After week 6, it diversifies into commodities with weather-driven signals.

---

*Companion documents:*
- *[Alphanix Design Spec](../specs/2026-03-23-alphanix-design.md) — Phase 1 architecture and pod structure*
- *[Finance 2.0 Vision](../specs/2026-03-23-alphanix-finance-2.0-vision.md) — philosophical direction and ESG framework*
