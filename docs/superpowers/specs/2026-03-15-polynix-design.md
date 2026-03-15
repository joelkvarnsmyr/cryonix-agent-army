# Polynix — Design Specification
*2026-03-15*

## Overview

Polynix is an autonomous 5-minute binary options trading agent for Polymarket's crypto micro-markets. It exploits two edges: **arbitrage** (buying both YES and NO when their combined ask price is below $1.00) and **directional momentum** (betting on price direction when Polymarket odds lag behind real-time CEX price action).

**Phase 1:** Paper trading — virtual $500 USDC, arb detection + directional signal logging.
**Phase 2:** Live trading — Polygon wallet, CLOB API orders, real $50 capital.
**Phase 3:** Scale — Binance WebSocket momentum, multi-asset, mean-reversion.

---

## Goals

- Capture risk-free arbitrage on 5-minute crypto binary markets (YES + NO < $1.00)
- Exploit momentum lag between CEX price and Polymarket probability
- Paper trade first — flip one config flag to go live
- Reuse proven abstractions (StatePublisher, shared PolymarketIntelligence)
- Independent capital pool from all other agents

---

## Core Edge Explained

### Arbitrage (Risk-Free)

Polymarket 5-minute contracts are binary: "Will BTC go UP or DOWN in the next 5 minutes?" At resolution, one side pays $1.00, the other pays $0.00. YES and NO tokens should always sum to $1.00.

During volatility spikes, market makers widen spreads and liquidity thins. The combined best-ask price can temporarily drop below $1.00:

```
Normal:    YES ask $0.52 + NO ask $0.48 = $1.00  (no edge)
Volatile:  YES ask $0.47 + NO ask $0.48 = $0.95  (5.26% guaranteed profit)
```

By buying both sides simultaneously, the agent locks in a risk-free profit regardless of the outcome:
- BTC goes up: YES pays $1.00, NO pays $0.00. Cost was $0.95. Profit: $0.05
- BTC goes down: YES pays $0.00, NO pays $1.00. Cost was $0.95. Profit: $0.05

**Constraints:** Must execute both legs atomically (or near-simultaneously). Fees (up to 1.56% per side) eat into the edge — true profit threshold is higher than the raw spread.

### Directional Momentum

Polymarket odds update slower than CEX prices. When BTC spikes +0.5% in 30 seconds on Binance, the YES probability on Polymarket may still sit at 50%. The agent buys YES at $0.50 when fair value is closer to $0.65-0.70 based on momentum.

**Edge estimate:** 5-15% per trade on strong momentum signals, but with ~50-60% win rate. Kelly sizing keeps risk controlled.

### Mean-Reversion (Phase 3)

After sharp moves, Polymarket odds overshoot. If YES jumps from 50% to 80% on a minor price tick, fading back toward 60% can be profitable. Requires more data to calibrate thresholds.

---

## Architecture

### File Structure

```
packages/agents/src/polynix/
  polynix-agent.ts              # Orchestrator, main trading loop
  types.ts                      # PolynixPosition, ArbSignal, DirectionalSignal, etc.
  config.ts                     # TOML loader with safe defaults
  market-scanner.ts             # Gamma API: discover active 5-min crypto markets
  spread-detector.ts            # YES+NO arbitrage detection from CLOB orderbook
  directional-engine.ts         # Momentum-based directional bets (CEX vs Polymarket)
  order-manager.ts              # CLOB API order placement + heartbeat
  position-tracker.ts           # Track open bets until resolution + P&L accounting
  risk-manager.ts               # Kelly sizing, daily loss limit, consecutive loss circuit breaker
  index.ts                      # Exports

scripts/services/
  polynix-runner.ts             # Entrypoint for Docker / screen session

polynix.toml                    # Configuration (repo root)
Dockerfile.polynix              # Docker image
```

### What is reused from other agents

| Component | Reused | Notes |
|-----------|--------|-------|
| `StatePublisher` | Yes | Publishes to Redis `polynix:*` keys |
| `PolymarketIntelligence` | Yes | Shared module for macro sentiment context |
| Redis patterns | Yes | Same key conventions as other agents |
| TOML config loader | Yes | Same pattern as aktienix.toml / copynix.toml |
| Dockerfile pattern | Yes | Same base image pattern as Dockerfile.aktienix |

