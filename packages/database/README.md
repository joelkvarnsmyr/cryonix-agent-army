# @cryonix/database

Drizzle ORM schema and repository layer for the Cryonix Postgres database. Defines 17 tables covering users, trading, signals, risk, backtesting, agent state, and Telegram integration.

## Files / Structure

```
drizzle.config.ts             # Drizzle Kit configuration (points to apps/web/.env.local)
src/
  schema.ts                   # All 17 table definitions + inferred TypeScript types
  index.ts                    # DB connection, schema re-export, repository re-exports
  signals.repository.ts       # CRUD for trading signals
  trades.repository.ts        # CRUD for trades
  positions.repository.ts     # CRUD for positions and position history
  backtest.repository.ts      # CRUD for backtest results
  validation.repository.ts    # CRUD for validation history
scripts/
  migrate.ts                  # Production migration runner (tsx)
```

## Schema Tables (17)

| Table | Description |
|---|---|
| `users` | User accounts with encrypted API keys |
| `portfolio` | Portfolio balances (total, cash, BTC) |
| `positions` | Open/closed positions with SL/TP |
| `trades` | Time-series trade log (BUY/SELL, PnL, pattern) |
| `signals` | Generated trading signals with confidence and metadata |
| `market_data` | OHLCV candle storage (multi-timeframe) |
| `agent_actions` | Agent action audit log |
| `ml_models` | ML model registry (name, version, accuracy) |
| `orchestrator_state` | Orchestrator runtime state snapshots |
| `risk_checks` | Risk check decisions with Kelly fraction |
| `backtest_results` | Backtest configs, metrics, equity curves |
| `validation_history` | Signal validation results (votes, consensus, timing) |
| `evolution_runs` | Autonomous evolution run logs |
| `position_history` | Closed position archive with fees and holding period |
| `telegram_signals` | Parsed signals from Telegram channels |
| `telegram_channels` | Channel quality tracking (win rate, signal count) |

All monetary fields use `decimal` with high precision (20,8). Time-series tables are indexed on `timestamp`.

## Key APIs / Exports

### Database Connection

```typescript
import { db, getDb } from '@cryonix/database';
```

The connection reads `POSTGRES_URL` from the environment (defaults to `postgres://postgres:password@localhost:5432/cryonix`).

### Schema Types

Every table exports Select and Insert types:

```typescript
import { type Signal, type NewSignal, type Trade, type NewTrade } from '@cryonix/database';
```

### Repositories

```typescript
import { createSignal, getRecentSignals } from '@cryonix/database';
import { createTrade, getTradesBySymbol } from '@cryonix/database';
import { createPosition, closePosition } from '@cryonix/database';
import { saveBacktestResult, getBacktestResults } from '@cryonix/database';
import { saveValidation, getValidationHistory } from '@cryonix/database';
```

## Usage

### Migration Commands

Run from the `packages/database` directory:

```bash
# Generate migration SQL from schema changes
pnpm db:generate

# Push schema directly to database (dev)
pnpm db:push

# Run migrations (production, via tsx)
pnpm db:migrate:prod

# Open Drizzle Studio browser UI
pnpm db:studio
```

### Connection Setup

The Drizzle config loads environment variables from `apps/web/.env.local`:

```
POSTGRES_URL=postgres://postgres:password@localhost:5432/cryonix
```

In Docker, containers use the `postgres` service name instead of `localhost`.

### Querying

```typescript
import { db } from '@cryonix/database';
import { signals } from '@cryonix/database';
import { desc, eq } from 'drizzle-orm';

const recent = await db.select().from(signals).orderBy(desc(signals.timestamp)).limit(10);
```

## Dependencies

| Package | Purpose |
|---|---|
| `@cryonix/types` | Shared TypeScript types |
| `drizzle-orm` | Type-safe ORM for Postgres |
| `postgres` | postgres.js driver |
| `@vercel/postgres` | Vercel Postgres adapter |
| `drizzle-kit` | Schema migrations and studio (dev) |
