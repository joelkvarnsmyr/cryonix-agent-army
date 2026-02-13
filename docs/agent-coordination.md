# Agent Coordination Guide

This document provides prompts and context for coordinating multiple Claude Code agents working on the Cryonix trading system.

## Agent Roles

### Opus (Hauptagent) - Arkitekt & Heavy Lifting
**Completed:**
- Backtesting Engine with walk-forward testing
- Signal Validation Layer with multi-source consensus
- Enhanced Risk Management (weekly limits, circuit breakers, correlation checks)
- Executor Agent for trade execution

### Agent 1 - Frontend Specialist
Focus on UI components and visualizations.

### Agent 2 - Backend/API Specialist
Focus on API routes and database operations.

### Agent 3 - Testing & QA Specialist
Focus on tests and documentation.

---

## Agent 1: Frontend Specialist Prompt

```
You are working on the Cryonix AI Trading Dashboard frontend.

### Context
- Framework: Next.js 15 with React 19
- Styling: Tailwind CSS + shadcn/ui
- Charts: Recharts, TradingView
- State: React hooks (no Redux)
- Real-time: WebSocket updates from orchestrator

### Your Tasks

#### Phase 1: Backtesting UI
1. Create `apps/web/src/components/backtesting/BacktestForm.tsx`
   - Symbol selector (multi-select)
   - Date range picker
   - Pattern checkboxes
   - Position sizing dropdown (fixed/kelly/atr)
   - Walk-forward toggle with window config
   - Run backtest button

2. Create `apps/web/src/components/backtesting/BacktestResults.tsx`
   - Performance metrics card (Sharpe, win rate, etc.)
   - Equity curve chart (Recharts)
   - Monthly returns heatmap
   - Pattern performance table
   - Trade list with filters

3. Create `apps/web/src/app/backtest/page.tsx`
   - Combine form and results
   - Call POST /api/backtest
   - Display loading state

#### Phase 2: Signal Validation UI
1. Create `apps/web/src/components/signals/SignalValidation.tsx`
   - Source votes visualization (bars/radar)
   - Consensus level indicator
   - Bullish/bearish sentiment gauge
   - Risk level badge
   - Technical indicators snapshot

2. Update `apps/web/src/components/signals/SignalCard.tsx`
   - Add validation badge
   - Show adjusted price targets
   - Entry timing indicator

#### Phase 3: Risk Dashboard
1. Create `apps/web/src/components/risk/RiskDashboard.tsx`
   - Daily/weekly loss gauges
   - Circuit breaker status
   - Position correlation map
   - Open positions value
   - Risk limits visualization

### API Endpoints You'll Use
- GET/POST /api/backtest
- GET/POST /api/validate-signal
- GET /api/risk-check

### Existing Components to Reference
- apps/web/src/components/ (existing widgets)
- apps/web/src/app/page.tsx (dashboard layout)

### Code Style
- Use TypeScript strict mode
- Use Tailwind CSS classes
- Follow existing component patterns
- No inline styles
- Use shadcn/ui components
```

---

## Agent 2: Backend/API Specialist Prompt

```
You are working on the Cryonix backend and API layer.

### Context
- Runtime: Next.js API routes
- Database: Drizzle ORM + Vercel Postgres
- Cache: Vercel KV (Redis)
- Exchange: CCXT for Binance
- AI: xAI GROK via OpenAI SDK

### Your Tasks

#### Phase 1: Database & Storage
1. Add new tables to `packages/database/src/schema.ts`:
   - `backtestResults` - store backtest results
   - `validationHistory` - signal validation records
   - `positionHistory` - closed position tracking

2. Create repository files:
   - `packages/database/src/backtest.repository.ts`
   - `packages/database/src/validation.repository.ts`
   - `packages/database/src/positions.repository.ts`

#### Phase 2: API Routes
1. Update `apps/web/src/app/api/backtest/route.ts`
   - Add database persistence for results
   - Add GET for historical backtests
   - Add DELETE for cleanup

2. Create `apps/web/src/app/api/positions/route.ts`
   - GET: List open/closed positions
   - POST: Manual close position
   - Track position history

3. Update `apps/web/src/app/api/risk-check/route.ts`
   - Add ATR parameter support
   - Return correlation warnings
   - Persist risk check to database

#### Phase 3: WebSocket Real-time
1. Create `apps/web/src/app/api/ws/route.ts` (or WebSocket server)
   - Position updates
   - Signal alerts
   - Risk warnings
   - Circuit breaker notifications

### Database Schema Reference
```typescript
// packages/database/src/schema.ts
export const backtestResults = pgTable('backtest_results', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow(),
  config: jsonb('config').notNull(),
  metrics: jsonb('metrics').notNull(),
  trades: jsonb('trades'),
  walkForwardResults: jsonb('walk_forward_results'),
});
```

### Code Style
- Use Drizzle ORM patterns
- Validate with Zod
- Return consistent { success, data/error } format
- Log errors to console
```

