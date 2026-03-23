# Alphanix — Multi-Asset AI Trading Army

**Date:** 2026-03-23
**Status:** Draft
**Owner:** Joel (Cryonix Agent Army)

## 1. Overview

Alphanix is a multi-asset, multi-market AI trading platform organized as an army of specialized AI agents working in **pods** — isolated, autonomous trading teams modeled after the pod structure used by world-class quantitative hedge funds (Millennium, Citadel, Jane Street).

Unlike other agents in the monorepo (Aktienix, Solanix, etc.) which are single-agent-per-market, Alphanix is a **meta-platform** where:

- An **Orchestrator** (Portfolio Manager agent) allocates capital across pods
- **Pods** are self-contained trading teams with 3 specialized roles + Data Engineer feeds
- **Swarms** of micro-agents spawn on-demand for data collection, backtesting, and research
- An **Adapter Layer** abstracts away market differences, enabling unlimited market expansion

### Design Principles

- **Pod isolation** — Each pod operates independently. One pod crashing does not affect others.
- **Adapter-agnostic intelligence** — Quant agents see normalized data, never raw broker APIs.
- **Swarm-on-demand** — Heavy workloads (OSINT, backtesting) use ephemeral worker threads, not permanent processes.
- **Hybrid runtime** — Core pod runs as a single process; swarms spawn as worker threads within it.
- **ESG-aware risk** — Planetary boundary checks built into the risk framework from day 1.

## 2. Architecture

```
┌─────────────────────────────────────────────────────┐
│                  ORCHESTRATOR (PM)                    │
│   Capital allocation · Strategy · Global Kill Switch │
│   Spawns global swarms (Macro, ESG Audit)            │
├──────────┬──────────┬──────────┬────────────────────┤
│  Pod A   │  Pod B   │  Pod C   │  Pod N (dynamic)   │
│  Crypto  │  US Stk  │  EU Stk  │                     │
│          │          │          │                     │
│  Quant   │  Quant   │  Quant   │  Each pod can       │
│  Risk    │  Risk    │  Risk    │  spawn its own       │
│  Exec    │  Exec    │  Exec    │  swarms on-demand    │
│  Data    │  Data    │  Data    │                     │
├──────────┴──────────┴──────────┴────────────────────┤
│                   SWARM POOL                         │
│  OSINT · Backtest · Macro · Alt Data · ESG · Custom  │
│  (worker_threads, ephemeral, priority-queued)        │
├─────────────────────────────────────────────────────┤
│                  ADAPTER LAYER                        │
│  BinanceAdapter · AlpacaAdapter · IBKRAdapter         │
│  (future: CME, Nordnet, FTX successors, etc.)        │
├─────────────────────────────────────────────────────┤
│                DATA LAKE                              │
│  Redis (real-time state, queues, pub/sub)             │
│  Postgres (history, audit trail, backtesting)         │
└─────────────────────────────────────────────────────┘
```

### Runtime Model

**Hybrid process architecture** chosen for the 4GB VM constraint:

- **1 main process** per Alphanix instance — runs Orchestrator + all active pods
- **Worker threads** for swarms — spawned on-demand, die after task completion
- **SwarmBudgetManager** enforces global limits on concurrent workers
- A `critical` priority swarm from Risk can preempt low-priority swarms

## 3. Pod Structure

Each pod is an autonomous trading unit with 4 agent roles communicating through a defined pipeline:

```
┌─────────────── POD ───────────────────┐
│                                        │
│  ┌──────────────────────────┐         │
│  │    Quant Researcher       │         │
│  │  Signal generation        │         │
│  │  Model development        │         │
│  │  Backtesting (via swarms) │         │
│  │  Alpha discovery          │         │
│  └────────────┬─────────────┘         │
│               ▼                        │
│  ┌──────────────────────────┐         │
│  │    Risk Manager           │         │
│  │  VaR calculation          │         │
│  │  Stress testing           │         │
│  │  Kill switch (veto power) │         │
│  │  ESG/Planetary boundary   │         │
│  └────────────┬─────────────┘         │
│               ▼                        │
│  ┌──────────────────────────┐         │
│  │    Execution Engine       │         │
│  │  TWAP/VWAP algorithms     │         │
│  │  Slippage minimization    │         │
│  │  Adapter routing          │         │
│  │  Order management         │         │
│  └────────────┬─────────────┘         │
│               ▼                        │
│  ┌──────────────────────────┐         │
│  │    Data Engineer          │         │
│  │  Feed management          │         │
│  │  Data cleaning/normalization│       │
│  │  Pipeline health          │         │
│  │  Swarm spawning for data  │         │
│  └──────────────────────────┘         │
│                                        │
│  Config: alphanix.toml [pods.{id}]    │
│  State:  Redis alphanix:pod:{id}:*    │
│  History: Postgres alphanix_* tables  │
└────────────────────────────────────────┘
```

### Intra-Pod Communication

- **Synchronous pipeline:** Quant → Risk → Execution (every signal must pass all gates)
- **Asynchronous feeds:** Data Engineer → Redis streams (continuous data ingestion)
- **Audit trail:** Every decision logged to Postgres with full reasoning

### Pod Lifecycle

- Orchestrator creates and kills pods dynamically based on capital allocation
- Each pod has a `PodConfig` section in TOML (strategy, markets, risk limits, capital cap)
- Pod that breaches its risk budget is automatically liquidated and shut down
- New pods can be hot-deployed without restarting the Alphanix process

