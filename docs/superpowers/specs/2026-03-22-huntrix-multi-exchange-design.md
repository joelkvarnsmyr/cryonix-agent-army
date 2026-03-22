# Huntrix Multi-Exchange Support + Pump Duration Profiling

## Overview

Add multi-exchange support to Huntrix so it can scan and trade across Binance, Bybit, and MEXC simultaneously. Includes pump duration profiling to build statistical intelligence about pump characteristics per exchange, enabling data-driven exit timing.

**Pattern:** Extends existing Huntrix architecture with an ExchangeManager abstraction layer over CCXT, plus a PumpProfiler that logs and aggregates pump characteristics.

## Architecture

### Exchange Manager

New module `exchange-manager.ts` manages multiple CCXT instances:

```
huntrix.toml [[exchanges]]
  → ExchangeManager
    → ccxt.binance (priority 1, scan+trade)
    → ccxt.bybit   (priority 2, scan+trade)
    → ccxt.mexc    (priority 3, scan+trade)
```

**Initialization:** ExchangeManager reads `[[exchanges]]` from config, instantiates one CCXT instance per enabled exchange with `enableRateLimit: true`. Calls `loadMarkets()` on each exchange to build available pairs index. Paper mode uses public endpoints only (no API keys needed). Live mode adds credentials from env vars.

**Scanning:** `scanAll(symbols)` runs parallel `fetchTicker` + `fetchOrderBook` across all scan-enabled exchanges. Returns aggregated data keyed by `{symbol}:{exchange}`.

**Execution routing:** `getBestExchange(symbol)` selects the optimal exchange for a trade:
1. Filter: exchange has the pair listed
2. Weight: lowest spread
3. Weight: highest priority (most liquid)
4. Result: best exchange for this specific trade

**Position tracking:** Each `HuntrixPosition` gets an `exchange` field. Exit always happens on the same exchange as entry.

### Pump Duration Profiler

New module `pump-profiler.ts` logs every detected pump and builds statistical profiles.

**Per-pump data:**

| Field | Description |
|-------|-------------|
| `symbol` | Token symbol |
| `exchange` | Where the pump was detected |
| `detected_at` | Timestamp |
| `detection_phase` | early_pump, mid_pump, etc. |
| `source` | x_scan, telegram_cluster, trending_anomaly, etc. |
| `price_at_detection` | Price when detected |
| `peak_price` | Highest price observed (updated continuously) |
| `peak_minutes` | Minutes from detection to peak |
| `dump_start_price` | Price when dump velocity triggers |
| `duration_minutes` | Total pump duration (detection to dump) |
| `dump_velocity_pct_per_min` | How fast the dump happened |
| `volume_spike_ratio` | Volume multiplier at detection |
| `was_traded` | Whether Huntrix entered a position |
| `pnl_pct` | P&L if traded, null otherwise |

**Tracking flow:**

1. When manipulation scanner detects a pump signal, `PumpProfiler.startTracking(signal)` creates a new profile
2. Profiler polls price every 30s on tracked pumps via the detecting exchange's CCXT instance (max 10 concurrent, 60min timeout)
3. When price drops >2%/min from peak, mark `peak_price`, `peak_minutes`, `dump_start_price`
4. When price drops >50% from peak or timeout, finalize profile with `duration_minutes`
5. Store completed profile to Redis `huntrix:pump_history` (list, max 200 entries, 7d TTL)

**Aggregated statistics:** `huntrix:pump_stats` (hash, 24h TTL, refreshed on each new profile):

```
mexc:median_peak_minutes = 8
mexc:median_duration_minutes = 14
mexc:median_dump_velocity = 3.2
binance:median_peak_minutes = 22
binance:median_duration_minutes = 45
binance:median_dump_velocity = 1.1
bybit:median_peak_minutes = 15
bybit:median_duration_minutes = 30
bybit:median_dump_velocity = 1.8
```

**Brain integration:** Brain reads `pump_stats` during data collection and can set per-exchange `max_hold_minutes` based on actual median pump durations.

