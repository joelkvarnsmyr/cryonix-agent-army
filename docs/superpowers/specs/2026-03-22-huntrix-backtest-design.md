# Huntrix Backtester — Design Spec

## Goal

Build a backtester for Huntrix that validates both signal quality (do synthetic pump signals match real pumps?) and exit logic (SL/TP/trailing/dump velocity) against historical OHLCV data.

## Approach

Hybrid backtester:
- **Synthetic signals** from OHLCV anomalies (volume spikes + price velocity) as proxy pump events
- **Calibration** against saved `PumpProfile[]` from Redis `huntrix:pump_history` to measure precision/recall
- **Exit replay** using the real `DumpDetector` against historical price ticks

## Architecture

Pure TypeScript, no Redis/Postgres dependency at runtime. Three pipeline stages:

### 1. SyntheticSignalGenerator

Scans historical OHLCV and generates `ManipulationSignal[]` from anomalies:
- Volume spike detection via `VolumeSpikeDetector` (reused from `market-scout`)
- Price velocity within `min_entry_velocity` – `max_entry_velocity` range (from `huntrix.toml` `detection.*`)
- Phase classification: `early_pump` if price moved <5% from baseline, `mid_pump` if 5-20%
- Already-pumped guard: reject if 24h change > `max_already_pumped_pct`

Uses `calculateSMA` from `market-scout/pattern-detectors/pattern-detector.interface.ts` for baseline calculations.

Config: reads `detection.*` section from `HuntrixConfig` — no new config keys needed.

### 2. EntrySimulator

Lightweight inline checks (NOT the live `EntryValidator`):
- Phase check: reject `peak`, `dump`, `post_dump`
- Confidence threshold: `getMinConfidence(type)` — P&D: 70%, shill/influencer: 65%, whale: 75%
- Volume spike confirmation via `VolumeSpikeDetector`
- Already-pumped filter from OHLCV 24h lookback

Skipped (live-only): blacklist, spread check, GoPlus, recent-exit cooldown.

### 3. ExitSimulator

Replays 1-minute OHLCV ticks from entry point through the real `DumpDetector`:
- Constructs synthetic `HunterPosition` with `price_history: PriceTick[]`
- On each tick: appends candle to `price_history`, updates `current_price`, `unrealized_pnl`, `unrealized_pnl_pct`
- Calls `DumpDetector.check()` + `DumpDetector.updateTrailing()` on each tick
- Exits triggered: stop_loss, take_profit, trailing_stop, dump_velocity, volume_reversal, max_hold_time
- `recheckShillActivity()` skipped (live Grok API call)

**DumpDetector time injection:** `DumpDetector.checkMaxHoldTime()` uses `Date.now()` which won't work for historical data. The ExitSimulator wraps this by setting `position.entered_at` relative to the simulated tick timestamp, so hold time is computed correctly. Specifically: `entered_at` is set to `candles[entryIdx].timestamp` as ISO string, and the ExitSimulator computes hold time from `(candle.timestamp - entryTimestamp)` directly rather than relying on `checkMaxHoldTime()`. The other DumpDetector checks (SL/TP/trailing/velocity/volume) are pure math on position fields and work without modification.

Uses full `HuntrixConfig` (loaded from `huntrix.toml` via `loadHuntrixConfig()`) — identical thresholds as production. `DumpDetector` constructor requires the complete config object.

### 4. Calibrator (optional)

When `--pump-history <file.json>` is provided:
- Loads `PumpProfile[]` (exported from Redis)
- Matches synthetic signals to real profiles by symbol + time window (±5 min)
- Computes precision (synthetic signals that matched real pumps) and recall (real pumps we found)

## Reused Components

| Component | Source | Notes |
|-----------|--------|-------|
| `DumpDetector` | `packages/agents/src/huntrix/dump-detector.ts` | Exit logic — skip `recheckShillActivity()` and `checkMaxHoldTime()` (handle in ExitSimulator) |
| `VolumeSpikeDetector` | `packages/agents/src/market-scout/pattern-detectors/volume-spike.ts` | Volume anomaly detection on 15m candles (needs ≥21 candles, ≥1% price move). Returns `PatternSignal \| null` — treat non-null as spike confirmed. Input `OhlcvData[]` is structurally identical to `Candle[]` |
| `calculateSMA`, `calculateStdDev` | `packages/agents/src/market-scout/pattern-detectors/pattern-detector.interface.ts` | Pure math functions |
| `BacktestResult`, `PerformanceMetrics`, `BacktestTrade`, `EquityPoint` | `packages/types/src/index.ts` | Platform-wide output types for dashboard compatibility |

## New Files

| File | Responsibility |
|------|---------------|
| `packages/agents/src/huntrix/backtester.ts` | `HuntrixBacktester` class — orchestrates pipeline |
| `packages/agents/src/huntrix/synthetic-signal-generator.ts` | Generates `ManipulationSignal[]` from OHLCV anomalies |
| `packages/agents/src/huntrix/__tests__/backtester.test.ts` | Unit tests for backtester + signal generator |
| `scripts/strategy-lab/huntrix_backtest.ts` | CLI runner script |

## Types

### HuntrixBacktestResult