## 4. Agent Roles (Detailed)

### 4.1 Orchestrator (Portfolio Manager)

The central brain. Sits above all pods and makes meta-decisions.

**Responsibilities:**
- Allocate capital across pods based on performance, risk, and market regime
- Set daily/weekly trading themes and strategic direction
- Spawn global swarms (macro scans, ESG audits)
- Enforce global risk limits (total drawdown, correlation limits)
- Create/destroy pods dynamically
- Morning huddle: broadcast daily parameters to all pods

**Inputs:** Pod performance metrics, global macro data, risk reports
**Outputs:** Capital allocation updates, pod configs, kill commands

### 4.2 Quant Researcher (per pod)

The signal and model engine. Finds tradeable edges.

**Responsibilities:**
- Generate trading signals from market data and alternative data
- Develop and backtest mathematical models (spawns backtest swarms)
- Combine multiple weak signals into strong composite signals
- Monitor model decay (strategy half-life tracking)
- Request OSINT swarms when deeper research is needed on a symbol

**Inputs:** Normalized market data (via adapter), alt data feeds, OSINT results
**Outputs:** Trading signals with confidence scores, model performance reports

### 4.3 Risk Manager (per pod)

The shield. Independent veto power over all trading decisions.

**Responsibilities:**
- Calculate Value at Risk (VaR) for the pod's portfolio
- Stress test against historical crashes and hypothetical scenarios
- Enforce hard stop-loss limits (algorithmic kill switch)
- Monitor factor exposure (sector, currency, volatility concentration)
- ESG/Planetary boundary checks (water usage, emissions, biodiversity impact)
- Veto power: can block any trade or liquidate the entire pod

**Inputs:** Pod positions, market data, stress scenarios, ESG data
**Outputs:** Risk decisions (approve/veto/liquidate), risk reports

### 4.4 Execution Engine (per pod)

The tactical specialist. Turns decisions into market orders with minimal impact.

**Responsibilities:**
- Execute orders through the adapter layer
- Implement execution algorithms (TWAP, VWAP, Iceberg orders)
- Minimize slippage and transaction costs
- Route orders to optimal venue (when multiple adapters serve same asset)
- Manage open orders (modify, cancel, track fills)

**Inputs:** Approved signals from Risk, adapter capabilities
**Outputs:** Order results, fill reports, TCA (Transaction Cost Analysis)

### 4.5 Data Engineer (per pod)

The infrastructure agent. Keeps data flowing and clean.

**Responsibilities:**
- Manage data feed connections via adapters
- Clean, normalize, and validate incoming data
- Spawn data collection swarms (OSINT, alt data)
- Monitor data pipeline health (latency, gaps, quality)
- Store processed data in Redis (real-time) and Postgres (historical)

**Inputs:** Raw data from adapters and swarms
**Outputs:** Clean, normalized data feeds for Quant and Risk

## 5. Signal Pipeline Types

The core data contract flowing between pod roles. Every signal must pass through this typed pipeline.

```typescript
// Quant → Risk
interface TradeProposal {
  id: string
  podId: string
  symbol: string
  adapter: string               // 'binance', 'alpaca', 'ibkr'
  side: 'BUY' | 'SELL'
  confidence: number            // 0-100
  sizing: { qty: number; notional: number }
  reasoning: string             // Human-readable explanation
  models: string[]              // Which models contributed
  signals: string[]             // Which data signals triggered this
  timestamp: number
}

// Risk → Execution (or veto)
interface RiskDecision {
  proposalId: string
  action: 'approve' | 'veto' | 'reduce'
  adjustedSizing?: { qty: number; notional: number }
  vetoReason?: string
  riskMetrics: {
    var: number                 // Value at Risk
    exposure: number            // Current portfolio exposure
    drawdown: number            // Current drawdown %
    esgScore?: number           // 0-100, Phase 2
  }
}

// Execution → Audit Log
interface ExecutionResult {
  proposalId: string
  orderId: string
  adapter: string
  fillPrice: number
  fillQty: number
  slippage: number              // Actual vs expected price
  fees: number
  timestamp: number
}
```

### Pod-to-Orchestrator Communication

Poll-based via Redis (consistent with existing monorepo pattern):

- **Pods write** state every loop: `alphanix:pod:{id}:state`, `alphanix:pod:{id}:performance`
- **Orchestrator reads** on its own loop interval (60s)
- **Commands down:** Orchestrator writes to `alphanix:pod:{id}:commands` (Redis list)
- **Pods drain** the command list each loop iteration
- **Kill switch:** Risk Manager sets `alphanix:pod:{id}:state = "liquidating"`, Orchestrator detects on next read

Command types: `reduce_exposure`, `pause`, `resume`, `update_config`, `liquidate`, `shutdown`

### Adapter Error Handling

```typescript
interface AdapterError {
  adapter: string
  category: 'rate_limit' | 'insufficient_funds' | 'market_closed' |
            'auth_failure' | 'network' | 'order_rejected' | 'unknown'
  message: string
  retryable: boolean
  retryAfterMs?: number
}
```

Retry policy: exponential backoff for `rate_limit` and `network`, immediate fail for `auth_failure` and `market_closed`, pod-level circuit breaker after 3 consecutive failures.

## 6. Adapter Layer

The abstraction that makes Alphanix market-agnostic.

### Interface

