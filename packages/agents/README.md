# @cryonix/agents

TypeScript agent system for the Cryonix trading platform. Provides a `BaseAgent` abstract class and specialized agents for market scanning, risk management, signal validation, backtesting, and trade execution.

## Files / Structure

```
src/
  base-agent.ts              # Abstract BaseAgent class (lifecycle, messaging, logging)
  index.ts                   # Re-exports + AgentFactory
  orchestrator/
    orchestrator-agent.ts    # Coordinates agent lifecycle
    mock-risk-manager.ts     # Stub risk manager for testing
  market-scout/
    market-scout-agent.ts    # TS-side market scanner (legacy; replaced by Python MarketScoutTank)
    pattern-detectors/       # Pattern detection modules
  risk-manager/
    risk-manager-agent.ts    # Portfolio risk checks, position sizing, circuit breaker
    kelly-criterion.ts       # Kelly Criterion capital sizing functions
    dynamic-stops.ts         # ATR-based and trailing stop logic
    __tests__/               # kelly-criterion.test.ts, risk-manager-agent.test.ts
  signal-validator/
    signal-validator.ts      # Multi-source signal validation engine
    signal-validator-agent.ts # Agent wrapper for the validator
    consensus-engine.ts      # Aggregates votes from multiple validation sources
    technical-indicators.ts  # RSI, MACD, Bollinger, volume analysis
    validators/              # Individual validator implementations
    __tests__/               # signal-validator.test.ts, technical-indicators.test.ts
  backtester/
    backtester-agent.ts      # Agent wrapper for backtesting
    backtester-engine.ts     # Core simulation engine (walk-forward, equity curves)
    performance-metrics.ts   # Sharpe, Sortino, drawdown, profit factor, etc.
    monte-carlo.ts           # Monte Carlo simulation for confidence intervals
    types.ts                 # Backtest-specific type definitions
    __tests__/               # backtester-engine.test.ts, performance-metrics.test.ts
  executor/
    executor-agent.ts        # CCXT order execution against Binance
    order-manager.ts         # Order state machine (place, fill, cancel)
    position-tracker.ts      # Open position monitoring (SL/TP/trailing)
    execution-reporter.ts    # Trade reporting and logging
    __tests__/               # executor-agent.test.ts
  claude-assistant/
    claude-assistant-agent.ts # GROK/xAI chat integration for AI validation
  analytics/
    roi-tracker.ts           # ROI calculation utilities
  utils/
    logger.ts                # Structured logger with agent context
  __tests__/
    base-agent.test.ts       # BaseAgent unit tests
    utils/
      mock-data.ts           # Shared test fixtures (signals, candles, portfolios)
      mock-exchange.ts       # Fake CCXT exchange for deterministic testing
```

## Key APIs / Exports

### Agent Classes

| Class | Description |
|---|---|
| `BaseAgent` | Abstract base with `initialize()`, `start()`, `stop()`, `handleMessage()` |
| `OrchestratorAgent` | Coordinates all agent lifecycles |
| `MarketScoutAgent` | TS-side market scanner (legacy) |
| `RiskManagerAgent` | Portfolio risk checks, Kelly sizing, circuit breaker |
| `SignalValidator` | Multi-source signal validation with consensus scoring |
| `BacktesterAgent` | Historical strategy backtesting with walk-forward validation |
| `ExecutorAgent` | CCXT order execution and position tracking |
| `ClaudeAssistantAgent` | AI chat integration via GROK/xAI |

### AgentFactory

```typescript
import { AgentFactory } from '@cryonix/agents';

const risk = AgentFactory.createRiskManager(config);
const backtester = AgentFactory.createBacktester();
const executor = AgentFactory.createExecutor(config);
```

### Kelly Criterion

```typescript
import {
  calculateKellyFraction,
  calculateHalfKelly,
  calculateRiskRewardRatio,
  calculatePositionSize,
  calculatePositionUnits,
} from '@cryonix/agents';

const rr = calculateRiskRewardRatio(entryPrice, stopLoss, target);
const kelly = calculateHalfKelly(0.65, rr); // Half-Kelly (recommended)
const usd = calculatePositionSize({ portfolioValue, kellyFraction: kelly, maxRiskPercent: 0.02, maxPositionPercent: 0.30 });
```

### Signal Validator

```typescript
import { SignalValidator, calculateTechnicalIndicators } from '@cryonix/agents';
```

### Backtester

```typescript
import { BacktesterEngine, calculatePerformanceMetrics } from '@cryonix/agents';
```

## Usage

This package is consumed by `apps/web` (Next.js API routes) and background workers. It is not run standalone.

```typescript
import { RiskManagerAgent, SignalValidator, BacktesterAgent } from '@cryonix/agents';
```

## Testing

Tests use Vitest with mock exchange data and deterministic fixtures.

```bash
# From the monorepo root
pnpm --filter @cryonix/agents type-check

# Run agent tests (via root vitest config)
pnpm test -- packages/agents
```

Test files:
- `src/__tests__/base-agent.test.ts` -- BaseAgent lifecycle
- `src/risk-manager/__tests__/kelly-criterion.test.ts` -- Kelly math
- `src/risk-manager/__tests__/risk-manager-agent.test.ts` -- Full risk check flow
- `src/backtester/__tests__/backtester-engine.test.ts` -- Simulation engine
- `src/backtester/__tests__/performance-metrics.test.ts` -- Metric calculations
- `src/signal-validator/__tests__/signal-validator.test.ts` -- Validation pipeline
- `src/signal-validator/__tests__/technical-indicators.test.ts` -- Indicator math
- `src/executor/__tests__/executor-agent.test.ts` -- Order execution

Shared test utilities in `src/__tests__/utils/`:
- `mock-data.ts` -- Predefined signals, candle arrays, portfolio states
- `mock-exchange.ts` -- Fake CCXT exchange that returns deterministic responses

## Dependencies

| Package | Purpose |
|---|---|
| `@cryonix/types` | Shared TypeScript types and Zod schemas |
| `@cryonix/database` | Drizzle ORM for persisting risk checks, backtest results |
| `ccxt` | Cryptocurrency exchange connectivity (Binance) |
| `openai` | OpenAI-compatible API client (used for GROK/xAI) |
| `technicalindicators` | RSI, MACD, Bollinger Bands calculations |
| `zod` | Runtime schema validation |
| `ws` | WebSocket client for real-time data |