---

## Data Sources

### Tier 1: Polymarket APIs (Real-time)

**Gamma API** — Market discovery
- Endpoint: `https://gamma-api.polymarket.com`
- No authentication required
- Used to find active 5-minute crypto markets
- Query: `GET /events?active=true&tag=crypto` + filter by market duration
- Rate limit: Generous (no documented cap, but respect 1 req/s)

**CLOB API** — Order book + order execution
- Endpoint: `https://clob.polymarket.com`
- Requires authentication: Polygon private key derived credentials
- Key endpoints:
  - `GET /book` — Current orderbook (YES/NO best bid/ask, depth)
  - `POST /order` — Place limit order
  - `DELETE /order/{id}` — Cancel order
  - `GET /positions` — Current positions
  - `WS /ws` — Real-time orderbook updates + heartbeat
- **Heartbeat requirement:** Must send ping every 10 seconds or open orders are cancelled
- Fees: Up to 1.56% on crypto markets

### Tier 2: CEX Price Feed (Directional Engine)

**Binance REST** (Phase 1)
- `GET /api/v3/ticker/price?symbol=BTCUSDT`
- Polled every 5 seconds alongside market scan
- Sufficient for paper trading

**Binance WebSocket** (Phase 2+)
- `wss://stream.binance.com:9443/ws/btcusdt@trade`
- Sub-100ms price updates
- Required for accurate momentum calculation

### Tier 3: Shared Intelligence

**PolymarketIntelligence** (`packages/agents/src/shared/polymarket-intelligence.ts`)
- Already deployed, scanning every 15 minutes
- Provides: crypto sentiment, macro risk, BTC implied range
- Used as contextual overlay (not primary signal source)

---

## Module Contracts

### `market-scanner.ts`

Discovers active 5-minute binary crypto markets on Polymarket.

```typescript
interface CryptoMicroMarket {
  conditionId: string;         // Polymarket condition ID
  questionId: string;          // Market question ID
  title: string;               // e.g., "Will BTC go up in the next 5 minutes?"
  asset: 'BTC' | 'ETH' | 'SOL';
  expiresAt: number;           // Unix ms
  timeToExpiry: number;        // Seconds remaining
  yesTokenId: string;          // CLOB token ID for YES
  noTokenId: string;           // CLOB token ID for NO
}

class MarketScanner {
  /** Fetch active 5-min crypto markets expiring in 1-4 minutes */
  async scan(): Promise<CryptoMicroMarket[]>;

  /** Filter: must be crypto, must be binary (2 outcomes), must expire within window */
  private filterEligible(events: GammaEvent[]): CryptoMicroMarket[];
}
```

**Filtering logic:**
1. Query Gamma API for active crypto events
2. Filter to binary markets (exactly 2 outcomes: YES/NO)
3. Filter to 5-minute duration markets
4. Filter to markets expiring in 60-240 seconds (enough time to enter, not too early)
5. Return sorted by time-to-expiry (soonest first)

### `spread-detector.ts`

Checks CLOB orderbooks for arbitrage opportunities.

```typescript
interface ArbOpportunity {
  market: CryptoMicroMarket;
  yesBestAsk: number;          // Best ask price for YES token
  noBestAsk: number;           // Best ask price for NO token
  combinedCost: number;        // yesBestAsk + noBestAsk
  grossEdge: number;           // 1.0 - combinedCost (before fees)
  netEdge: number;             // grossEdge - (2 * feeRate) — profit after fees
  yesLiquidity: number;        // Available size at best ask (USD)
  noLiquidity: number;         // Available size at best ask (USD)
  maxSize: number;             // Min of yes/no liquidity (bottleneck)
}

class SpreadDetector {
  /** Check orderbook for both sides, compute spread */
  async check(market: CryptoMicroMarket): Promise<ArbOpportunity | null>;

  /** Returns non-null only if netEdge > 0 (profitable after fees) */
  private isArbitrageable(yes: number, no: number, feeRate: number): boolean;
}
```

