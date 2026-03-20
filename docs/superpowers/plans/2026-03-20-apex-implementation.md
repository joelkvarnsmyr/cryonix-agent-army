# APEX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build APEX, a meta-intelligence trading agent that consumes signals from all 7 existing instances via Redis and only trades when multiple sources confirm a high-conviction setup.

**Architecture:** APEX is a TypeScript agent (same pattern as Solanix/Copynix) that reads Redis state from all instances every 15 seconds, computes a direction-aware confluence score per symbol, and executes trades via Binance CCXT (spot) or paper-simulation (shorts) when the score exceeds configurable thresholds. Three trading modes: Venus Rx Harvest (shorts during Venus retrograde), Dip Sniper (value dips with cross-instance confirmation), and Cross-Signal Confluence (3+ instances agreeing).

**Tech Stack:** TypeScript, ioredis, CCXT (Binance), @iarna/toml, tsx, Docker, Next.js API routes + dashboard page

**Spec:** `docs/superpowers/specs/2026-03-20-apex-meta-intelligence-trader.md`

---

## File Map

```
CREATE packages/agents/src/apex/config.ts              # TOML loader + interface + defaults
CREATE packages/agents/src/apex/signal-aggregator.ts    # Reads all 7 Redis sources, normalizes to common format
CREATE packages/agents/src/apex/confluence-scorer.ts    # Computes direction-aware confluence score per symbol
CREATE packages/agents/src/apex/risk-gate.ts            # Kelly sizing, circuit breakers, drawdown tracking
CREATE packages/agents/src/apex/exit-monitor.ts         # TP/SL/trailing per mode, max hold enforcement
CREATE packages/agents/src/apex/apex-agent.ts           # Main orchestrator — scan loop, mode selection, execution
CREATE scripts/services/apex-runner.ts                  # Docker entrypoint
CREATE apex.toml                                        # Configuration file
CREATE Dockerfile.apex                                  # Docker image
CREATE apps/web/src/app/api/apex/status/route.ts        # API endpoint
CREATE apps/web/src/hooks/useApex.ts                    # React polling hook
CREATE apps/web/src/app/apex/page.tsx                   # Dashboard page
MODIFY apps/web/src/components/dashboard/dashboard-layout.tsx  # Add APEX to NAV_GROUPS
MODIFY apps/web/src/components/command-palette.tsx       # Add /apex shortcut
MODIFY docker-compose.prod.yml                          # Add apex service
MODIFY packages/agents/src/copynix/copynix-agent.ts     # Publish copynix:signals to Redis
MODIFY apps/web/src/app/api/overview/route.ts           # Add APEX to overview aggregation
```

---

### Task 1: Config — TOML loader + apex.toml

**Files:**
- Create: `packages/agents/src/apex/config.ts`
- Create: `apex.toml`

- [ ] **Step 1: Create `packages/agents/src/apex/config.ts`**

Follow the exact pattern from `packages/agents/src/solanix/config.ts`. Define `ApexTomlConfig` interface matching the spec's TOML structure, provide `APEX_DEFAULTS`, and export `loadApexConfig()`.

```typescript
import { readFileSync, existsSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';

export interface ApexTomlConfig {
    general: { name: string; mode: 'paper' | 'live'; capital: number; currency: string; scan_interval_seconds: number };
    confluence: { min_score_full_kelly: number; min_score_half_kelly: number };
    'confluence.weights': { vedic_venus_rx: number; cryonix_deep_value: number; cryonix_dip_buy: number; copynix_single_whale: number; polymarket_sentiment_shift: number; cmc_extreme_fear: number; psinix_coherence: number; solanix_volume_spike: number; aktienix_macro_bullish: number; cmc_btc_dom_falling: number; cryonix_rsi_overbought: number; cryonix_macd_bearish: number; polymarket_sentiment_falling: number; cmc_fear_greed_dropping: number; cmc_btc_dom_rising: number };
    'confluence.thresholds': { cryonix_min_confidence: number; copynix_min_whale_score: number; polymarket_min_delta: number; cmc_max_fear_greed: number; psinix_min_coherence: number; confluence_window_seconds: number };
    risk: { kelly_fraction: number; max_drawdown_pct: number; daily_loss_limit_pct: number; max_consecutive_losses: number; loss_reduction_factor: number; loss_reduction_trades: number; max_concurrent_positions: number; cash_reserve_pct: number };
    'modes.venus_rx': { enabled: boolean; symbols: string[]; sizing_pct: number; tp_pct: number; sl_pct: number; trailing_pct: number; trailing_activation_pct: number; max_hold_hours: number };
    'modes.dip_sniper': { enabled: boolean; sizing_pct: number; tp_pct: number; sl_pct: number; trailing_pct: number; trailing_activation_pct: number; max_hold_hours: number };
    'modes.confluence': { enabled: boolean; sizing_pct: number; tp_pct: number; sl_pct: number; trailing_pct: number; trailing_activation_pct: number; max_hold_hours: number };
    telegram: { enabled: boolean; alert_on_entry: boolean; alert_on_exit: boolean; alert_on_circuit_breaker: boolean };
}
```

