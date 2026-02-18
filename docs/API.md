# Cryonix API Reference

> Auto-generated from `apps/web/src/app/api/` route scan. Last updated: 2026-02-18.

## Base URL

- **Development:** `http://localhost:3000`
- **Production:** `https://cryonix.openclaw.ai` (via Caddy reverse proxy)

All routes are Next.js App Router API routes (`apps/web/src/app/api/`).

---

## Trading (critical)

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/api/auto-trade` | **CRITICAL.** Core auto-trade loop: reads Redis `trades:pending`, runs filters (EV, CMC, spread, GROK AI validation), executes on Binance, monitors SL/TP/trailing. Polled every 30s by auto-trader worker. |
| **POST** | `/api/auto-trade` | Same endpoint, POST variant for the execution cycle. |
| **POST** | `/api/trade` | Execute a manual trade on Binance (BUY/SELL). |
| **GET** | `/api/trade` | Get recent trade history from Postgres. |
| **DELETE** | `/api/trade` | Cancel an open order on Binance. |
| **GET** | `/api/positions` | List open or closed positions (`?action=open\|history\|stats\|summary`). |
| **POST** | `/api/positions` | Close a position (triggers Binance sell + archive). |
| **PUT** | `/api/positions` | Update SL/TP levels on an open position. |
| **DELETE** | `/api/positions` | Force-close/remove a position. |

### `/api/auto-trade` (GET) -- request/response

No query parameters. Called by the auto-trader worker on a 30s loop.

```
Response: { status: "ok", cycle: { ... }, positions_monitored: N, trades_executed: N }
```

The response includes the full cycle result: signals processed, trades executed, positions monitored, and any errors. The exact shape varies per cycle.

---

## Analytics

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/api/analytics/journal` | **CRITICAL.** Trade journal: closed positions with P&L, pattern, config version. Supports `?days=7&pattern=X&config_version=X`. |
| **GET** | `/api/costs` | GROK AI API cost breakdown (24h, 7d, 30d) by model. |
| **GET** | `/api/evolution` | Evolution run history + calibration data from Postgres + Redis. |
| **GET** | `/api/calibration` | Current pattern EV calibration data from Redis. |
| **POST** | `/api/calibration` | Trigger calibration: compute pattern performance from trade history, store in Redis. |
| **GET** | `/api/process-log` | Unified process log: signals, validations, risk checks, trades from last 24h. |

### `/api/analytics/journal` (GET) -- request/response

```
Query: ?days=7&pattern=volume_spike_up&config_version=abc12345
Response: { success: true, journal: [...], summary: { totalTrades, winRate, avgPnl, ... }, configComparison: [...] }
```

---

## Market Data

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/api/market` | Live ticker + OHLCV candles from Binance (`?symbol=BTCUSDT&interval=1h&limit=100`). |
| **GET** | `/api/chart-data` | Chart data for dashboard: candles, trade markers, position history, signals (`?action=candles\|trades\|positions\|signals`). |
| **GET** | `/api/signals` | **CRITICAL.** List trading signals (`?action=list\|unexecuted\|stats&symbol=X&pattern=X&limit=50`). |
| **POST** | `/api/signals` | Create/persist a new signal (used by Python engine via HTTP). |
| **GET** | `/api/scanner-history` | GainerScanner snapshots from Redis (`?limit=10`). |
| **POST** | `/api/scanner-history` | Store a GainerScanner snapshot (keeps last 96 = 24h). |
| **GET** | `/api/telegram-signals` | Active Telegram channel signals + channel quality stats from Redis. |
| **GET** | `/api/x-sentiment` | Cached X/Twitter sentiment data from Redis. |
| **POST** | `/api/x-sentiment` | Trigger X sentiment scan via GROK with live search. |

### `/api/signals` (GET) -- request/response

```
Query: ?action=list&symbol=BTC/USDT&pattern=bollinger_squeeze&limit=50
Response: { success: true, count: N, data: [{ id, timestamp, symbol, action, confidence, pattern, entry_price, target_price, stop_loss, reasoning, executed, ... }] }
```

---

## System (critical)

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/api/health` | **CRITICAL.** Health check: Redis, Postgres, Engine, MarketScout status + latency. Used by `health-monitor.sh` cron. |
| **POST** | `/api/analyze` | Send data to GROK AI for market analysis. |
| **POST** | `/api/chat` | Chat with GROK AI assistant. |
| **POST** | `/api/validate-signal` | Multi-source signal validation (consensus scoring). |
| **GET** | `/api/validate-signal` | Get recent validation history. |
| **GET** | `/api/risk` | Current risk status: portfolio exposure, daily/weekly P&L limits, circuit breaker state. |
| **POST** | `/api/risk` | Update risk parameters. |
| **POST** | `/api/risk-check` | Check if a proposed trade passes risk rules (Kelly sizing, limits). |
| **GET** | `/api/risk-check` | Get recent risk check history. |
| **GET** | `/api/grid-config` | Get active grid trading configuration from Redis. |
| **POST** | `/api/grid-config` | Generate and store a new grid config (GROK AI-assisted range selection). |
| **DELETE** | `/api/grid-config` | Cancel an active grid config. |
| **POST** | `/api/backtest` | Run a backtest simulation. |
| **GET** | `/api/backtest` | Get backtest results. |
| **DELETE** | `/api/backtest` | Delete a backtest result. |

### `/api/health` (GET) -- request/response

```
Response: {
  status: "ok",
  uptime_s: 12345,
  config_hash: "abc12345",
  checks: {
    redis: { status: "ok", latency_ms: 2 },
    postgres: { status: "ok", latency_ms: 5 },
    engine: { status: "ok", latency_ms: 12 },
    market_scout: { status: "ok", latency_ms: 3 }
  }
}
```

---

## Agents (legacy)

| Method | Path | Description |
|--------|------|-------------|
| **GET** | `/api/agents` | Get status of legacy TypeScript agents (Orchestrator, MarketScout, ClaudeAssistant). |
| **POST** | `/api/agents` | Control legacy agents (start/stop). |
| **GET** | `/api/orchestrator/status` | Legacy orchestrator state (running, agents, P&L). |
| **POST** | `/api/orchestrator/start` | Start legacy orchestrator. |
| **POST** | `/api/orchestrator/stop` | Stop legacy orchestrator. |
| **GET** | `/api/tanks/status` | Python tank status from Redis (`?id=market_scout`). |
| **GET** | `/api/tanks/approvals` | List pending trades from Redis `trades:pending` queue. |
| **POST** | `/api/tanks/approvals` | Approve or reject a pending trade signal. |

---

## Route Count Summary

29 route files, ~50 method handlers across 5 categories.

**Critical paths** (affect live trading or monitoring):
- `GET /api/auto-trade` -- core execution loop
- `GET /api/health` -- uptime monitoring + alerting
- `GET /api/signals` -- signal pipeline visibility
- `GET /api/analytics/journal` -- trade performance tracking