**Key implementation detail:** The fee rate on crypto markets is up to 1.56%. For a two-sided arb trade:
- Total fees: 2 * 1.56% = 3.12%
- Minimum gross edge needed: >3.12% (i.e., YES + NO < $0.9688)
- Configured `arb_threshold` of 0.98 provides a 2% gross margin, which is NOT enough after fees
- **Recommendation:** Default `arb_threshold` should be 0.96 to ensure profitability after fees
- The detector should compute `netEdge` dynamically rather than relying solely on the threshold

### `directional-engine.ts`

Compares real-time CEX price momentum against Polymarket probability.

```typescript
interface DirectionalSignal {
  market: CryptoMicroMarket;
  direction: 'YES' | 'NO';
  currentPrice: number;         // Current BTC/ETH price on Binance
  priceChangePct: number;       // % change over lookback window
  polymarketProb: number;       // Current YES probability on Polymarket
  impliedFairProb: number;      // Estimated fair probability based on momentum
  edge: number;                 // impliedFairProb - polymarketProb (or inverse for NO)
  confidence: number;           // 0-100 signal strength
}

class DirectionalEngine {
  /** Price history buffer (circular, last 5 minutes) */
  private priceHistory: Map<string, { price: number; timestamp: number }[]>;

  /** Calculate momentum and compare to Polymarket odds */
  async evaluate(market: CryptoMicroMarket): Promise<DirectionalSignal | null>;

  /** Feed price update (called on every scan tick or WS message) */
  recordPrice(asset: string, price: number): void;

  /** Map price momentum to implied probability */
  private momentumToProb(changePct: number, lookbackSeconds: number): number;
}
```

**Momentum-to-probability mapping (heuristic, to be calibrated):**
- 0.0% change → 50% implied probability
- +0.3% in 60s → ~60% implied YES probability
- +0.5% in 60s → ~70% implied YES probability
- +1.0% in 60s → ~85% implied YES probability
- Symmetric for negative moves (→ NO probability)

**Signal generation:**
1. Compute 60-second price momentum from `priceHistory`
2. Map to implied fair probability
3. Compare with Polymarket YES mid-price
4. If edge > `min_edge_pct` (default 2%) → generate signal
5. Confidence = edge magnitude * momentum consistency (steady trend > spike)

### `order-manager.ts`

Handles CLOB API authentication, order placement, and heartbeat.

```typescript
interface OrderResult {
  orderId: string;
  status: 'filled' | 'partial' | 'open' | 'rejected';
  filledQty: number;
  filledPrice: number;
}

class OrderManager {
  private clobClient: ClobClient;  // @polymarket/clob-client
  private heartbeatTimer: NodeJS.Timer | null;

  /** Initialize CLOB client with Polygon wallet credentials */
  constructor(config: PolynixBrokerConfig);

  /** Place a limit order for a specific token (YES or NO) */
  async placeOrder(
    tokenId: string,
    side: 'BUY',
    price: number,
    size: number
  ): Promise<OrderResult>;

  /** Place both legs of an arb trade (near-simultaneously) */
  async placeArbOrders(
    arb: ArbOpportunity,
    size: number
  ): Promise<{ yesOrder: OrderResult; noOrder: OrderResult }>;

  /** Cancel an open order */
  async cancelOrder(orderId: string): Promise<void>;

  /** Start heartbeat loop (every 8s, must be <10s) */
  startHeartbeat(): void;

  /** Stop heartbeat loop */
  stopHeartbeat(): void;

  /** Get current positions from CLOB */
  async getPositions(): Promise<ClobPosition[]>;

  /** Get account balance (USDC on Polygon) */
  async getBalance(): Promise<number>;
}
```

**Authentication flow:**
1. Load Polygon private key from env (`POLYNIX_POLYGON_PRIVATE_KEY`)
2. Derive CLOB API credentials using `@polymarket/clob-client` helper:
   - `apiKey`, `secret`, `passphrase` derived from wallet signature
3. Initialize `ClobClient` with credentials
4. Start heartbeat immediately

**Paper trading mode:**
- When `paper_trading = true`, OrderManager simulates fills instantly at the quoted price
- No CLOB connection or Polygon wallet needed
- Fills stored in-memory, positions tracked by PositionTracker

### `position-tracker.ts`

Tracks open bets and handles resolution.