```typescript
interface MarketAdapter {
  // Identity
  readonly id: string;              // 'binance', 'alpaca', 'ibkr'
  readonly assetClass: AssetClass;  // 'crypto' | 'stock' | 'commodity' | 'forex'

  // Lifecycle
  connect(): Promise<void>
  disconnect(): Promise<void>
  healthCheck(): Promise<HealthStatus>

  // Market Data (Ingress)
  getOHLCV(symbol: string, timeframe: string, limit?: number): Promise<Candle[]>
  getOrderBook(symbol: string, depth?: number): Promise<OrderBook>
  streamTicks(symbol: string): AsyncGenerator<NormalizedTick>
  getSymbols(): Promise<SymbolInfo[]>

  // Execution (Egress)
  submitOrder(order: NormalizedOrder): Promise<OrderResult>
  cancelOrder(orderId: string): Promise<void>
  modifyOrder(orderId: string, changes: OrderModification): Promise<OrderResult>
  getPositions(): Promise<NormalizedPosition[]>
  getOpenOrders(): Promise<NormalizedOrder[]>
  getAccountState(): Promise<AccountState>

  // Metadata
  getTradingHours(): TradingSchedule
  getFees(): FeeStructure
  getMinOrderSize(symbol: string): Decimal
}
```

### Normalized Tick Format

Every market produces the same internal format:

```typescript
interface NormalizedTick {
  timestamp_ns: bigint        // Nanosecond precision
  adapter_id: string          // 'binance', 'alpaca', 'ibkr'
  symbol: string              // Unified symbol format
  bid: Decimal
  ask: Decimal
  last: Decimal
  volume_24h: Decimal
  asset_class: AssetClass
}
```

### Day-1 Adapters

| Adapter | Market | Source | Status |
|---------|--------|--------|--------|
| `BinanceAdapter` | Crypto | CCXT (existing in engine) | Reuse + wrap |
| `AlpacaAdapter` | US Stocks | @alpacahq/alpaca-trade-api (existing in Aktienix) | Reuse + wrap |
| `IBKRAdapter` | EU/SE Stocks | @stoqey/ib (existing stub in Aktienix) | Extend |

### Adding New Markets

1. Create `adapters/{name}-adapter.ts` implementing `MarketAdapter`
2. Register in `AdapterRegistry`
3. Assign to pod config — zero changes in pod logic

## 6. Swarm System

Swarms are ephemeral armies of micro-agents spawned on-demand by pods or the Orchestrator.

### SwarmSpawner Interface

```typescript
interface SwarmSpawner {
  spawn(request: SwarmRequest): Promise<SwarmResult>
  getActiveSwarms(): SwarmStatus[]
  killSwarm(swarmId: string): Promise<void>
}

interface SwarmRequest {
  type: SwarmType
  requester: { podId: string; role: string }  // e.g. "pod-crypto:quant"
  task: string                                 // Human-readable task description
  params: Record<string, unknown>              // Task-specific parameters
  workerCount: number                          // How many agents to spawn
  maxDuration: number                          // Timeout in ms
  priority: 'low' | 'normal' | 'high' | 'critical'
}

type SwarmType = 'osint' | 'backtest' | 'macro' | 'altdata' | 'esg' | 'sentiment' | 'custom'
```

### Swarm Types

| Swarm | Typical Trigger | Workers | Task | Lifespan |
|-------|----------------|---------|------|----------|
| **OSINT** | Pod Quant/Data requests it | 10-50 | Scrape news, sentiment, SEC filings per symbol | 5-15 min |
| **Backtest** | Pod Quant has new hypothesis | 5-20 | Parallel strategy variant testing on historical data | 10-60 min |
| **Macro Scan** | Cron every 6h | 5-10 | FRED, ECB, BLS, Riksbanken data collection | 2-5 min |
| **Alt Data** | Cron daily | 5-15 | AIS vessels, OpenSky flights, NOAA weather | 10-30 min |
| **ESG Audit** | Cron weekly | 3-5 | Emissions, water, biodiversity per portfolio holding | 15-30 min |
| **Sentiment** | Pod request or event-triggered | 5-20 | Social media, Reddit, X, StockTwits scanning | 5-10 min |
| **Custom** | Any pod role | 1-50 | Arbitrary task defined by requester | Variable |

### Resource Control

```typescript
interface SwarmBudgetManager {
  maxConcurrentWorkers: number    // VM constraint (e.g., 20 on 4GB)
  activeWorkers: number
  queue: PriorityQueue<SwarmRequest>

  canSpawn(request: SwarmRequest): boolean
  preempt(priority: Priority): void  // Kill lowest-priority swarm
}
```

- Global limit on concurrent worker threads (VM memory constraint)
- Priority queue — `critical` from Risk preempts `low` OSINT
- Pods compete for swarm resources (mirrors real hedge fund capital competition)

### Implementation

Swarm workers run as Node.js `worker_threads`:
- Main thread: Orchestrator + Pods (always running)
- Worker threads: Swarm agents (spawned on-demand, terminate after task)
- Communication: `MessagePort` for results, Redis for persistent storage

## 7. Data Sources (Phase 1)

### Open/Free APIs for Day-1 Integration