---

## Agent 3: Testing & QA Specialist Prompt

```
You are responsible for testing and quality assurance.

### Context
- Test framework: Vitest
- E2E: Playwright (if needed)
- CI: GitHub Actions

### Your Tasks

#### Phase 1: Unit Tests
1. Create `packages/agents/src/backtester/__tests__/`
   - `performance-metrics.test.ts`
   - `backtester-engine.test.ts`
   - Mock OHLCV data generator

2. Create `packages/agents/src/signal-validator/__tests__/`
   - `technical-indicators.test.ts`
   - `signal-validator.test.ts`
   - Test consensus calculation

3. Create `packages/agents/src/risk-manager/__tests__/`
   - `kelly-criterion.test.ts` (existing, expand)
   - `risk-manager-agent.test.ts`
   - Circuit breaker tests
   - Correlation checks tests

4. Create `packages/agents/src/executor/__tests__/`
   - `executor-agent.test.ts`
   - Mock exchange responses

#### Phase 2: Integration Tests
1. Create `apps/web/src/app/api/__tests__/`
   - `backtest.test.ts`
   - `validate-signal.test.ts`
   - `risk-check.test.ts`

#### Phase 3: E2E Tests (Optional)
1. Full trading cycle test
   - Signal generation
   - Validation
   - Risk check
   - Execution

### Test Utilities to Create
```typescript
// packages/agents/src/__tests__/utils/mock-data.ts
export function generateMockOHLCV(days: number, symbol: string): OhlcvData[]
export function createMockSignal(overrides?: Partial<TradingSignal>): TradingSignal
export function createMockExchange(): MockExchange
```

### Code Coverage Target
- Minimum 80% for core modules
- Focus on edge cases:
  - Empty data
  - Negative values
  - Extreme volatility
  - Circuit breaker triggers

### Run Commands
```bash
pnpm test              # Run all tests
pnpm test:coverage     # With coverage
pnpm test:watch        # Watch mode
```
```

---

## Communication Protocol

### File Locking
When working on shared files, coordinate via comments:
```typescript
// AGENT_1_WORKING: Adding validation UI
// AGENT_2_WORKING: Updating schema
```

### Merge Strategy
1. Each agent works on separate directories
2. Opus reviews and merges
3. Run `pnpm type-check` before committing

### Conflict Resolution
If same file needs changes:
1. Agent with lower number has priority
2. Create interface/abstraction to decouple
3. Ask Opus for arbitration

---

## Quick Reference

### Key Files by Agent

**Agent 1 (Frontend):**
- `apps/web/src/components/`
- `apps/web/src/app/` (pages only)

**Agent 2 (Backend):**
- `apps/web/src/app/api/`
- `packages/database/src/`

**Agent 3 (Testing):**
- `**/__tests__/`
- `vitest.config.ts`

### Import Paths
```typescript
import { ... } from '@cryonix/agents';
import { ... } from '@cryonix/database';
import { ... } from '@cryonix/types';
```

### Common Commands
```bash
pnpm dev           # Start dev server
pnpm build         # Build all packages
pnpm type-check    # TypeScript check
pnpm lint          # ESLint
pnpm test          # Run tests
```

---

## New Module Summary (Created by Opus)

### 1. Backtesting Engine
Location: `packages/agents/src/backtester/`
- `types.ts` - BacktestConfig, BacktestResult, PerformanceMetrics
- `performance-metrics.ts` - Sharpe, Sortino, drawdown calculations
- `backtester-engine.ts` - Core simulation with walk-forward
- `backtester-agent.ts` - Agent wrapper with CCXT data fetching

### 2. Signal Validator
Location: `packages/agents/src/signal-validator/`
- `types.ts` - ValidationResult, SourceVote, TechnicalIndicators
- `technical-indicators.ts` - RSI, MACD, SMA, Bollinger, etc.
- `signal-validator.ts` - Multi-source consensus with accuracy tracking

### 3. Enhanced Risk Manager
Location: `packages/agents/src/risk-manager/`
- Added: weekly loss limits, circuit breakers, ATR stops, correlation checks
- Crypto correlation groups defined

### 4. Executor Agent
Location: `packages/agents/src/executor/`
- `executor-agent.ts` - Trade execution, position monitoring
- Supports market/limit orders, OCO for SL/TP

### API Routes
- `POST /api/backtest` - Run backtest with full metrics
- `POST /api/validate-signal` - Multi-source signal validation
- Enhanced `/api/risk-check` with new features
