# Aktienix Agent Architecture

This document describes the internal structure of the `AktienixAgent` module located within `@cryonix/agents`.

## Overview
`AktienixAgent` is designed as a specialized extension of the Cryonix `BaseAgent` class. While the other agents in the `cryonix-agent-army` focus on cryptocurrencies, `AktienixAgent` is tailor-made for traditional stock equities in the US market, dealing with the specific limitations discussed in the strategy analysis (like the PDT rule and T+1 settlement).

## Location
- Path: `packages/agents/src/aktienix/`
- Exported via: `packages/agents/src/index.ts`

## Core Components

### `aktienix/types.ts`
Defines the interfaces strictly necessary for equity trading, which differ significantly from cryptocurrencies:
- `AktienixConfig`: Includes parameters like `accountType ('cash' | 'margin')` and integration preferences (`broker`).
- `AccountState`: Specifically tracks `settledCash`, which is critical for avoiding Good Faith Violations in cash accounts, as well as checking `isPatternDayTrader`.
- `StockPosition`: Tracks traditional equity metrics like `unrealizedPl` and `marketValue`.

### `aktienix/aktienix-agent.ts`
The main class extending `BaseAgent`. 
- **Initialization:** Connects to the broker. Currently supports a `'mock'` broker interface for local and paper testing without risking capital or PDT flags.
- **Signal Handling (`evaluateSignal`):** Listens to `TRADE_SIGNAL` messages dispatched by the System Orchestrator or the Intelligence/Engine layers.
- **T+1 Logic:** Validates every incoming buy signal against `AccountState.settledCash` rather than total buying power. If `settledCash` is insufficient (e.g., funds are waiting to clear from a previous day's sale), the agent correctly blocks the trade to prevent account freezing.

## Future Broker Implementation
The mock implementation serves as the scaffolding. In future iterations, `AktienixAgent` will instantiate a strategy-specific `BrokerClient` (e.g., Alpaca or Interactive Brokers):
1. **Interactive Brokers (IBKR):** The preferred target for Swedish ISK accounts. The `BrokerClient` will connect to the local Docker CP Gateway.
2. **Alpaca:** The fallback target using the Alpaca API for pure API simplicity, bearing in mind the 30% flat tax on traditional brokerage accounts in Sweden.

The API abstraction strictly isolates the actual `http` calls from the core Agent loop to allow hot-swapping between IBKR and Alpaca with minimal refactoring.