| Category | Source | API | Data | Update Freq |
|----------|--------|-----|------|-------------|
| **Macro** | FRED | REST (free, key required) | Inflation, rates, unemployment, GDP | Daily |
| **Macro** | ECB SDW | REST (free) | EU rates, money supply | Daily |
| **Macro** | Riksbanken | REST (free) | SEK rates, Swedish macro | Daily |
| **Market** | Binance | CCXT (existing) | Crypto OHLCV, orderbook, trades | Real-time |
| **Market** | Alpaca | REST/WS (existing) | US stock OHLCV, quotes | Real-time |
| **Sentiment** | Reddit/StockTwits | REST (limited free) | Retail sentiment per symbol | Hourly |
| **Alt Data** | OpenSky Network | REST (free) | Flight tracking (corporate jets) | Real-time |
| **Alt Data** | MarineTraffic/AIS | REST (freemium) | Vessel tracking, port activity | Hourly |
| **Alt Data** | NOAA | REST (free) | Weather, ocean, climate | Daily |
| **Chokepoint** | Trafikverket | REST (free) | Rail traffic (Malmbanan Kiruna→Narvik, etc.) | Real-time |
| **Chokepoint** | Kystverket (NO) | REST (free) | Norwegian port/vessel data (Narvik) | Real-time |
| **Filings** | SEC EDGAR | REST (free) | 10-K, 10-Q, insider trades | Real-time |
| **Filings** | Finansinspektionen | Scrape (free) | Swedish insider trades | Daily |
| **ESG** | ESA Copernicus | REST (free) | Satellite imagery, vegetation | Daily |
| **ESG** | Google Earth Engine | API (free for research) | Land use, deforestation | On-demand |
| **Intelligence** | Polymarket | Existing shared module | Prediction market sentiment | 15 min |
| **Intelligence** | CoinMarketCap | Existing CMCScout | F&G, market cap, dominance | 10 min |

### Phase 2+ Sources (Paid/Premium)

- Planet Labs / Maxar (high-res satellite — parking lots, thermal)
- Dataminr (real-time event detection from X firehose)
- YipitData / Earnest Analytics (credit card transaction data)
- SimilarWeb (web traffic analytics)
- Data.ai (app download tracking)
- Quiver Quantitative (political trades, Wikipedia, gov contracts)

## 8. Data Storage

### Redis Keys

```
# Orchestrator
alphanix:orchestrator:state          # Global state, capital allocation
alphanix:orchestrator:pods           # Active pod registry

# Per-pod state
alphanix:pod:{podId}:state           # Pod state (running/paused/liquidating)
alphanix:pod:{podId}:positions       # Current positions
alphanix:pod:{podId}:signals         # Signal queue
alphanix:pod:{podId}:risk            # Risk state (VaR, exposure)
alphanix:pod:{podId}:performance     # Rolling P&L metrics

# Swarms
alphanix:swarm:active                # Active swarm registry
alphanix:swarm:queue                 # Pending swarm requests
alphanix:swarm:{swarmId}:results     # Swarm output (TTL: 1h)

# Data feeds
alphanix:data:macro                  # Latest macro indicators
alphanix:data:sentiment:{symbol}     # Per-symbol sentiment (TTL: 1h)
alphanix:data:osint:{symbol}         # OSINT findings (TTL: 2h)
alphanix:data:altdata:vessels        # Vessel tracking cache
alphanix:data:altdata:flights        # Flight tracking cache
alphanix:data:esg:{symbol}           # ESG scores (TTL: 7d)
```

### Postgres Tables (New)

```sql
-- Core
alphanix_pods           -- Pod registry, config snapshots, lifecycle
alphanix_signals        -- All signals generated by Quant agents
alphanix_trades         -- Executed trades with full audit trail
alphanix_positions      -- Position history (open/close/modify)

-- Data lake
alphanix_macro_data     -- FRED, ECB, Riksbanken time series
alphanix_sentiment      -- Aggregated sentiment scores per symbol
alphanix_osint          -- OSINT findings (news, filings, social)
alphanix_altdata        -- Alternative data (vessels, flights, weather)
alphanix_esg_scores     -- ESG/impact scores per holding

-- Analytics
alphanix_pod_performance -- Daily pod P&L, Sharpe, drawdown
alphanix_swarm_logs      -- Swarm execution history (cost, duration, results)
alphanix_model_registry  -- Quant model versions, backtest results
alphanix_config_changes  -- Config mutations (brain, manual)
```

## 9. Cron Schedule

```
WEEKDAYS (Mon-Fri)
──────────────────────────────────────────────────────
04:00  Orchestrator: Asia summary, global risk adjustment
06:00  Macro Swarm: FRED, ECB, Riksbanken collection
08:00  Morning Huddle: Orchestrator sets daily theme per pod
08:30  Pods activate: Quant agents begin signal scanning
       EU pods: active 09:00-17:30 CET (OMX, IBKR)
09:00  ────── EU MARKET OPENS ──────
       Alt Data Swarm: AIS vessels, OpenSky flights
       OSINT Swarm: triggered by pods as needed
*      Continuous: Pods run their loop (30s-60s interval)
       Execution happens via adapters in real-time
14:30  ────── US PRE-MARKET ──────
       US pods intensify scanning
15:30  ────── US MARKET OPENS ──────
       Crypto pods: 24/7 (risk adjusted for macro events)
17:30  EU CLOSES: EU pods summarize, reduce exposure
18:00  Post-Mortem: Each pod evaluates the day
       Backtest Swarms: Quants spawn strategy tests
21:00  US CLOSES (after-hours)
22:00  US pods summarize, overnight risk adjustment
00:00  Crypto pods: night mode (reduced risk limits)

WEEKEND
──────────────────────────────────────────────────────
Sat 00:00  Data Assimilation: Compress weekly data
Sat 06:00  Backtest Tournament: Quants spawn 100+ variants
           ESG Audit Swarm: Weekly portfolio review
Sun 15:00  Orchestrator: Game plan for the week
Sun 23:00  Asia opens — crypto pods adjust
```

