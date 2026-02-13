# Testing Guide for Cryonix Agents

## Overview

This project uses **Vitest** for unit and integration testing. We aim for high reliability in our trading logic through comprehensive testing of all agent modules.

## Prerequisites

- Node.js & pnpm installed
- `npm install` packages installed

## Running Tests

### Run All Tests
```bash
pnpm test
```

### Run Specific Test Suite
```bash
pnpm test backtester
pnpm test risk-manager
pnpm test executor
```

### Watch Mode
```bash
pnpm test:watch
```

### Generate Coverage
```bash
pnpm test:coverage
```

## Project Structure

Test files are located in `__tests__` directories within each module:

```
packages/agents/src/
├── backtester/
│   └── __tests__/
│       ├── backtester-engine.test.ts
│       └── performance-metrics.test.ts
├── signal-validator/
│   └── __tests__/
│       ├── technical-indicators.test.ts
│       └── signal-validator.test.ts
├── risk-manager/
│   └── __tests__/
│       ├── kelly-criterion.test.ts
│       └── risk-manager-agent.test.ts
└── executor/
    └── __tests__/
        └── executor-agent.test.ts
```

API Integration tests are in `apps/web/src/app/api/__tests__/`.

## Mocking Utilities

We provide centralized mock data generators in `packages/agents/src/__tests__/utils/`.

### `mock-data.ts`
Generates realistic market data for testing:
- `generateMockOHLCV()`: Create candle data
- `createMockSignal()`: Create trading signals
- `createMockBacktestConfig()`: Create config objects

### `mock-exchange.ts`
Simulates CCXT exchange interactions for the Executor Agent:
- In-memory order book
- Balance tracking
- Latency simulation
- Support for `fetchTicker`, `createOrder`, `fetchOrder`, `fetchBalance`

## Writing New Tests

1.  **Isolate Logic**: Use mocks for external dependencies (Database, Exchange API).
2.  **Use Mock Utilities**: Don't hardcode large JSON objects; use the generators.
3.  **Test Edge Cases**: Always test boundary conditions (zero values, negative numbers, empty arrays).
4.  **Async/Await**: Ensure all async operations are properly awaited.

### Example Pattern

```typescript
import { describe, it, expect, vi } from 'vitest';
import { MyAgent } from '../my-agent';

vi.mock('../dependency', () => ({
  someFunction: vi.fn()
}));

describe('MyAgent', () => {
  it('should perform action', async () => {
    const agent = new MyAgent();
    const result = await agent.run();
    expect(result).toBeDefined();
  });
});
```

## Coverage Targets

- **Core Logic (Backtester, Risk, Validator)**: ≥ 80%
- **Executor**: ≥ 75%
- **Integration**: Pass/Fail critical paths

## Troubleshooting

- **ReferenceError**: Ensure all types and schemas are imported correctly.
- **Mock Issues**: Use `vi.mock` factory functions for complex class mocking.
- **Timeout**: Use fake timers `vi.useFakeTimers()` for time-dependent logic.