```typescript
interface PolynixPosition {
  id: string;                   // UUID
  market: CryptoMicroMarket;
  type: 'arb' | 'directional';
  side: 'YES' | 'NO' | 'BOTH'; // BOTH for arb
  entryPrice: number;           // Average fill price
  size: number;                 // Number of contracts
  costBasis: number;            // Total USD spent (including fees)
  enteredAt: number;            // Unix ms
  expiresAt: number;            // Market expiry time
  status: 'open' | 'won' | 'lost' | 'settled';
  pnl: number;                  // Realized P&L (0 until settled)
}

class PositionTracker {
  private positions: Map<string, PolynixPosition>;

  /** Record a new position from filled order(s) */
  addPosition(pos: PolynixPosition): void;

  /** Check all positions for expired markets and settle */
  async settleExpired(): Promise<PolynixPosition[]>;

  /** Get all open (unsettled) positions */
  getOpen(): PolynixPosition[];

  /** Get count of open positions */
  getOpenCount(): number;

  /** Get total cost basis of open positions (current exposure) */
  getExposure(): number;

  /** Publish positions to Redis */
  async publishState(redis: Redis): Promise<void>;
}
```

**Settlement logic:**
1. Every scan tick, check if any position's `expiresAt` has passed
2. Query market resolution from Gamma API (`GET /markets/{conditionId}`)
3. Compute P&L:
   - Arb: always profit (payout $1.00 - costBasis)
   - Directional YES win: payout $1.00 * size - costBasis
   - Directional YES lose: payout $0.00 - costBasis (total loss of stake)
4. Update position status, record to trade log
5. Persist to Postgres `trades` table (tagged source = 'polynix')

### `risk-manager.ts`

Position sizing and loss circuit breakers.

```typescript
interface RiskDecision {
  canTrade: boolean;
  reason?: 'daily_loss_limit' | 'max_consecutive_losses' | 'max_positions' | 'max_exposure';
  suggestedSize: number;        // Kelly-optimal size in USD (0 if cannot trade)
}

class RiskManager {
  private dailyPnl: number;
  private consecutiveLosses: number;
  private lastResetDate: string;  // YYYY-MM-DD, resets daily

  /** Full risk check: can we place a new trade? */
  check(
    edge: number,               // Estimated edge (0-1)
    winProb: number,            // Estimated win probability (0-1)
    config: PolynixRiskConfig,
    openPositions: number,
    currentExposure: number
  ): RiskDecision;

  /** Kelly criterion bet sizing */
  kellySizing(
    edge: number,
    winProb: number,
    bankroll: number,
    kellyFraction: number,      // 0.25 = quarter Kelly
    maxBet: number
  ): number;

  /** Record a settled trade result */
  recordResult(pnl: number): void;

  /** Publish risk state to Redis */
  async publishState(redis: Redis): Promise<void>;
}
```

**Kelly criterion formula:**
```
f* = (p * b - q) / b
where:
  p = probability of winning
  b = odds (payout / stake - 1)
  q = 1 - p

kelly_size = bankroll * f* * kelly_fraction
capped_size = min(kelly_size, max_bet_size_usd)
```

**Circuit breakers:**
1. Daily loss > `max_daily_loss_usd` → stop trading until midnight UTC
2. Consecutive losses >= `max_consecutive_losses` → pause 30 minutes
3. Open positions >= `max_concurrent_positions` → wait for settlement
4. Total exposure >= 50% of bankroll → no new trades

---

## Configuration (polynix.toml)

```toml
[broker]
paper_trading = true
polygon_rpc_url = "https://polygon-rpc.com"
clob_api_url = "https://clob.polymarket.com"
gamma_api_url = "https://gamma-api.polymarket.com"

[capital]
starting_balance_usd = 500
max_bet_size_usd = 10
max_concurrent_positions = 5
max_exposure_pct = 50           # Never have more than 50% of bankroll in open bets

[strategy]
arb_threshold = 0.96            # YES+NO must be below this (accounts for ~3.12% round-trip fees)
min_edge_pct = 2.0              # Minimum edge for directional bets (after fees)
momentum_lookback_seconds = 60  # How far back to measure price momentum
mean_reversion_threshold = 0.15 # Odds swing > 15% = potential fade (Phase 3)
min_time_to_expiry_s = 60       # Don't enter markets expiring in < 60s
max_time_to_expiry_s = 240      # Don't enter markets expiring in > 4min

[risk]
kelly_fraction = 0.25           # Quarter Kelly (conservative)
max_daily_loss_usd = 25         # 5% of starting capital
max_consecutive_losses = 5      # Pause after 5 straight losses
fee_rate = 0.0156               # 1.56% per trade (Polymarket crypto fee)

[timing]
scan_interval_ms = 5000         # Scan every 5s (fast markets)
heartbeat_interval_ms = 8000    # CLOB heartbeat (must be <10s)
settlement_check_ms = 10000     # Check for settled markets every 10s

[data_sources]
binance_ws = false              # Phase 1: REST polling. Phase 2: WebSocket
use_polymarket_intelligence = true
binance_symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
```