## 10. Configuration (alphanix.toml)

```toml
[orchestrator]
max_pods = 10
capital_total_usd = 10000       # Total capital under management
rebalance_interval_hours = 6
global_max_drawdown_pct = 5.0
morning_huddle_utc = "06:00"

[orchestrator.esg]
enabled = false                 # Phase 2: stub returns score=100 until data feeds integrated
planetary_boundary_checks = false
min_esg_score = 40              # 0-100, reject below threshold (active when enabled=true)

[swarms]
max_concurrent_workers = 5      # Hard limit for 4GB VM (Phase 2: 20+)
default_timeout_ms = 300000     # 5 min
backtest_timeout_ms = 900000    # 15 min (Phase 1 limit)

[pods.crypto]
enabled = true
adapter = "binance"
capital_pct = 40
strategy = "momentum_dip"
symbols = ["BTC/USDC", "ETH/USDC", "SOL/USDC"]
poll_interval_ms = 30000
risk_max_drawdown_pct = 3.0
risk_max_positions = 5

[pods.us_stocks]
enabled = true
adapter = "alpaca"
capital_pct = 35
strategy = "value_momentum"
symbols = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN"]
poll_interval_ms = 60000
risk_max_drawdown_pct = 2.0
risk_max_positions = 10
trading_hours = "09:30-16:00 ET"

[pods.eu_stocks]
enabled = false                 # Phase 2
adapter = "ibkr"
capital_pct = 25
strategy = "nordic_value"
symbols = ["HM-B.ST", "VOLV-B.ST", "SAND.ST"]
poll_interval_ms = 60000
risk_max_drawdown_pct = 2.0
risk_max_positions = 8
trading_hours = "09:00-17:30 CET"

[data_sources]
fred_api_key_env = "FRED_API_KEY"
opensky_enabled = true
ais_enabled = true
noaa_enabled = true
sec_edgar_enabled = true
copernicus_enabled = false      # Phase 2

[brain]
enabled = true
schedule_utc = ["06:00", "18:00"]
acute_trigger_consecutive_losses = 3
acute_trigger_daily_drawdown_pct = 2.0
cooldown_hours = 1

[timing]
orchestrator_loop_ms = 60000
pod_default_loop_ms = 30000
state_publish_interval_ms = 10000
```

## 11. File Structure

```
packages/agents/src/alphanix/
├── alphanix-agent.ts              # Main entry: Orchestrator + Pod manager
├── config.ts                      # TOML loader + AlphanixConfig types
├── types.ts                       # All Alphanix type definitions
├── orchestrator/
│   ├── orchestrator.ts            # Capital allocation, pod lifecycle, huddle
│   ├── capital-allocator.ts       # Portfolio-level capital distribution
│   └── global-risk.ts             # Cross-pod risk correlation checks
├── pod/
│   ├── pod.ts                     # Pod container: lifecycle, agent coordination
│   ├── pod-config.ts              # Per-pod configuration types
│   ├── quant-agent.ts             # Signal generation, model management
│   ├── risk-agent.ts              # VaR, stress tests, kill switch, ESG checks
│   ├── execution-agent.ts         # Order routing via adapters, TWAP/VWAP
│   └── data-agent.ts              # Feed management, data cleaning, swarm spawning
├── adapters/
│   ├── types.ts                   # MarketAdapter interface + normalized types
│   ├── adapter-registry.ts        # Adapter discovery and management
│   ├── binance-adapter.ts         # Crypto via CCXT
│   ├── alpaca-adapter.ts          # US Stocks via Alpaca SDK
│   └── ibkr-adapter.ts            # EU/SE Stocks via IB Gateway
├── swarms/
│   ├── swarm-spawner.ts           # Worker thread pool + priority queue
│   ├── swarm-budget-manager.ts    # Resource limits, preemption
│   ├── workers/
│   │   ├── osint-worker.ts        # News, filings, social media scraping
│   │   ├── backtest-worker.ts     # Strategy variant testing
│   │   ├── macro-worker.ts        # FRED, ECB, Riksbanken collection
│   │   ├── altdata-worker.ts      # AIS, OpenSky, NOAA
│   │   ├── esg-worker.ts          # ESG scoring, satellite analysis
│   │   └── sentiment-worker.ts    # Reddit, StockTwits, X analysis
│   └── types.ts                   # SwarmRequest, SwarmResult types
├── data/
│   ├── data-lake.ts               # Unified data access layer
│   ├── feeds/
│   │   ├── fred-feed.ts           # FRED API client
│   │   ├── ecb-feed.ts            # ECB Statistical Data Warehouse
│   │   ├── riksbanken-feed.ts     # Riksbanken API
│   │   ├── sec-edgar-feed.ts      # SEC EDGAR filings
│   │   ├── opensky-feed.ts        # Flight tracking
│   │   ├── ais-feed.ts            # Vessel tracking
│   │   └── noaa-feed.ts           # Weather/climate data
│   └── normalizer.ts              # Raw data → NormalizedTick pipeline
├── state/
│   ├── state-publisher.ts         # Redis state broadcasting
│   └── audit-logger.ts            # Postgres audit trail
└── __tests__/
    ├── orchestrator.test.ts
    ├── pod.test.ts
    ├── adapters.test.ts
    ├── swarms.test.ts
    └── data-feeds.test.ts

scripts/services/
├── alphanix-runner.ts             # Main entry point (Docker CMD)
└── alphanix-brain.ts              # Autonomous Claude Code analysis

alphanix.toml                      # Configuration
Dockerfile.alphanix                # Container image
```