Note: TOML nested tables like `[confluence.weights]` are parsed by `@iarna/toml` as nested objects `{ confluence: { weights: {...} } }`. The config loader must handle this — flatten or access via `parsed.confluence?.weights`. Use the deep-merge pattern from solanix config.

- [ ] **Step 2: Create `apex.toml`**

Copy the exact TOML from the spec (lines 262-340). This is the runtime configuration file.

- [ ] **Step 3: Verify TOML parsing works**

Run: `npx tsx -e "const { loadApexConfig } = require('./packages/agents/src/apex/config'); console.log(JSON.stringify(loadApexConfig(), null, 2))"`

Expected: Config object with all sections populated from apex.toml.

- [ ] **Step 4: Commit**

```bash
git add packages/agents/src/apex/config.ts apex.toml
git commit -m "feat(apex): add config loader and apex.toml"
```

---

### Task 2: Signal Aggregator — Read all 7 instances from Redis

**Files:**
- Create: `packages/agents/src/apex/signal-aggregator.ts`

This is the core data ingestion layer. It reads Redis keys from all 7 instances and normalizes them to a common signal format.

- [ ] **Step 1: Define the normalized signal type and write the aggregator**

```typescript
import Redis from 'ioredis';

export type SignalDirection = 'bullish' | 'bearish';

export interface NormalizedSignal {
    symbol: string;           // Normalized base symbol: 'BTC', 'ETH', 'SOL', etc.
    direction: SignalDirection;
    source: string;           // 'cryonix' | 'copynix' | 'psinix' | 'polymarket' | 'aktienix' | 'solanix' | 'vedic' | 'cmc'
    signalType: string;       // e.g. 'DEEP_VALUE_CRASH', 'whale_buy', 'venus_rx', 'extreme_fear'
    confidence: number;       // 0-100
    score: number;            // 0-100 (for whale score, sentiment, etc.)
    timestamp: number;        // Unix ms
    raw?: unknown;            // Original data for debugging
}

export interface AggregatorSnapshot {
    signals: NormalizedSignal[];
    staleness: Record<string, boolean>;  // source → is_stale
    timestamp: number;
}
```

The aggregator class `SignalAggregator` should:
- Take a Redis instance in constructor
- Have an `async snapshot(): Promise<AggregatorSnapshot>` method
- Read all Redis keys in a single `pipeline()` call (not individual gets)
- Parse each source's data format and extract signals
- Apply staleness check: if `updated_at` > 5min old (or 24h for vedic:planets), mark as stale and zero signals from that source
- Normalize symbols: strip `/USDC` suffix for Cryonix/Ψnix pairs, use symbol field for others

**Redis keys to read (batch):**
```
trades:pending           → Cryonix pending signals (JSON array)
copynix:signals          → Copynix whale events (NEW, see Task 7)
psinix:positions         → Ψnix positions with coherence data
psinix:status            → Ψnix status with regime
polymarket:crypto        → Polymarket crypto sentiment (0-100)
polymarket:summary       → Polymarket overall summary
aktienix:signals         → Aktienix signal data
solanix:status           → Solanix status
vedic:planets            → Vedic planetary data (retrograde flags)
cmc:fear_greed           → CMC Fear & Greed index
cmc:global               → CMC global metrics (BTC dominance)
```

**Key parsing logic per source:**