## Configuration

### TOML Changes

Replace single-exchange config with exchange array:

```toml
[[exchanges]]
id = "binance"
enabled = true
role = "scan+trade"
api_key_env = "BINANCE_API_KEY"
secret_env = "BINANCE_API_SECRET"
priority = 1

[[exchanges]]
id = "mexc"
enabled = true
role = "scan+trade"
api_key_env = "MEXC_API_KEY"
secret_env = "MEXC_API_SECRET"
priority = 3

[[exchanges]]
id = "bybit"
enabled = true
role = "scan+trade"
api_key_env = "BYBIT_API_KEY"
secret_env = "BYBIT_API_SECRET"
priority = 2
```

**Fields:**
- `id` — CCXT exchange identifier (e.g., `binance`, `bybit`, `mexc`, `gateio`, `kucoin`)
- `enabled` — Toggle without removing config
- `role` — `scan` (detection only), `trade` (execution only), `scan+trade` (both)
- `api_key_env` / `secret_env` — Env var names for credentials (not the actual keys)
- `password_env` — Optional, for exchanges requiring passphrase (OKX, KuCoin, Bitget)
- `priority` — Execution preference (1 = highest, used by routing)

### Capital Model

**Shared pool** — single `capital.virtual_balance` across all exchanges. Positions tracked with `exchange` field but budget is unified. This avoids splitting the already small capital base ($100).

## Type Changes

### New Types (`types.ts`)

```typescript
export interface ExchangeConfig {
  id: string;
  enabled: boolean;
  role: 'scan' | 'trade' | 'scan+trade';
  api_key_env: string;
  secret_env: string;
  password_env?: string;
  priority: number;
}

export interface PumpProfile {
  id: string;
  symbol: string;
  exchange: string;
  detected_at: number;
  detection_phase: PumpPhase;
  source: string;
  price_at_detection: number;
  peak_price: number;
  peak_minutes: number;
  dump_start_price: number;
  duration_minutes: number;
  dump_velocity_pct_per_min: number;
  volume_spike_ratio: number;
  was_traded: boolean;
  pnl_pct: number | null;
}

export interface PumpStats {
  exchange: string;
  median_peak_minutes: number;
  median_duration_minutes: number;
  median_dump_velocity: number;
  sample_count: number;
}
```

### Modified Types

- `HuntrixConfig` — replace single exchange init with `exchanges: ExchangeConfig[]`
- `HuntrixPosition` — add `exchange: string` field
- `ManipulationSignal` — add `exchange: string` field (which exchange detected it)

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `packages/agents/src/huntrix/exchange-manager.ts` | Multi-exchange CCXT management — init, scanAll, routeOrder, getBestExchange |
| `packages/agents/src/huntrix/pump-profiler.ts` | Log pumps, track peaks, aggregate statistics |
| `packages/agents/src/huntrix/__tests__/exchange-manager.test.ts` | Exchange manager tests |
| `packages/agents/src/huntrix/__tests__/pump-profiler.test.ts` | Pump profiler tests |

### Modified Files

| File | Change |
|------|--------|
| `huntrix.toml` | Replace single exchange setup with `[[exchanges]]` array |
| `packages/agents/src/huntrix/types.ts` | Add `ExchangeConfig`, `PumpProfile`, `PumpStats`; add `exchange` field to `HuntrixPosition` and `ManipulationSignal` |
| `packages/agents/src/huntrix/config.ts` | Parse `[[exchanges]]` TOML array, defaults for 3 exchanges |
| `packages/agents/src/huntrix/huntrix-agent.ts` | Replace `this.ccxt` with `this.exchangeManager`; update tick/scan/entry/exit to use manager; integrate pump profiler |
| `packages/agents/src/huntrix/manipulation-scanner.ts` | Accept exchange map instead of single CCXT instance; scan orderbook on all exchanges |
| `packages/agents/src/huntrix/entry-validator.ts` | Accept exchange instance parameter; validate against best exchange |
| `scripts/services/huntrix-brain.ts` | Read `pump_stats` in data collection; include in analysis prompt |
| `packages/agents/src/huntrix/brain-actions.ts` | No new adjustable params needed — Brain adjusts existing `max_hold_minutes` based on pump stats |
| `docker-compose.prod.yml` | Add `MEXC_API_KEY`, `MEXC_API_SECRET`, `BYBIT_API_KEY`, `BYBIT_API_SECRET` env vars |