## 12. Docker Integration

### Dockerfile.alphanix

```dockerfile
FROM node:20-alpine
WORKDIR /app

# Dependencies
RUN apk add --no-cache git python3
RUN npm install --no-save \
  ccxt @alpacahq/alpaca-trade-api @stoqey/ib \
  @iarna/toml ioredis pg zod \
  openai technicalindicators \
  node-fetch cheerio

# For brain service
RUN npm install -g @anthropic-ai/claude-code

# Stub @cryonix/types (type-only, erased by tsx)
RUN mkdir -p node_modules/@cryonix/types && \
    echo '{}' > node_modules/@cryonix/types/index.js

# Copy source
COPY packages/agents/src/ ./packages/agents/src/
COPY scripts/services/alphanix-runner.ts ./scripts/services/
COPY scripts/services/alphanix-brain.ts ./scripts/services/
COPY alphanix.toml ./

CMD ["npx", "tsx", "scripts/services/alphanix-runner.ts"]
```

### Docker Compose Services

```yaml
alphanix:
  build:
    context: .
    dockerfile: Dockerfile.alphanix
  container_name: alphanix
  restart: unless-stopped
  volumes:
    - ./alphanix.toml:/app/alphanix.toml:ro
  environment:
    - NODE_ENV=production
    - KV_URL=redis://redis:6379
    - POSTGRES_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/cryonix
    - BINANCE_API_KEY=${BINANCE_API_KEY}
    - BINANCE_API_SECRET=${BINANCE_API_SECRET}
    - ALPACA_API_KEY=${ALPACA_API_KEY}
    - ALPACA_API_SECRET=${ALPACA_API_SECRET}
    - FRED_API_KEY=${FRED_API_KEY:-}
    - XAI_API_KEY=${XAI_API_KEY:-}
  networks:
    - cryonix-net
  depends_on:
    redis:
      condition: service_healthy

alphanix-brain:
  build:
    context: .
    dockerfile: Dockerfile.alphanix
  container_name: alphanix-brain
  restart: unless-stopped
  volumes:
    - ~/.claude:/root/.claude:ro
    - /var/run/docker.sock:/var/run/docker.sock
    - ./alphanix.toml:/app/alphanix.toml
  environment:
    - NODE_ENV=production
    - KV_URL=redis://redis:6379
    - POSTGRES_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/cryonix
  command: ["npx", "tsx", "scripts/services/alphanix-brain.ts"]
  networks:
    - cryonix-net
  depends_on:
    redis:
      condition: service_healthy
```

## 13. New Dependencies

| Package | Purpose | Existing? |
|---------|---------|-----------|
| `ccxt` | Crypto exchange abstraction | Yes (engine) |
| `@alpacahq/alpaca-trade-api` | US stock trading | Yes (Aktienix) |
| `@stoqey/ib` | Interactive Brokers | Stub exists |
| `node-fetch` | HTTP client for API feeds | Common |
| `cheerio` | HTML scraping (SEC EDGAR, news) | New |
| `@iarna/toml` | TOML config | Yes |
| `ioredis` | Redis client | Yes |
| `pg` | Postgres client | Yes |
| `zod` | Runtime validation | Yes |
| `technicalindicators` | TA library | Yes |
| `openai` | Grok/LLM API calls | Yes |
| `worker_threads` | Swarm runtime | Node.js built-in |

New dependencies needed: `cheerio` (HTML parsing), `@stoqey/ib` (IBKR — needs extending).

## 14. Memory Budget & Infrastructure

### Hard Memory Budget (4GB VM, 25 existing containers)

| Component | Estimated RAM | Notes |
|-----------|--------------|-------|
| Alphanix main process | 200-300MB | Orchestrator + all pods |
| Swarm workers (max 4-6) | 120-180MB | ~30-40MB per worker thread |
| **Total Alphanix** | **320-480MB** | Hard cap: `mem_limit: 512m` in Docker |

`max_concurrent_workers` default: **5** (not 20). Backtest tournaments deferred to Phase 3 (requires larger VM or second VM).

### Docker Resource Limits

```yaml
alphanix:
  mem_limit: 512m
  memswap_limit: 768m
```

### Day 1 (Existing VM)

- Runs within existing Docker Compose stack
- Shares existing Redis and Postgres
- FRED API key needed (free, 120 requests/min)
- May need to pause 1-2 lower-priority agents to free memory

### Phase 2 (Second VM or VM upgrade)

- **Dedicated data VM** for heavy swarm workers (20+ concurrent)
- **TimescaleDB extension** for efficient time-series queries
- Backtest tournaments enabled (100+ parallel strategy variants)

### Phase 3 (Full Scale)

- **Dedicated Postgres instance** for data lake
- **Redis Cluster** for high-volume pub/sub
- Multiple VMs with pod distribution across nodes