- **Cryonix** (`trades:pending`): Each entry has `{ patterns: ['DIP_BUY', ...], symbol: 'BTC/USDC', confidence: 75 }`. Extract pattern names, map to bullish signals. Symbol normalize: `'BTC/USDC'.split('/')[0]`.
- **Copynix** (`copynix:signals`): Array of `{ token, symbol, score, direction, timestamp }`. Filter score ≥ 80 for whale signals. Direction is always 'bullish' for buys.
- **Ψnix** (`psinix:status`): Contains `{ regime, coherence }`. If coherence ≥ 0.7, emit signal. Direction from regime field ('bullish'|'bearish'|'ranging').
- **Polymarket** (`polymarket:crypto`): `{ sentiment: 65, delta: +22 }`. If delta ≥ +20 → bullish signal. If delta ≤ -15 → bearish signal.
- **Vedic** (`vedic:planets`): Object with planet data. Check `Venus.is_retrograde === true` → emit bearish Venus Rx signal.
- **CMC** (`cmc:fear_greed`): Numeric value 0-100. If ≤ 25 → bullish (contrarian). If dropping (compare with stored previous) → bearish.
- **CMC** (`cmc:global`): Contains `btc_dominance`. If falling vs previous → bullish (altcoin rotation). If rising → bearish.
- **Aktienix** (`aktienix:signals`): Contains signal array. Look for crypto-correlated tickers rising → bullish.
- **Solanix** (`solanix:status`): Check for volume spike / trending tokens.

- [ ] **Step 2: Commit**

```bash
git add packages/agents/src/apex/signal-aggregator.ts
git commit -m "feat(apex): add signal aggregator — reads all 7 instances from Redis"
```

---

### Task 3: Confluence Scorer — Direction-aware scoring

**Files:**
- Create: `packages/agents/src/apex/confluence-scorer.ts`

- [ ] **Step 1: Implement the confluence scorer**

The scorer takes an `AggregatorSnapshot` and the config weights/thresholds, then computes a score per symbol per direction.

```typescript
import type { NormalizedSignal, AggregatorSnapshot } from './signal-aggregator';
import type { ApexTomlConfig } from './config';

export interface ScoredOpportunity {
    symbol: string;
    direction: 'bullish' | 'bearish';
    score: number;
    mode: 'venus_rx' | 'dip_sniper' | 'confluence';
    contributingSignals: NormalizedSignal[];
    timestamp: number;
}
```

Logic:
1. Group signals by normalized symbol
2. For each symbol, compute bullish score and bearish score separately using the weight tables from spec
3. Apply threshold conditions (e.g., only add Cryonix DIP_BUY points if confidence ≥ `thresholds.cryonix_min_confidence`)
4. Determine mode: if Venus Rx active and bearish score ≥ threshold → `venus_rx`. If Cryonix dip pattern present → `dip_sniper`. Otherwise → `confluence`.
5. Only include signals within the confluence window (default 300s / 5min)
6. Return sorted list of `ScoredOpportunity` with score ≥ `min_score_half_kelly`

The weight mapping from signal type to points:
```typescript
const BULLISH_WEIGHTS: Record<string, { weight: string; minField?: string; minValue?: number }> = {
    'DEEP_VALUE_CRASH': { weight: 'cryonix_deep_value', minField: 'confidence', minValue: 75 },
    'DIP_BUY':          { weight: 'cryonix_dip_buy', minField: 'confidence', minValue: 70 },
    'whale_buy':        { weight: 'copynix_single_whale', minField: 'score', minValue: 80 },
    'polymarket_rising': { weight: 'polymarket_sentiment_shift' },
    'extreme_fear':     { weight: 'cmc_extreme_fear' },
    'psinix_bullish':   { weight: 'psinix_coherence' },
    'volume_spike':     { weight: 'solanix_volume_spike' },
    'macro_bullish':    { weight: 'aktienix_macro_bullish' },
    'btc_dom_falling':  { weight: 'cmc_btc_dom_falling' },
};
// Similar for BEARISH_WEIGHTS
```

- [ ] **Step 2: Commit**

```bash
git add packages/agents/src/apex/confluence-scorer.ts
git commit -m "feat(apex): add confluence scorer — direction-aware multi-source scoring"
```

---

### Task 4: Risk Gate — Kelly sizing + circuit breakers

**Files:**
- Create: `packages/agents/src/apex/risk-gate.ts`

- [ ] **Step 1: Implement the risk gate**

The risk gate manages:
1. **Kelly position sizing** — given a mode's WR and avg win/loss, compute quarter-Kelly fraction
2. **Circuit breakers** — track drawdown, daily loss, consecutive losses
3. **Position counting** — enforce max concurrent positions
4. **Capital allocation** — track deployed vs available vs reserve

```typescript
export interface RiskState {
    peakCapital: number;
    currentCapital: number;
    deployedCapital: number;
    dailyPnl: number;
    dailyPnlResetAt: number;    // Unix ms — midnight UTC
    consecutiveLosses: number;
    reducedSizingTradesLeft: number;
    openPositionCount: number;
    isPaused: boolean;
    pausedUntil: number;        // Unix ms
}

export class RiskGate {
    constructor(private config: ApexTomlConfig['risk'], private state: RiskState) {}

    canTrade(): { allowed: boolean; reason?: string } { ... }

    computeSize(mode: 'venus_rx' | 'dip_sniper' | 'confluence', score: number): number { ... }

    recordEntry(amount: number): void { ... }
    recordExit(pnl: number): void { ... }
}
```