## Docker Changes

### Environment Variables

Add to `huntrix` and `huntrix-brain` services in `docker-compose.prod.yml`:

```yaml
environment:
  - MEXC_API_KEY=${MEXC_API_KEY:-}
  - MEXC_API_SECRET=${MEXC_API_SECRET:-}
  - BYBIT_API_KEY=${BYBIT_API_KEY:-}
  - BYBIT_API_SECRET=${BYBIT_API_SECRET:-}
```

No Dockerfile changes needed — CCXT already supports all exchanges.

## Redis Keys

| Key | Purpose | TTL |
|-----|---------|-----|
| `huntrix:pump_history` | List of completed PumpProfile JSON entries (max 200) | 7d |
| `huntrix:pump_stats` | Hash of aggregated pump statistics per exchange | 24h |
| `huntrix:pump_tracking:{id}` | Active pump being tracked (price polling) | 60min |

## Exchange Manager API

```typescript
class ExchangeManager {
  constructor(config: ExchangeConfig[], mode: 'paper' | 'live')

  // Get all scan-enabled exchanges
  getScanExchanges(): Map<string, ccxt.Exchange>

  // Get all trade-enabled exchanges
  getTradeExchanges(): Map<string, ccxt.Exchange>

  // Get specific exchange
  getExchange(id: string): ccxt.Exchange | undefined

  // Scan all exchanges for a symbol — returns best ticker data
  async scanSymbol(symbol: string): Promise<{ exchange: string; ticker: Ticker } | null>

  // Scan all exchanges in parallel
  async scanAll(symbols: string[]): Promise<Map<string, { exchange: string; ticker: Ticker }>>

  // Find best exchange to execute a trade
  async getBestExchange(symbol: string): Promise<{ id: string; exchange: ccxt.Exchange; spread: number } | null>

  // Execute order on specific exchange
  async marketBuy(exchangeId: string, symbol: string, amount: number): Promise<Order>
  async marketSell(exchangeId: string, symbol: string, amount: number): Promise<Order>

  // Fetch orderbook from specific exchange
  async fetchOrderBook(exchangeId: string, symbol: string, limit?: number): Promise<OrderBook>
}
```

## Pump Profiler API

```typescript
class PumpProfiler {
  constructor(redis: Redis)

  // Start tracking a new pump (called by manipulation scanner)
  startTracking(signal: ManipulationSignal): void

  // Update tracking with current price (called every 30s)
  async tick(): Promise<void>

  // Finalize a profile (pump ended or timeout)
  async finalize(id: string, wasTraded: boolean, pnlPct?: number): Promise<void>

  // Get aggregated stats per exchange
  async getStats(): Promise<PumpStats[]>

  // Get stats for a specific exchange
  async getExchangeStats(exchange: string): Promise<PumpStats | null>

  // Get recent pump history
  async getHistory(limit?: number): Promise<PumpProfile[]>
}
```

## Scope Boundaries

### In Scope
- ExchangeManager with Binance + Bybit + MEXC
- Cross-exchange execution routing (detect on MEXC, trade on Bybit if better liquidity)
- Pump duration profiling and aggregated statistics
- Brain reads pump stats for `max_hold_minutes` tuning
- Shared capital pool across exchanges
- `exchange` field on positions and signals

### Out of Scope (Future)
- Copynix → Huntrix wallet bridge (Level 2)
- WebSocket streaming (ccxt.pro) — stay with REST polling for now
- Additional exchanges beyond the initial 3 (but config supports any CCXT exchange)
- Per-exchange capital pools
- DEX integration