---

## Redis Keys

```
polynix:status           — "running" | "paused" | "stopped"
polynix:account          — { balance, totalPnl, openPositions, tradesTotal, winRate }
polynix:positions        — PolynixPosition[] (current open bets)
polynix:risk             — { dailyPnl, consecutiveLosses, lastResetDate, circuitBreakerActive }
polynix:arb_log          — Last 100 arb opportunities { timestamp, market, combinedCost, netEdge, executed }
polynix:signals          — Last 100 signals { timestamp, type, market, edge, direction, executed, reasoning }
polynix:trades           — Last 200 settled trades { market, type, side, entry, pnl, settledAt }
```

All keys use JSON serialization. TTL: `polynix:arb_log` and `polynix:signals` have 24h TTL. Others persist until overwritten.

---

## Data Flow

```
1. Main Loop (every 5s) — polynix-agent.ts
   ├── MarketScanner.scan()
   │   └── Fetch active 5-min crypto markets from Gamma API
   │   └── Filter: crypto only, binary, expiring in 60-240s
   │
   ├── For each eligible market:
   │   ├── SpreadDetector.check(market)
   │   │   └── Fetch YES + NO best-ask from CLOB orderbook
   │   │   └── If YES_ask + NO_ask < arb_threshold AND netEdge > 0:
   │   │       └── → ARB SIGNAL
   │   │
   │   ├── DirectionalEngine.evaluate(market)
   │   │   └── Fetch current CEX price (Binance REST or WS)
   │   │   └── Calculate 60s momentum
   │   │   └── Compare momentum-implied probability vs Polymarket odds
   │   │   └── If edge > min_edge_pct:
   │   │       └── → DIRECTIONAL SIGNAL
   │   │
   │   └── RiskManager.check(signal)
   │       └── Daily loss check
   │       └── Consecutive loss check
   │       └── Max positions check
   │       └── Kelly sizing
   │       └── → RISK DECISION (canTrade + suggestedSize)
   │
   ├── OrderManager.placeOrder() or placeArbOrders()
   │   └── Paper mode: simulate instant fill
   │   └── Live mode: CLOB API limit order
   │
   └── PositionTracker.addPosition()

2. Settlement Loop (every 10s) — polynix-agent.ts
   ├── PositionTracker.settleExpired()
   │   └── Check each open position's expiry
   │   └── Query Gamma API for market resolution
   │   └── Compute P&L
   │   └── RiskManager.recordResult(pnl)
   │
   └── StatePublisher.publish()
       └── Write all Redis keys

3. Heartbeat Loop (every 8s) — order-manager.ts
   └── Send CLOB API heartbeat ping
   └── Required to keep open orders alive (auto-cancel after 10s without heartbeat)
```

---

## Main Agent Loop