Key logic:
- `canTrade()`: Check drawdown < max (10%), daily loss < limit (5%), positions < max (3), not paused
- `computeSize()`: Look up mode sizing_pct from config, halve if score < `min_score_full_kelly`, apply loss reduction if `reducedSizingTradesLeft > 0`
- `recordExit()`: Update consecutive losses counter, trigger pause if drawdown exceeded, reset daily PnL at midnight

State is persisted to Redis `apex:risk` on every change.

- [ ] **Step 2: Commit**

```bash
git add packages/agents/src/apex/risk-gate.ts
git commit -m "feat(apex): add risk gate — Kelly sizing and circuit breakers"
```

---

### Task 5: Exit Monitor — TP/SL/trailing per mode

**Files:**
- Create: `packages/agents/src/apex/exit-monitor.ts`

- [ ] **Step 1: Implement the exit monitor**

Follow the pattern from `packages/agents/src/solanix/solanix-agent.ts` exit logic but with per-mode parameters.

```typescript
export interface ApexPosition {
    id: string;
    symbol: string;
    direction: 'long' | 'short';
    mode: 'venus_rx' | 'dip_sniper' | 'confluence';
    entryPrice: number;
    currentPrice: number;
    quantity: number;
    entryTime: number;          // Unix ms
    highWatermark: number;
    trailingActive: boolean;
    confluenceScore: number;
    contributingSignals: string[];  // source names
}

export interface ExitDecision {
    shouldExit: boolean;
    reason: 'tp' | 'sl' | 'trailing' | 'max_hold' | null;
    pnlPct: number;
}
```

Logic:
1. Look up TP/SL/trailing params from the position's mode config
2. For long positions: `pnlPct = (currentPrice - entryPrice) / entryPrice * 100`
3. For short positions: `pnlPct = (entryPrice - currentPrice) / entryPrice * 100`
4. Check TP: `pnlPct >= tp_pct`
5. Check SL: `pnlPct <= -sl_pct`
6. Trailing: if `pnlPct >= trailing_activation_pct`, set `trailingActive = true`. Then if price drops `trailing_pct` from high watermark → exit
7. Max hold: if `Date.now() - entryTime > max_hold_hours * 3600000` → exit

- [ ] **Step 2: Commit**

```bash
git add packages/agents/src/apex/exit-monitor.ts
git commit -m "feat(apex): add exit monitor — TP/SL/trailing/max-hold per mode"
```

---

### Task 6: APEX Agent — Main orchestrator

**Files:**
- Create: `packages/agents/src/apex/apex-agent.ts`

