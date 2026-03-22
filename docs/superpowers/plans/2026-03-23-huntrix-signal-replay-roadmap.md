# Huntrix — Signal Replay Backtester Roadmap

**Status:** Data collection phase (started 2026-03-23)
**Owner:** Huntrix agent instance

---

## What Was Built (Complete)

### Core System
| Component | File | Description |
|-----------|------|-------------|
| ManipulationScanner | `packages/agents/src/huntrix/manipulation-scanner.ts` | X/Twitter (Grok), Telegram clusters, CMC trending anomalies |
| EntryValidator | `packages/agents/src/huntrix/entry-validator.ts` | Volume ratio, price velocity, phase, blacklist, GoPlus checks |
| DumpDetector | `packages/agents/src/huntrix/dump-detector.ts` | Trailing stop, velocity exit, max hold, shill re-check |
| ExchangeManager | `packages/agents/src/huntrix/exchange-manager.ts` | Multi-exchange (Binance + Bybit + MEXC) |
| PumpProfiler | `packages/agents/src/huntrix/pump-profiler.ts` | Per-exchange pump duration tracking |
| Brain | `scripts/services/huntrix-brain.ts` | Autonomous parameter tuning via Claude Code CLI |
| BrainActions | `packages/agents/src/huntrix/brain-actions.ts` | Bounds validation, TOML write, force-exit |

### Phase 1: Signal Sources (7 total)
| Source | File | Type |
|--------|------|------|
| X/Twitter (Grok) | `manipulation-scanner.ts` | Detection (trade) |
| Telegram clusters | `manipulation-scanner.ts` | Detection (trade) |
| CMC trending | `manipulation-scanner.ts` | Detection (trade) |
| GoPlus Security | `scanners/goplus.ts` | Defensive (blacklist) |
| DeFi Llama hacks | `scanners/defi-llama-hacks.ts` | Defensive (blacklist) |
| RSS security feeds | `scanners/rss-feeds.ts` | Defensive (blacklist) |
| Orderbook spoofing | `scanners/orderbook.ts` | Detection (trade) |

### Backtester
| Component | File | Description |
|-----------|------|-------------|
| SyntheticSignalGenerator | `packages/agents/src/huntrix/synthetic-signal-generator.ts` | Volume-spike proxy (OHLCV only) |
| HuntrixBacktester | `packages/agents/src/huntrix/backtester.ts` | filterSignals, simulateExits, computeMetrics, calibrate |
| CLI runner | `scripts/strategy-lab/huntrix_backtest.ts` | `--symbol --days --exchange --json --pump-history` |

### Signal Persistence (2026-03-23)
- Table: `huntrix_signals` in Postgres
- Columns: signal_id, symbol, type, source, exchange, confidence, phase, price_at_detection, volume_spike_ratio, price_velocity, total_shill_accounts, estimated_peak_minutes, reasoning, detected_at, logged_at, metadata
- Indexes: symbol, detected_at
- Created automatically by HuntrixAgent.initialize()

### Infrastructure
- Docker: Multi-stage `Dockerfile.huntrix` (runner = lean, brain = with Claude CLI)
- Deploy: `safe-deploy.sh` with flock mutex (prevents concurrent builds)
- Config: `huntrix.toml`

---

## Current Phase: Data Collection

**Started:** 2026-03-23
**Duration:** ~2 weeks minimum
**What's happening:** Every ManipulationSignal detected by fullScan() is persisted to `huntrix_signals` table with full metadata.

### Monitoring Data Collection

```bash
# Check signal count
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c \
  "SELECT COUNT(*), MIN(detected_at), MAX(detected_at) FROM huntrix_signals"

# Signals by source
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c \
  "SELECT source, COUNT(*) FROM huntrix_signals GROUP BY source ORDER BY count DESC"

# Signals by symbol
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c \
  "SELECT symbol, COUNT(*) FROM huntrix_signals GROUP BY symbol ORDER BY count DESC LIMIT 20"

# Recent signals
docker exec cryonix-postgres-1 psql -U postgres -d cryonix -c \
  "SELECT symbol, type, source, confidence, phase, detected_at FROM huntrix_signals ORDER BY detected_at DESC LIMIT 10"
```

---

## Next Phase: Signal Replay Backtester

**When:** After ~2 weeks of data collection (target: ~2026-04-06)
**Prerequisite:** At least 50+ signals in `huntrix_signals`

### Concept

The current SyntheticSignalGenerator only finds volume-spike patterns in OHLCV data — it misses the real Huntrix signal sources (social media, Telegram clusters, GoPlus alerts, RSS).

The Signal Replay Engine will:
1. **Query historical signals** from `huntrix_signals` table
2. **Fetch OHLCV data** around each signal's `detected_at` timestamp
3. **Replay through HuntrixBacktester** with real entry timestamps
4. **Measure actual edge** — did the signal predict a tradeable pump?

### Proposed Architecture

```
huntrix_signals (Postgres)
  ↓ query by date range
SignalReplayEngine
  ↓ for each signal:
  ├── Fetch 1m OHLCV starting at detected_at (via CCXT)
  ├── Run EntryValidator.validate() with real market data
  ├── If valid → simulate entry at market price
  ├── Run ExitSimulator (SL/TP/trailing/dump velocity/max hold)
  └── Record: entry_price, exit_price, pnl, exit_reason, hold_time
  ↓
BacktestReport
  ├── Per-source accuracy (x_scan vs telegram_cluster vs trending)
  ├── Per-type accuracy (pump_and_dump vs coordinated_shill)
  ├── Per-phase accuracy (early_pump vs mid_pump)
  ├── Equity curve (EquityPoint[])
  ├── Sharpe ratio, max drawdown, win rate
  └── Optimal parameter suggestions (SL%, TP%, confidence threshold)
```

### Key Design Decisions (TBD)

- Should replay use the confidence/phase from the original signal, or re-validate?
- Should we replay only signals that passed EntryValidator, or all signals (to measure validator accuracy)?
- How to handle signals for symbols not available on all exchanges?

---

## Completed Plans (Reference)

| Plan | Status |
|------|--------|
| `2026-03-21-huntrix-phase1-signal-sources.md` | ✅ All 9 tasks done |
| `2026-03-22-huntrix-backtest.md` | ✅ All tasks done |
| `2026-03-22-huntrix-brain.md` | ✅ All tasks done |
| `2026-03-22-huntrix-multi-exchange.md` | ✅ All tasks done |