```typescript
// polynix-agent.ts — simplified pseudocode

class PolynixAgent {
  private scanner: MarketScanner;
  private spreadDetector: SpreadDetector;
  private directionalEngine: DirectionalEngine;
  private orderManager: OrderManager;
  private positionTracker: PositionTracker;
  private riskManager: RiskManager;
  private redis: Redis;
  private config: PolynixConfig;

  async run(): Promise<void> {
    this.orderManager.startHeartbeat();
    log('Polynix agent started');

    while (true) {
      try {
        // 1. Settle any expired positions
        const settled = await this.positionTracker.settleExpired();
        for (const pos of settled) {
          this.riskManager.recordResult(pos.pnl);
          log(`Settled: ${pos.market.title} → ${pos.pnl > 0 ? 'WIN' : 'LOSS'} $${pos.pnl.toFixed(2)}`);
        }

        // 2. Scan for active markets
        const markets = await this.scanner.scan();

        for (const market of markets) {
          // 3a. Check for arbitrage
          const arb = await this.spreadDetector.check(market);
          if (arb && arb.netEdge > 0) {
            const risk = this.riskManager.check(
              arb.netEdge, 0.99, this.config,  // 99% win prob for arb
              this.positionTracker.getOpenCount(),
              this.positionTracker.getExposure()
            );
            if (risk.canTrade) {
              const size = Math.min(risk.suggestedSize, arb.maxSize);
              const orders = await this.orderManager.placeArbOrders(arb, size);
              this.positionTracker.addPosition(/* ... */);
              log(`ARB: ${market.title} | edge=${(arb.netEdge * 100).toFixed(2)}% | size=$${size}`);
            }
          }

          // 3b. Check for directional signal
          const signal = await this.directionalEngine.evaluate(market);
          if (signal && signal.edge > this.config.strategy.min_edge_pct / 100) {
            const risk = this.riskManager.check(
              signal.edge, signal.confidence / 100, this.config,
              this.positionTracker.getOpenCount(),
              this.positionTracker.getExposure()
            );
            if (risk.canTrade) {
              const order = await this.orderManager.placeOrder(
                signal.direction === 'YES' ? market.yesTokenId : market.noTokenId,
                'BUY', signal.polymarketProb, risk.suggestedSize
              );
              this.positionTracker.addPosition(/* ... */);
              log(`DIRECTIONAL ${signal.direction}: ${market.title} | edge=${(signal.edge * 100).toFixed(2)}%`);
            }
          }
        }

        // 4. Publish state to Redis
        await this.positionTracker.publishState(this.redis);
        await this.riskManager.publishState(this.redis);

      } catch (err) {
        log(`Scan error: ${err.message}`);
        // Individual market errors should not kill the loop
      }

      await sleep(this.config.timing.scan_interval_ms);
    }
  }
}
```

---

## Docker Setup

### Dockerfile.polynix

```dockerfile
FROM node:20-alpine

RUN apk add --no-cache git

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY packages/agents/package.json packages/agents/
COPY packages/types/package.json packages/types/

# Install dependencies
RUN npm i -g pnpm && pnpm install --frozen-lockfile

# Copy source
COPY packages/agents/ packages/agents/
COPY packages/types/ packages/types/
COPY polynix.toml ./

# Install tsx for TypeScript execution
RUN pnpm add -w tsx

CMD ["npx", "tsx", "scripts/services/polynix-runner.ts"]
```

### docker-compose.prod.yml (service addition)

```yaml
polynix:
  build:
    context: .
    dockerfile: Dockerfile.polynix
  container_name: polynix
  restart: unless-stopped
  env_file: .env
  environment:
    - KV_URL=redis://redis:6379
    - POSTGRES_URL=postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/cryonix
    - POLYNIX_POLYGON_PRIVATE_KEY=${POLYNIX_POLYGON_PRIVATE_KEY}
  depends_on:
    - redis
    - postgres
  networks:
    - cryonix
```

---

## Environment Variables

```
# Required for live trading (Phase 2)
POLYNIX_POLYGON_PRIVATE_KEY=0x...   # Polygon wallet private key (holds USDC)

# Required always
KV_URL=redis://redis:6379
POSTGRES_URL=postgres://...

# Optional (Phase 2+)
BINANCE_WS_URL=wss://stream.binance.com:9443/ws   # Binance WebSocket (default)
```

---

## Implementation Phases

### Phase 1: Paper Trading MVP

**Scope:** Market scanning, arb detection, directional signal logging, virtual P&L.

**Deliverables:**
1. `market-scanner.ts` — Gamma API integration, 5-min market discovery
2. `spread-detector.ts` — CLOB orderbook reading (REST, no auth needed for reads)
3. `directional-engine.ts` — Binance REST price polling, momentum calculation
4. `position-tracker.ts` — Virtual positions, simulated settlement
5. `risk-manager.ts` — Kelly sizing, loss limits
6. `order-manager.ts` — Paper trading mode (simulated fills)
7. `polynix-agent.ts` — Main loop orchestration
8. `config.ts` + `types.ts` + `polynix.toml`
9. Redis state publishing
10. `polynix-runner.ts` entry point