## 14.5. Health & Monitoring

### Health Endpoint

`/api/alphanix/health` — matches existing monorepo pattern:

```typescript
{
  orchestrator: 'running' | 'error',
  pods: { [podId]: 'running' | 'paused' | 'liquidating' | 'error' },
  swarms: { active: number, queued: number, maxWorkers: number },
  adapters: { [adapterId]: 'connected' | 'disconnected' | 'rate_limited' },
  memory: { heapUsed: number, heapTotal: number, workerCount: number }
}
```

### Pod Heartbeat

Each pod writes `alphanix:pod:{id}:heartbeat` with TTL 90s on every loop. Orchestrator monitors — if heartbeat expires, pod is considered dead and gets restarted.

### Swarm Watchdog

Worker threads exceeding `maxDuration` are forcibly terminated. Leaked workers detected by comparing active thread count vs expected.

### Telegram Integration

Integrates with existing `health-monitor.sh` (cron every 5 min). Alphanix publishes `alphanix:status` to Redis, health monitor reads it alongside existing services.

## 15. What Alphanix Does NOT Change

- Existing agents (Aktienix, Solanix, etc.) continue running independently
- Shared Postgres and Redis are used, not replaced
- CLAUDE.md conventions, deploy scripts, and safe-deploy rules unchanged
- Existing dashboard at `/` unaffected; Alphanix gets `/alphanix` page

## 16. Phased Implementation

### Phase 1: Skeleton + One Pod (MVP)

- Orchestrator shell (capital allocation, pod lifecycle)
- One crypto pod (BinanceAdapter, reusing existing CCXT)
- Pod roles as plain classes (not BaseAgent subclasses) coordinated by `Pod` container
- `AlphanixAgent extends BaseAgent` as top-level entry
- Signal pipeline: Quant → Risk → Execution with typed interfaces
- No swarms yet (inline data fetching within Quant)
- No ESG (stub returning score=100)
- No IBKR
- Health endpoint + Redis state publishing
- TOML config, Dockerfile, Docker Compose service
- Dashboard page `/alphanix` with basic status

### Phase 2: Multi-Market + Swarms

- Second pod: US stocks (AlpacaAdapter)
- SwarmSpawner + SwarmBudgetManager (max 5 workers)
- OSINT swarm (news, SEC EDGAR, sentiment)
- Macro swarm (FRED, ECB, Riksbanken)
- Chokepoint data feeds (Trafikverket, AIS)
- Brain service (Claude Code CLI autonomous analysis)
- Pod-to-pod correlation checks in Orchestrator

### Phase 3: Full Scale

- Third pod: EU/SE stocks (IBKRAdapter)
- Backtest tournament swarms (requires VM upgrade)
- Alt data swarms (OpenSky, NOAA, satellite)
- ESG scoring with real data feeds
- Planetary boundary checks in Risk
- Dynamic pod creation/destruction
- Multi-VM distribution

## 17. Chokepoint & Alternative Data Catalog

The core intelligence advantage of Alphanix. These are the physical, digital, and bureaucratic bottlenecks where real-world economic activity must pass — and where AI agents can detect changes before traditional markets react.

### Tech & Semiconductors

| Chokepoint | Data Source | Signal |
|------------|------------|--------|
| SpaceX Boca Chica launches | FAA NOTAMs API | Launch windows → SpaceX supply chain |
| Starlink expansion | FCC terminal approval database | Global coverage timeline |
| Tesla Gigafactory Berlin | German environmental court water permits | Production capacity |
| Tesla Shanghai exports | Satellite parking lot car count | Quarterly delivery predictions |
| TSMC Taiwan water | Satellite reservoir levels | Chip shortage probability |
| ASML EUV machine transport | Dutch "heavy/wide load" road permits | Machine delivery timeline |
| Nvidia H100 shipments | Customs Bill of Lading (Asian ports) | Actual AI chip supply |
| Apple Store launches | Geolocalization foot traffic | iPhone demand proxy |
| Foxconn worker sentiment | Weibo NLP analysis | Labor disruption risk |
| Big Tech layoffs | LinkedIn/Indeed job posting scraping | Headcount reduction signals |

### Geopolitics, Shipping & Logistics

| Chokepoint | Data Source | Signal |
|------------|------------|--------|
| Panama Canal drought | Water level sensors API | Global freight cost spike |
| Suez/Red Sea (Houthi) | AIS dark fleet detection + insurance premiums | Energy/shipping shock |
| Hormuz Strait | AIS tanker tracking + OSINT Telegram | 20% of global oil at risk |
| Bremerhaven RoRo port | AIS vehicle carrier tracking | EU auto export volume |
| Corrugated cardboard price | FRED database | Leading e-commerce indicator |
| Baltic Dry Index velocity | Vessel speed tracking | Commodity demand proxy |
| China freight rail depots | Satellite imagery | True industrial activity |
| Laredo border crossing | Webcam truck counting | US-Mexico auto parts flow |
| Malmbanan Kiruna→Narvik | Trafikverket API + AIS Narvik | Iron ore supply chain |
| Narvik port cargo volume | AIS draft measurement | LKAB export tonnage |

### Energy & Commodities