Independent type with Huntrix-specific fields. Includes a `toPerformanceMetrics()` method that maps to `PerformanceMetrics` from `@cryonix/types` for dashboard compatibility:

```typescript
interface HuntrixBacktestResult {
  // Standard (from @cryonix/types PerformanceMetrics)
  totalPnl: number;
  winRate: number;
  wins: number;
  losses: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  equityCurve: EquityPoint[];

  // Huntrix-specific
  trades: HuntrixBTTrade[];
  avgHoldMinutes: number;
  exitBreakdown: Record<string, number>;  // count per ExitReason
  signalsGenerated: number;
  signalsApproved: number;
  approvalRate: number;
  calibration: CalibrationResult | null;
}

interface HuntrixBTTrade {
  symbol: string;
  exchange: string;
  entryIdx: number;
  exitIdx: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  holdMinutes: number;
  exitReason: string;        // maps to ExitReason
  signalType: string;        // ManipulationType
  signalConfidence: number;
  phase: string;             // PumpPhase at entry
}

interface CalibrationResult {
  precision: number;
  recall: number;
  matchedProfiles: number;
  unmatchedProfiles: number;
  falsePositives: number;
}
```

### ExitReason mapping to BacktestTrade.exitReason

| Huntrix ExitReason | BacktestTrade exitReason |
|---|---|
| `stop_loss` | `stop_loss` |
| `take_profit` | `target` |
| `trailing_stop` | `trailing_stop` |
| `max_hold_time` | `time_exit` |
| `dump_velocity` | `signal` |
| `volume_reversal` | `signal` |
| `shill_drop` | `signal` |

## CLI Interface

```bash
# Basic usage
npx tsx scripts/strategy-lab/huntrix_backtest.ts --symbol BTC/USDC --days 30

# Multi-exchange, JSON output
npx tsx scripts/strategy-lab/huntrix_backtest.ts --symbol ETH/USDC --days 7 --exchange mexc --json

# With pump history calibration
npx tsx scripts/strategy-lab/huntrix_backtest.ts --symbol SOL/USDC --days 14 --pump-history pump_profiles.json

# Multiple symbols
npx tsx scripts/strategy-lab/huntrix_backtest.ts --symbol BTC/USDC,ETH/USDC,SOL/USDC --days 30
```

Arguments:
- `--symbol` (required): Trading pair(s), comma-separated
- `--days` (default: 30): Historical lookback
- `--exchange` (default: binance): CCXT exchange for OHLCV data
- `--json`: Output as JSON (for programmatic use)
- `--pump-history <file>`: Path to exported PumpProfile[] JSON for calibration
- `--config <file>`: Path to huntrix.toml (default: `./huntrix.toml`)

## Data Flow

```
CLI (--symbol, --days, --exchange)
  → CCXT exchange.fetchOHLCV(symbol, '1m', ...) with pagination (1000 bars/request)
  → CCXT exchange.fetchOHLCV(symbol, '15m', ...) with pagination
  → SyntheticSignalGenerator.scan(candles1m, candles15m, config.detection)
    → VolumeSpikeDetector.detect() per 20-bar window
    → Price velocity calculation per velocity_window_seconds
    → Phase classification (early_pump / mid_pump)
    → ManipulationSignal[] with type='wash_trading_pump', source='trending_anomaly'
  → EntrySimulator.filter(signals, config)
    → Phase check, confidence threshold, already-pumped guard
    → Approved ManipulationSignal[]
  → ExitSimulator.run(approved, candles1m, config.exits)
    → For each signal: construct HunterPosition at entry bar
    → Replay subsequent 1m candles through DumpDetector.check()
    → DumpDetector.updateTrailing() per tick
    → Record exit: reason, price, hold time
    → HuntrixBTTrade[]
  → Calibrator.compare(trades, pumpProfiles?) [if --pump-history]
    → Match synthetic signals to PumpProfile by symbol + ±5min window
    → CalibrationResult { precision, recall }
  → Compute PerformanceMetrics (equity curve, Sharpe, drawdown)
  → Print/return HuntrixBacktestResult
```

## Constraints

- No Redis/Postgres dependencies at runtime (pure computation)
- OHLCV fetched via public CCXT (no API keys needed), any exchange supported via `--exchange`
- CLI runner handles OHLCV pagination (1000 bars/request, loop until all fetched)
- 1-minute candles for exit replay (matches production `price_check_ms: 5000` granularity)
- 15-minute candles for signal generation + `VolumeSpikeDetector` (needs ≥21 candles, ≥1% price move — too rare on 1m)
- Max ~43,200 1m candles per symbol for 30 days (pagination handles this)
- Synthetic signals use `source: 'trending_anomaly'` (existing union value, no type changes needed)
- Reuse existing components wherever possible — no duplication

## Testing

- Unit test `SyntheticSignalGenerator` with known OHLCV patterns (inject a volume spike, verify signal generated)
- Unit test `ExitSimulator` with a synthetic position + known price path (verify SL/TP/trailing triggers correctly)
- Unit test `Calibrator` with mock PumpProfile[] and mock signals (verify precision/recall math)
- Integration test: run full pipeline on a small OHLCV dataset, verify non-zero trades with valid exit reasons