**Success criteria:**
- Scans markets every 5s, finds eligible 5-min crypto markets
- Detects arb opportunities when they exist (even if rare)
- Generates directional signals with logged reasoning
- Tracks virtual P&L accurately
- Publishes state to Redis

**Timeline estimate:** 2-3 sessions.

### Phase 2: Live Trading ($50)

**Scope:** Real order execution on Polymarket CLOB.

**Deliverables:**
1. Polygon wallet setup + USDC funding
2. CLOB API authentication (derive credentials from private key)
3. Real order placement via `@polymarket/clob-client`
4. Heartbeat management (8s interval)
5. Fill monitoring and partial fill handling
6. Binance WebSocket for sub-second price data

**Success criteria:**
- Places real orders on Polymarket CLOB
- Heartbeat keeps orders alive
- Fills are tracked and settled correctly
- P&L matches on-chain reality

**Timeline estimate:** 2 sessions.

### Phase 3: Scale + Optimize

**Scope:** Performance optimization, mean-reversion, multi-asset expansion.

**Deliverables:**
1. Mean-reversion signal engine (fade overshoots)
2. Multi-asset support (BTC + ETH + SOL simultaneously)
3. Order book depth analysis (avoid thin books)
4. Performance analytics dashboard (Next.js page at `/polynix`)
5. Telegram notifications for arb captures
6. Polynix Brain (Claude Code autonomous analyst, same pattern as AktienixBrain)

**Timeline estimate:** Ongoing.

---

## Key Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| 5-min crypto markets don't exist or are illiquid | Strategy is unviable | Phase 1 validates market availability before any capital deployment. Pivot to longer-duration markets if needed. |
| Arb opportunities are too rare or too thin after fees | Low revenue | Track arb frequency in Phase 1. Directional strategy provides secondary edge. |
| CLOB API latency too high for 5-min markets | Missed fills, stale prices | Use WebSocket feed instead of REST. Place aggressive limit orders (cross the spread). |
| Polymarket fee structure changes | Edge destroyed | Monitor fee announcements. Adjust `arb_threshold` dynamically. |
| Polygon gas costs eat profits | Negative EV | Batch transactions where possible. Monitor gas costs per trade. |
| Private key compromise | Total loss | Use dedicated wallet with small balance. Never store key in code. |
| Heartbeat failure → orders cancelled | Missed trades | Redundant heartbeat timer with error recovery. Alert on heartbeat failure. |
| Market manipulation on thin books | Bad fills | Min liquidity requirement on both sides before entering arb. |

---

## API Routes (Future)

```
GET  /api/polynix/status      — Agent status, uptime, current config
GET  /api/polynix/positions    — Open bets with time-to-expiry
GET  /api/polynix/trades       — Recent settled trades with P&L
GET  /api/polynix/arb-log      — Arb opportunity history (hit rate)
GET  /api/polynix/stats        — Aggregate stats (win rate, total P&L, Sharpe)
```

---

## Dependencies

```json
{
  "@polymarket/clob-client": "latest",
  "ethers": "^6.x",
  "ws": "^8.x",
  "ioredis": "^5.x",
  "toml": "^3.x"
}
```

---

## Open Questions

1. **Do 5-minute crypto binary markets actually exist on Polymarket?** The platform is known for longer-duration prediction markets. Phase 1 must validate this assumption. If they don't exist, the strategy pivots to hourly/daily crypto price markets with adjusted edge calculations.

2. **What is the actual fee structure for sub-$10 trades?** Polymarket fees may have minimum amounts that make micro-bets unprofitable. Need to verify empirically.

3. **Can we read CLOB orderbooks without authentication?** The Gamma API is public, but orderbook depth data may require CLOB auth even for reads. Phase 1 will determine this.

4. **Polygon gas costs per transaction?** At current MATIC prices, each order may cost $0.01-0.05 in gas. For $10 bets, this is 0.1-0.5% — acceptable but needs tracking.

5. **Heartbeat WebSocket vs REST?** Need to determine if heartbeat can be sent via REST endpoint or requires a persistent WebSocket connection.
