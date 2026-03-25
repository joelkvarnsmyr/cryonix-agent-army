# @cryonix/types

Shared TypeScript type definitions and Zod runtime validation schemas for the Cryonix trading system. This package is the single source of truth for all cross-package type contracts.

## Files / Structure

```
src/
  index.ts        # All type definitions, Zod schemas, and inferred types
  risk-config.ts  # Canonical risk configuration constants (RISK_CONFIG)
```

## Key APIs / Exports

### Trading Types

| Type | Values |
|---|---|
| `OrderSide` | `'BUY'` / `'SELL'` |
| `OrderType` | `'MARKET'` / `'LIMIT'` / `'STOP_LOSS'` / `'STOP_LOSS_LIMIT'` |
| `OrderStatus` | `'PENDING'` / `'FILLED'` / `'PARTIALLY_FILLED'` / `'CANCELLED'` / `'REJECTED'` |
| `SignalAction` | `'BUY'` / `'SELL'` / `'WAIT'` |
| `PatternType` | `'bollinger_squeeze'` / `'triangle_breakout'` / `'momentum_shift'` / `'volume_spike'` / `'whale_movement'` / `'deep_value_crash'` / `'grid_buy'` / `'custom'` |

### Agent Types

| Type | Values |
|---|---|
| `AgentId` | `'orchestrator'` / `'market_scout'` / `'analyst'` / `'executor'` / `'risk_manager'` / `'reporter'` / `'learning'` / `'claude_assistant'` |
| `AgentStatus` | `'idle'` / `'running'` / `'paused'` / `'error'` |
| `MessagePriority` | `'LOW'` / `'MEDIUM'` / `'HIGH'` / `'CRITICAL'` |

### Zod Schemas

| Schema | Description |
|---|---|
| `TradingSignalSchema` | Signal with symbol, action, confidence, entry/target/SL |
| `OrderSchema` | Order with side, type, quantity, status |
| `PositionSchema` | Position with entry, current price, PnL, SL/TP |
| `AgentMessageSchema` | Inter-agent message with priority and approval flag |
| `PortfolioSchema` | Portfolio totals, PnL, daily PnL |
| `MarketDataSchema` | OHLCV candle with timeframe |
| `BacktestRequestSchema` | Backtest config (symbols, Kelly sizing, walk-forward) |
| `RiskCheckRequestSchema` | Risk check input (symbol, side, prices, confidence) |
| `ClosePositionRequestSchema` | Position close request |
| `WebSocketPayloadSchema` | WebSocket message envelope |

Each schema has a corresponding inferred type (e.g., `TradingSignal`, `Order`, `Position`).

### Interfaces

Key interfaces exported:

- `RiskApproval`, `GrokAnalysis`, `OrchestratorState` -- Orchestrator types
- `BinanceKline`, `GrokChatMessage`, `GrokResponse` -- API types
- `AgentConfig`, `RiskManagerConfig`, `ExecutorConfig` -- Agent configuration
- `WebSocketMessage`, `WSPayloadSignal`, `WSPayloadTrade`, `WSPayloadPosition` -- WebSocket payloads
- `BacktestConfig`, `BacktestResult`, `PerformanceMetrics`, `WalkForwardResult`, `MonteCarloResult` -- Backtesting
- `ValidationResult`, `ValidatorResult`, `ValidatorConfig` -- Signal validation
- `ExecuteOrderRequest`, `ExecutionResult` -- Execution
- `RiskLimits`, `RiskCheckResult`, `CircuitBreakerState`, `DynamicStopConfig` -- Risk management
- `OHLCV`, `Candle` -- Market data primitives

### Risk Configuration

```typescript
import { RISK_CONFIG, type RiskConfig } from '@cryonix/types';

RISK_CONFIG.MAX_OPEN_POSITIONS  // 3
RISK_CONFIG.MIN_CONFIDENCE      // 0.65
RISK_CONFIG.SPOT_ONLY           // true
RISK_CONFIG.SIGNAL_POOL_PCT     // 0.65
```

## Usage

Other packages import types directly:

```typescript
import type { TradingSignal, AgentId, PatternType } from '@cryonix/types';
import { TradingSignalSchema, RISK_CONFIG } from '@cryonix/types';
```

The package is referenced in `package.json` as a workspace dependency:

```json
{
  "dependencies": {
    "@cryonix/types": "workspace:*"
  }
}
```

## Testing

This package contains only type definitions and Zod schemas. Type correctness is verified via:

```bash
pnpm --filter @cryonix/types type-check
```

Zod schemas are validated at runtime by consuming packages (agents, web).

## Dependencies

| Package | Purpose |
|---|---|
| `zod` | Runtime schema validation and type inference |