| Chokepoint | Data Source | Signal |
|------------|------------|--------|
| Cushing OK oil tanks | SAR satellite shadow measurement | Crude inventory |
| Freeport LNG flare | Infrared satellite | Plant operational status |
| North Sea wind output | Weather APIs | Natural gas demand |
| Peru/Chile copper mines | Local OSINT (road blockades) | Copper supply disruption |
| Kazakhstan uranium plants | Thermal satellite | Nuclear fuel supply |
| Atacama lithium pools | Satellite color/size analysis | Battery metal production |
| Newcastle coal queue | AIS vessel queue length | Asian steel input cost |
| Ukraine/Russia neon gas | Export data scraping | Semiconductor laser supply |
| Russian dark fleet oil | Ship-to-ship transfer satellite detection | Sanctions evasion volume |
| ERCOT Texas grid stress | Grid stability API | Bitcoin miner shutdown risk |

### Food, Agriculture & Pharma

| Chokepoint | Data Source | Signal |
|------------|------------|--------|
| Mississippi River barge traffic | Water level gauges | US grain export capacity |
| Ivory Coast cocoa health | Satellite chlorophyll + rainfall | Chocolate commodity price |
| Novo Nordisk Ozempic supply | FDA shortage database + pharmacy scraping | Pharma revenue |
| Chinese swine fever | Local agriculture ministry reports | Global soy price impact |
| EU ammonia/fertilizer plants | Natural gas price threshold | Agriculture input cost |
| Norwegian salmon farms | Satellite algae bloom + water temp | Mowi/SalMar stock |

### Retail, Consumer & Construction

| Chokepoint | Data Source | Signal |
|------------|------------|--------|
| Concrete truck GPS | Fleet GPS data | Real-time construction activity |
| Lumber prices | Home Depot daily web scrape | US housing proxy |
| Fast fashion trends | TikTok/Instagram trend velocity | H&M inventory match |
| Macau luxury spend | Private jet tracking + hotel prices | Asian consumer confidence |
| Streaming subscriber growth | Reddit forum activity | Netflix/Spotify quarter |
| Mining truck tire imports | Customs import data | Mining expansion signal |
| Fast food foot traffic | Geolocation app data | Consumer spend comparison |

### Finance, Macro & M&A

| Chokepoint | Data Source | Signal |
|------------|------------|--------|
| Tether minting on-chain | Blockchain monitoring | Institutional BTC buying |
| Corporate jet convergence | OpenSky + FlightRadar24 | M&A probability |
| Pentagon pizza deliveries | UberEats/delivery app monitoring | Crisis indicator |
| Bankruptcy lawyer demand | Legal job platform scraping | Macro downturn signal |
| CEO insider buying | SEC Form 4 API (real-time) | Stock confidence |
| Big Tech GitHub commits | GitHub API activity tracking | Next AI infrastructure wave |
| Chinese battery patents | CNIPA patent scraping | Solid-state timeline |
| Air freight Shenzhen→LA | Freight rate APIs | Hardware launch timing |
| Lipstick Index | Credit card transaction data | Recession consumer behavior |
| Central bank language | NLP diff analysis (Fed, ECB, Riksbank) | Rate decision prediction |

### Scenario: Red Sea / Strait of Hormuz Crisis

Example of how Alphanix responds to a geopolitical chokepoint event:

```
DETECTION (T+0 seconds):
  AIS Agent: 3 supertankers make synchronized U-turn at Bab el-Mandeb
  Insurance Agent: War Risk Premium spikes from 0.1% to 2% at Lloyd's
  OSINT Agent: Arabic Telegram channels mention "drone" + "missile" near GPS coords

ANALYSIS (T+5 seconds):
  Orchestrator correlates 3 independent signals → HIGH CONFIDENCE blockade event
  Risk Manager stress-tests all pods against "Suez closure" scenario

EXECUTION (T+10 seconds):
  Pod Commodities: BUY Brent Crude futures (supply shortage)
  Pod Stocks: BUY Frontline, Maersk (rerouting = fleet scarcity = higher freight rates)
  Pod Stocks: SELL Skanska, BASF (energy cost spike + delayed components)
  Risk Manager: Increase stop-loss buffers 50% (high volatility expected)
```

## 18. Relationship to Existing Agents

- **Alphanix crypto pod vs Cryonix auto-trader:** Initially run in parallel with separate capital. Alphanix crypto pod uses its own capital allocation from `alphanix.toml`. Long-term, Alphanix may subsume Cryonix's crypto trading, but this is a Phase 3+ decision.
- **Alphanix US stock pod vs Aktienix:** Same approach — parallel with separate capital. Alphanix stock pod will have different strategies and use Alphanix's cross-asset intelligence.
- **Shared Binance API keys:** Rate limits are per-IP. Both systems can share keys but Alphanix adapter implements its own rate limiter to stay within budget.
- **Shared intelligence:** Alphanix can consume existing shared modules (Polymarket Intelligence, CMCScout data) via Redis.

## 19. Research References

Key papers and concepts informing this design:

- **QuantAgents** (ACL) — Multi-agent financial system via simulated trading
- **InvestESG** (arXiv 2024) — Multi-agent RL for climate investment decisions
- **FinGPT** (Columbia/NYU) — Open-source LLM framework for financial OSINT
- **Pod System** — Millennium Management, Citadel operational structure
- **Adapter Pattern** — Gang of Four design pattern for market abstraction
- **True Cost Accounting** — FAO framework for pricing externalities
- **Planetary Boundaries** — Rockström framework for ESG risk limits