This is the main agent class. Follow the pattern from `solanix-agent.ts`:
- Extends no base class (Solanix/Copynix don't extend BaseAgent in practice — they have `initialize()`, `start()`, `stop()` methods)
- Constructor takes agent metadata
- `initialize()`: connect Redis, load config, restore state
- `start()`: blocking while loop with `scan_interval_seconds` delay
- `stop()`: set running flag to false

- [ ] **Step 1: Implement the APEX agent**

```typescript
import Redis from 'ioredis';
import { loadApexConfig, type ApexTomlConfig } from './config';
import { SignalAggregator } from './signal-aggregator';
import { ConfluenceScorer, type ScoredOpportunity } from './confluence-scorer';
import { RiskGate, type RiskState } from './risk-gate';
import { ExitMonitor, type ApexPosition } from './exit-monitor';

export class ApexAgent {
    private redis!: Redis;
    private config!: ApexTomlConfig;
    private aggregator!: SignalAggregator;
    private scorer!: ConfluenceScorer;
    private riskGate!: RiskGate;
    private exitMonitor!: ExitMonitor;
    private positions: ApexPosition[] = [];
    private running = false;

    constructor(private meta: { id: string; name: string }) {}

    async initialize(): Promise<void> {
        this.config = loadApexConfig();
        this.redis = new Redis(process.env.KV_URL || 'redis://localhost:6379');
        this.aggregator = new SignalAggregator(this.redis);
        this.scorer = new ConfluenceScorer(this.config);
        // Restore risk state from Redis
        const riskRaw = await this.redis.get('apex:risk');
        const riskState: RiskState = riskRaw ? JSON.parse(riskRaw) : { /* defaults */ };
        this.riskGate = new RiskGate(this.config.risk, riskState);
        this.exitMonitor = new ExitMonitor(this.config);
        // Restore positions from Redis
        const posRaw = await this.redis.get('apex:positions');
        this.positions = posRaw ? JSON.parse(posRaw) : [];
    }

    async start(): Promise<void> {
        this.running = true;
        const intervalMs = this.config.general.scan_interval_seconds * 1000;
        while (this.running) {
            try { await this.tick(); }
            catch (err) { console.error('[APEX] tick error:', err); }
            await this.sleep(intervalMs);
        }
    }

    async stop(): Promise<void> {
        this.running = false;
        await this.redis?.quit();
    }

    private async tick(): Promise<void> {
        // 1. Monitor existing positions (exits)
        await this.monitorPositions();
        // 2. Read all signals
        const snapshot = await this.aggregator.snapshot();
        // 3. Score opportunities
        const opportunities = this.scorer.score(snapshot);
        // 4. Execute top opportunities
        for (const opp of opportunities) {
            await this.evaluateAndExecute(opp);
        }
        // 5. Publish state
        await this.publishState(snapshot);
    }
}
```

Key implementation details:
- `monitorPositions()`: For each open position, fetch current price (from Redis `trades:pending` data or CCXT ticker), run ExitMonitor, execute exit if needed, call `riskGate.recordExit(pnl)`
- `evaluateAndExecute()`: Check `riskGate.canTrade()`, compute size via `riskGate.computeSize()`, call Grok AI validation (reuse pattern from auto-trade route — POST to xAI API), execute paper trade (log entry, update positions array, persist to Redis)
- `publishState()`: Write `apex:state` to Redis with status, positions, confluence board, performance, circuit breaker state. This is what the API route and Overview page will read.
- Paper trading: For spot BUY, record entry price from CCXT ticker. For simulated SHORT, record entry price and compute P&L as inverse. No actual exchange orders in paper mode.
- Grok validation: Use the same OpenAI-compatible API pattern as other agents — `new OpenAI({ apiKey: process.env.XAI_API_KEY, baseURL: 'https://api.x.ai/v1' })`. Fail-closed: if Grok call fails or rejects, skip the trade.
- Telegram alerts: POST to `https://api.telegram.org/bot${token}/sendMessage` with formatted message on entry/exit/circuit breaker events.

- [ ] **Step 2: Commit**

```bash
git add packages/agents/src/apex/apex-agent.ts
git commit -m "feat(apex): add main agent — scan loop, confluence execution, paper trading"
```

---

### Task 7: Copynix Signal Publisher — Add `copynix:signals` Redis key

**Files:**
- Modify: `packages/agents/src/copynix/copynix-agent.ts`

- [ ] **Step 1: Add signal publishing to Copynix**

The spec requires APEX to read whale buy events from `copynix:signals`. Currently, Copynix consensus logic stays in-memory. We need to publish a rolling window of recent whale buy events.

Find the location in `copynix-agent.ts` where a trade decision is made (likely in the consensus evaluation or after a whale buy is detected). After the trade decision, add:

```typescript
// Publish to copynix:signals for APEX consumption
const signalEvent = {
    token: trade.token,
    symbol: trade.symbol,
    score: trade.walletScore,
    direction: 'buy',
    timestamp: Date.now(),
};

// Read existing signals, add new, keep only last 5min window
const existing = await this.redis.get('copynix:signals');
const signals = existing ? JSON.parse(existing) : [];
const fiveMinAgo = Date.now() - 300_000;
signals.push(signalEvent);
const filtered = signals.filter((s: any) => s.timestamp > fiveMinAgo);
await this.redis.set('copynix:signals', JSON.stringify(filtered), 'EX', 600);
```

This is a minimal change — just publish what's already computed. TTL of 10 minutes ensures stale data is cleaned up.

- [ ] **Step 2: Commit**

```bash
git add packages/agents/src/copynix/copynix-agent.ts
git commit -m "feat(copynix): publish whale buy events to copynix:signals for APEX"
```

---

### Task 8: Runner + Dockerfile + Docker Compose

**Files:**
- Create: `scripts/services/apex-runner.ts`
- Create: `Dockerfile.apex`
- Modify: `docker-compose.prod.yml`

- [ ] **Step 1: Create `scripts/services/apex-runner.ts`**

Follow the exact pattern from `scripts/services/solanix-runner.ts`:

```typescript
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { ApexAgent } from '../../packages/agents/src/apex/apex-agent';
import { loadApexConfig } from '../../packages/agents/src/apex/config';

async function main() {
    console.log('===========================================');
    console.log('  APEX — Adaptive Profit EXtraction');
    console.log('  Meta-Intelligence Confluence Trader');
    console.log('===========================================\n');

    const config = loadApexConfig();
    console.log(`[APEX] Mode: ${config.general.mode}`);
    console.log(`[APEX] Capital: $${config.general.capital} ${config.general.currency}`);
    console.log(`[APEX] Scan interval: ${config.general.scan_interval_seconds}s`);
    console.log(`[APEX] Confluence thresholds: full=${config.confluence.min_score_full_kelly}, half=${config.confluence.min_score_half_kelly}`);
    console.log(`[APEX] Max positions: ${config.risk.max_concurrent_positions}`);
    console.log();

    const agent = new ApexAgent({
        id: 'apex',
        name: 'APEX',
    });

    const shutdown = async (signal: string) => {
        console.log(`\n[${signal}] Shutting down APEX...`);
        await agent.stop();
        process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    await agent.initialize();
    await agent.start();
}

main().catch((err) => {
    console.error('[APEX] Fatal error:', err);
    process.exit(1);
});
```

- [ ] **Step 2: Create `Dockerfile.apex`**

Based on `Dockerfile.solanix`:

```dockerfile
# Dockerfile.apex — APEX Meta-Intelligence Confluence Trader
FROM node:20-alpine

WORKDIR /app

# Install runtime dependencies
RUN npm install --no-save \
    @iarna/toml@2 \
    openai@4 \
    dotenv@16 \
    ioredis@5 \
    pg@8 \
    zod@3 \
    tsx@4 \
    typescript@5 \
    ccxt@4

# Stub for @cryonix/types
RUN mkdir -p node_modules/@cryonix/types && \
    echo '{"name":"@cryonix/types","version":"1.0.0","main":"index.js"}' > node_modules/@cryonix/types/package.json && \
    echo 'module.exports = {};' > node_modules/@cryonix/types/index.js

# Copy agent source (apex + shared modules)
COPY packages/agents/src/ ./packages/agents/src/

# Copy runner
COPY scripts/services/apex-runner.ts ./scripts/services/

USER node
CMD ["npx", "tsx", "scripts/services/apex-runner.ts"]
```

Note: includes `ccxt@4` since APEX needs price data for position monitoring.

- [ ] **Step 3: Add `apex` service to `docker-compose.prod.yml`**

Add after the psinix service block. Follow the solanix pattern:

```yaml
  apex:
    build:
      context: .
      dockerfile: Dockerfile.apex
    container_name: apex
    restart: unless-stopped
    volumes:
      - ./apex.toml:/app/apex.toml:ro
    environment:
      - NODE_ENV=production
      - KV_URL=redis://redis:6379
      - BINANCE_API_KEY=${BINANCE_API_KEY:-}
      - BINANCE_API_SECRET=${BINANCE_API_SECRET:-}
      - XAI_API_KEY=${XAI_API_KEY:-}
      - TELEGRAM_INTERACTIVE_BOT_TOKEN=${TELEGRAM_INTERACTIVE_BOT_TOKEN:-}
      - TELEGRAM_CHAT_ID=${TELEGRAM_CHAT_ID:-}
      - POSTGRES_URL=postgres://postgres:${POSTGRES_PASSWORD:-password}@postgres:5432/cryonix
    depends_on:
      - redis
      - postgres
    networks:
      - cryonix
```

- [ ] **Step 4: Commit**

```bash
git add scripts/services/apex-runner.ts Dockerfile.apex docker-compose.prod.yml
git commit -m "feat(apex): add runner, Dockerfile, and Docker Compose service"
```

---

### Task 9: API Route — `/api/apex/status`

**Files:**
- Create: `apps/web/src/app/api/apex/status/route.ts`

- [ ] **Step 1: Create the status API route**

Follow pattern from `apps/web/src/app/api/solanix/status/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const [stateRaw, riskRaw, positionsRaw] = await Promise.all([
            redis.get('apex:state'),
            redis.get('apex:risk'),
            redis.get('apex:positions'),
        ]);

        const state = stateRaw ? JSON.parse(stateRaw as string) : null;
        const risk = riskRaw ? JSON.parse(riskRaw as string) : null;
        const positions = positionsRaw ? JSON.parse(positionsRaw as string) : [];

        return NextResponse.json({
            status: state?.status ?? 'offline',
            activeMode: state?.activeMode ?? 'idle',
            capital: state?.capital ?? null,
            positions,
            confluenceBoard: state?.confluenceBoard ?? [],
            performance: state?.performance ?? { totalPnl: 0, winRate: 0, trades: 0, maxDrawdown: 0 },
            circuitBreaker: risk ?? { drawdown: 0, dailyLoss: 0, consecutiveLosses: 0 },
            timestamp: new Date().toISOString(),
        });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/api/apex/status/route.ts
git commit -m "feat(apex): add /api/apex/status API route"
```

---

### Task 10: Dashboard — React hook + page + navigation

**Files:**
- Create: `apps/web/src/hooks/useApex.ts`
- Create: `apps/web/src/app/apex/page.tsx`
- Modify: `apps/web/src/components/dashboard/dashboard-layout.tsx`
- Modify: `apps/web/src/components/command-palette.tsx`

- [ ] **Step 1: Create `apps/web/src/hooks/useApex.ts`**

Follow the pattern from existing hooks (e.g., `useSolanix`). Simple SWR/polling hook:

```typescript
'use client';
import { useState, useEffect } from 'react';

export interface ApexStatus {
    status: string;
    activeMode: string;
    capital: { total: number; deployed: number; available: number; reserve: number } | null;
    positions: Array<{
        id: string; symbol: string; direction: string; mode: string;
        entryPrice: number; currentPrice: number; quantity: number;
        entryTime: number; highWatermark: number; trailingActive: boolean;
        confluenceScore: number; contributingSignals: string[];
    }>;
    confluenceBoard: Array<{ symbol: string; score: number; signals: string[] }>;
    performance: { totalPnl: number; winRate: number; trades: number; maxDrawdown: number };
    circuitBreaker: { drawdown: number; dailyLoss: number; consecutiveLosses: number };
}

export function useApexStatus(refreshMs = 15_000) {
    const [data, setData] = useState<ApexStatus | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let active = true;
        const fetch_ = async () => {
            try {
                const res = await fetch('/api/apex/status');
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const json = await res.json();
                if (active) { setData(json); setError(null); }
            } catch (e) { if (active) setError(String(e)); }
        };
        fetch_();
        const id = setInterval(fetch_, refreshMs);
        return () => { active = false; clearInterval(id); };
    }, [refreshMs]);

    return { data, error };
}
```

- [ ] **Step 2: Create `apps/web/src/app/apex/page.tsx`**

Dashboard page showing:
1. Mode status card (active mode, capital summary)
2. Confluence board table (symbols × scores, highlighted above threshold)
3. Open positions table
4. Performance summary
5. Circuit breaker status

Use `DashboardLayout` wrapper. Use Tailwind utility classes for styling. Follow the visual patterns from Solanix dashboard (cards, tables, colored badges).

The page should be `'use client'` and use `useApexStatus()` hook for data.

Key sections:
- Top row: 4 stat cards (Capital, Deployed, Win Rate, Active Mode)
- Middle: Confluence Board — table with Symbol, Score (colored bar), Contributing Signals (badges), Direction
- Bottom left: Open Positions table
- Bottom right: Circuit Breaker status + Performance summary

- [ ] **Step 3: Add APEX to `NAV_GROUPS` in `dashboard-layout.tsx`**

Add after the psinix entry (before `] as const`):

```typescript
  {
    id: 'apex',
    label: 'APEX',
    accent: 'text-rose-400',
    dot: 'bg-rose-400',
    glow: 'shadow-[0_0_8px_rgba(251,113,133,0.5)]',
    items: [
      { href: '/apex', label: 'Apex', icon: Zap, desc: 'Meta-intelligence trader' },
    ],
  },
```

Import `Zap` from lucide-react at the top of the file.

- [ ] **Step 4: Add APEX to command palette**

In `apps/web/src/components/command-palette.tsx`, add an entry for APEX navigation.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/hooks/useApex.ts apps/web/src/app/apex/page.tsx apps/web/src/components/dashboard/dashboard-layout.tsx apps/web/src/components/command-palette.tsx
git commit -m "feat(apex): add dashboard page, hook, and navigation"
```

---

### Task 11: Overview Integration

**Files:**
- Modify: `apps/web/src/app/api/overview/route.ts`

- [ ] **Step 1: Add APEX to the overview aggregation**

In `apps/web/src/app/api/overview/route.ts`, add APEX as the 8th instance. Follow the existing pattern:

```typescript
// Add to the instances array
const apexRes = await safeFetch('/api/apex/status');
// Map to overview format:
{
    id: 'apex',
    name: 'APEX',
    status: apexRes?.status === 'running' ? 'online' : 'offline',
    portfolioValue: apexRes?.capital?.total ?? 0,
    dailyPnl: apexRes?.performance?.totalPnl ?? 0,
    winRate: apexRes?.performance?.winRate ?? 0,
    openPositions: apexRes?.positions?.length ?? 0,
    totalTrades: apexRes?.performance?.trades ?? 0,
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/app/api/overview/route.ts
git commit -m "feat(overview): add APEX to overview dashboard aggregation"
```

---

### Task 12: Build, Deploy, Verify

- [ ] **Step 1: Build locally**

Run: `pnpm build`
Expected: Clean build, no type errors.

If there are type errors, fix them before proceeding.

- [ ] **Step 2: Test the Docker image locally**

Run: `docker build -f Dockerfile.apex -t apex-test .`
Expected: Image builds successfully.

- [ ] **Step 3: Deploy to VM**

```bash
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build apex web"
```

- [ ] **Step 4: Verify APEX container is running**

Run: `ssh azureuser@openclaw-vm "docker logs apex --tail 30"`
Expected: APEX startup banner, config summary, scan loop starting.

- [ ] **Step 5: Verify API endpoint**

Run: `curl http://openclaw-vm/api/apex/status | jq .`
Expected: JSON with status, activeMode, capital, empty positions, confluenceBoard.

- [ ] **Step 6: Verify dashboard page**

Open `http://openclaw-vm/apex` in browser or test with Playwright.
Expected: Dashboard loads with APEX data, no React errors.

- [ ] **Step 7: Verify overview includes APEX**

Run: `curl http://openclaw-vm/api/overview | jq '.instances[] | select(.id == "apex")'`
Expected: APEX instance with status and capital data.

- [ ] **Step 8: Final commit if any fixes were needed**

```bash
git add -A && git commit -m "fix(apex): deployment fixes"
```

---

## Review Notes (must apply during implementation)

These corrections from spec review must be applied when implementing the tasks above:

### Critical: TOML Config Interface (Task 1)
The `ApexTomlConfig` interface in the plan uses flat dot-notation keys (`'confluence.weights'`). This is WRONG. `@iarna/toml` parses `[confluence.weights]` as nested objects. Use properly nested interface:
```typescript
confluence: { min_score_full_kelly: number; min_score_half_kelly: number; weights: { ... }; thresholds: { ... } }
modes: { venus_rx: { ... }; dip_sniper: { ... }; confluence: { ... } }
```
Deep-merge must handle 3 levels: `{ ...DEFAULTS.confluence, ...parsed.confluence, weights: { ...DEFAULTS.confluence.weights, ...parsed.confluence?.weights } }`. Add missing fields: `general.description`, `modes.venus_rx.leverage`, `modes.venus_rx.max_leverage`.

### Critical: aktienix:signals is a Redis LIST (Task 2)
Aktienix publishes signals via `LPUSH`/`LTRIM` (it's a Redis LIST, not a string). Use `LRANGE aktienix:signals 0 -1` in the pipeline, not `GET`. A `GET` on a LIST key returns a Redis type error.

### Important: Copynix signal insertion point (Task 7)
Insert the `copynix:signals` publisher inside the `executeSignal()` method (around line 473 of `copynix-agent.ts`), after consensus level is determined.

### Important: Overview route pattern (Task 11)
Use `safeFetch(\`${BASE_URL}/api/apex/status\`)` (with BASE_URL prefix) and create a proper `fetchApex()` function that maps to the `InstanceData` interface. Check `apps/web/src/app/api/overview/route.ts` for the exact pattern used by other instances.

### Important: Bearish weights must be defined explicitly (Task 3)
```typescript
const BEARISH_WEIGHTS = {
    'venus_rx':              { weight: 'vedic_venus_rx' },
    'RSI_OVERBOUGHT':        { weight: 'cryonix_rsi_overbought', minField: 'confidence', minValue: 70 },
    'MACD_BEARISH_CROSS':    { weight: 'cryonix_macd_bearish', minField: 'confidence', minValue: 65 },
    'polymarket_falling':    { weight: 'polymarket_sentiment_falling' },
    'fear_greed_dropping':   { weight: 'cmc_fear_greed_dropping' },
    'psinix_bearish':        { weight: 'psinix_coherence' },
    'btc_dom_rising':        { weight: 'cmc_btc_dom_rising' },
};
```

### Important: Verify vedic:planets structure
Before coding the Vedic parser in signal-aggregator.ts, inspect the actual Redis data: `docker exec cryonix-redis-1 redis-cli GET vedic:planets`. The field path for Venus retrograde status may differ from what the spec assumes.

### Nice to have: Dashboard Trade History
The spec describes a Trade History component (closed trades log) that is not explicitly included in the dashboard task. Add it as a 6th section if time permits.
