# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Cryonix is a multi-agent AI trading system built as a Turborepo monorepo. It features autonomous trading agents that scan cryptocurrency markets, detect patterns, and provide trading signals through a Next.js dashboard.

## Monorepo Structure

```
apps/web/               # Next.js 15 full-stack app (dashboard + API routes)
packages/
  agents/               # Multi-agent trading system (Orchestrator, MarketScout, ClaudeAssistant)
  database/             # Drizzle ORM schema with Vercel Postgres
  types/                # Shared TypeScript types and Zod schemas
  ui/                   # shadcn/ui component library
```

## Commands

```bash
# Development
pnpm install            # Install all dependencies
pnpm dev                # Start dev server (http://localhost:3000)
pnpm build              # Production build all packages
pnpm type-check         # TypeScript check across monorepo
pnpm lint               # ESLint across monorepo

# Database (run from packages/database)
pnpm db:generate        # Generate migrations from schema
pnpm db:push            # Push schema to database
pnpm db:studio          # Open Drizzle Studio UI
```

## Architecture

### Agent System (packages/agents)

All agents extend `BaseAgent` which provides:
- Lifecycle methods: `initialize()`, `start()`, `stop()`
- Message handling: `handleMessage(message: AgentMessage)`
- Event emission: `emit(event, data)`
- Status management: `idle | running | paused | error`

**Key Agents:**
- `OrchestratorAgent` - Coordinator that manages agent lifecycle, routes messages, runs health checks every 1s, triggers trading cycles every 15s
- `MarketScoutAgent` - 24/7 market scanner using CCXT, detects patterns (Bollinger Squeeze, Volume Spike) on BTC/ETH/SOL/BNB
- `ClaudeAssistantAgent` - xAI GROK integration for trading analysis chat

Agents are instantiated as singletons in API routes via `AgentFactory`.

### API Routes (apps/web/src/app/api)

- `GET/POST /api/agents` - Get agent statuses / Start or stop agents
- `POST /api/chat` - Chat with GROK assistant
- `GET /api/signals` - Retrieve trading signals

### Database Schema (packages/database/src/schema.ts)

8 tables: `users`, `portfolio`, `positions`, `trades`, `signals`, `marketData`, `agentActions`, `mlModels`

Time-series tables (`trades`, `signals`, `marketData`) are indexed on `timestamp`. Crypto amounts use decimal precision.

### Types (packages/types/src/index.ts)

Exports shared types and Zod validation schemas:
- Agent types: `AgentId`, `AgentStatus`, `AgentMessage`
- Trading types: `OrderSide`, `SignalAction`, `PatternType`, `TradingSignal`
- Schemas: `TradingSignalSchema`, `OrderSchema`, `PositionSchema`

## Tech Stack

- **Frontend:** Next.js 15, React 19, Tailwind CSS, Recharts, TradingView
- **Backend:** Next.js API routes, Drizzle ORM, Vercel Postgres/KV
- **AI/Trading:** xAI GROK (via OpenAI SDK), CCXT for exchange APIs
- **Tooling:** Turborepo, pnpm workspaces, TypeScript 5.8

## Environment Variables

Required in `apps/web/.env.local`:
```
XAI_API_KEY=xai-...
BINANCE_API_KEY=...
BINANCE_API_SECRET=...
BINANCE_TESTNET=true
POSTGRES_URL=...
KV_URL=...
```

## Adding New Agents

1. Create `packages/agents/src/[name]/[name]-agent.ts` extending `BaseAgent`
2. Implement `initialize()`, `start()`, `stop()`, `handleMessage()`
3. Export from `packages/agents/src/index.ts`
4. Add to `AgentFactory` and register in `OrchestratorAgent`

## Data Flow

```
MarketScoutAgent (every 15s)
  → Fetch candles via CCXT
  → Detect patterns
  → emit('signals_found', signals)
  → OrchestratorAgent routes to database
  → Dashboard fetches /api/signals
```
