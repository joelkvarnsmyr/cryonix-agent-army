# Solanix — Design Specification
*2026-03-10*

## Overview

Solanix is a new autonomous trading agent for Solana DEX tokens. It runs alongside Cryonix (Binance) and Aktienix (stocks) as an independent system, sharing infrastructure (Redis, Postgres, BaseAgent) but with its own capital pool, config, and signal logic.

**Phase 1:** TA-based trading on established Solana tokens + dynamic DexScreener breakout detection.
**Phase 2:** Early pump detection for new token launches (on-chain pool screening).

---

## Goals

- Catch high-volatility moves on Solana DEX (20-200% intraday) that are unavailable on Binance CEX
- Reuse proven abstractions: `BrokerClient`, `BaseAgent`, `StatePublisher`, `RiskManager`, `ExitMonitor`
- Paper trade first — flip one config flag to go live
- Stay independent from Cryonix and Aktienix capital pools

---

## Architecture

### File Structure

```
packages/agents/src/solanix/
  solanix-agent.ts              # Orchestrator, extends BaseAgent
  types.ts                      # SolanaPosition, SolanaSignal, SolanaAccountState
  config.ts                     # TOML loader with safe defaults
  brokers/solana/
    solana-client.ts            # BrokerClient impl — Jupiter swaps + Helius RPC
  signals/
    solana-signal-generator.ts  # TA signals on static watchlist via Helius OHLCV
    dexscreener-scanner.ts      # Dynamic breakout detection via DexScreener API
solanix.toml                    # Configuration (repo root)
```

### What is reused from Aktienix/Cryonix

| Component | Reused | Notes |
|-----------|--------|-------|
| `BaseAgent` | Yes | Lifecycle, logging, message queue |
| `BrokerClient` interface | Yes | SolanaClient implements this |
| `StatePublisher` | Yes | Publishes to Redis `solanix:*` keys |
| `RiskManager` | Yes | Circuit breakers, daily loss limits |
| `ExitMonitor` | Yes | TP, SL, trailing stop, stagnation |
| `PositionSizer` | Yes | Dollar-based fractional sizing |

---

## Signal Flow

```
Static watchlist (SOL, JUP, BONK, WIF, PYTH, RNDR...)
  → Helius RPC: historical OHLCV (15m/1h bars)
  → TA analysis: RSI, MACD, Bollinger Bands
  → Confidence score

DexScreener poller (every 5 min)
  → Tokens with volume spike > 3x vs 1h average
  → Safety filter: min liquidity $50k, age > 24h (phase 1)
  → Added to dynamic watchlist with 2h TTL

Both sources → confidence threshold → RiskManager gate
  → PositionSizer (dollar-based)
  → SolanaClient.submitOrder()
      paper mode: simulate fill at Jupiter quote price
      live mode:  execute Jupiter swap on-chain

State published to Redis every loop:
  solanix:status     — agent state (running/paused/stopped)
  solanix:account    — virtual portfolio (paper) or real balances
  solanix:positions  — open positions with unrealized P&L
  solanix:signals    — recent signal log
  solanix:circuit_breaker — checked before every trade
```

---

## SolanaClient (BrokerClient)

Implements the existing `BrokerClient` interface:

```typescript
interface BrokerClient {
  connect(): Promise<void>          // Init Helius RPC + validate wallet keypair
  disconnect(): Promise<void>       // Cleanup
  getAccountState(): Promise<AccountState>  // SOL + USDC balances
  getPositions(): Promise<StockPosition[]>  // Token holdings
  submitOrder(order: BrokerOrder): Promise<BrokerOrderResult>  // Jupiter swap
}
```

**Paper mode:** `submitOrder()` fetches a real Jupiter quote but does not sign/send the transaction. Fills are simulated at the quoted price. Virtual positions tracked in memory + Redis.

**Live mode:** Signs and sends the swap transaction via Helius RPC. Identical code path.

**Dependencies:**
- `@solana/web3.js` — wallet keypair, RPC connection
- `@jup-ag/api` — swap quotes and transaction building

---

## DexScreener Scanner

Polls `https://api.dexscreener.com/latest/dex/tokens` for Solana pairs with:
- Volume 24h spike > 3x vs baseline
- Liquidity > $50k USD (phase 1 safety filter — reduces rug risk)
- Token age > 24h (avoids brand-new launches in phase 1)

Tokens passing filters are added to a dynamic watchlist with a 2-hour TTL. The TA signal generator then evaluates them on the next cycle.

**Phase 2 upgrade:** Lower age threshold to 0, add on-chain safety checks (mint authority renounced, top-10 wallet concentration < 30%).

---

## Coordination with Cryonix

- **Independent capital pools** — Solanix holds its own SOL/USDC, Cryonix holds USDC on Binance
- **Shared Redis instance** — same `KV_URL` env var
- **Circuit breaker key** `solanix:circuit_breaker` — if set (by any system), Solanix pauses before next trade
- **Phase 2:** Cryonix CMC Fear & Greed + market regime published to Redis, Solanix reads these as macro context

---

## Configuration (`solanix.toml`)

```toml
[broker]
paper_trading = true

[watchlist]
symbols = ["SOL", "JUP", "BONK", "WIF", "PYTH", "RNDR"]
timeframe = "15Min"
bars_count = 100

[capital]
max_position_size_usd = 50
max_capital_per_trade_pct = 0.95
min_order_value = 1.00

[limits]
max_open_positions = 5
max_trades_per_day = 10

[risk]
min_confidence = 0.60
max_daily_loss_pct = 0.05

[exits]
take_profit_pct = 8.0
stop_loss_pct = 4.0
trailing_stop_pct = 5.0
trailing_activation_pct = 3.0

[timing]
poll_interval_ms = 60_000
signal_scan_interval_ms = 900_000
dexscreener_scan_interval_ms = 300_000

[signals]
min_signal_score = 0.35
dexscreener_enabled = true
dexscreener_min_liquidity_usd = 50000
dexscreener_volume_spike_multiplier = 3.0
dexscreener_dynamic_ttl_ms = 7_200_000
```

---

## Environment Variables

```
HELIUS_API_KEY=...
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
SOLANA_PRIVATE_KEY=...   # base58 encoded keypair (paper mode: can be empty)
```

---

## Dashboard Integration

Redis keys published by Solanix are consumed by a new `/api/solanix/status` route (same pattern as `/api/aktienix/status`). Dashboard gets a new "Solanix" tab.

---

## Phase 2 Roadmap

1. Lower DexScreener age filter to catch newer tokens
2. On-chain safety checks via Helius: mint authority, top-holder concentration
3. Telegram signal channel monitoring (reuse existing scraper infrastructure)
4. CMC + Cryonix market regime integration
5. Live trading with small dedicated capital pool
