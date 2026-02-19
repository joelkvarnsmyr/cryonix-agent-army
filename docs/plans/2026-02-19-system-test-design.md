# Comprehensive System Integration Test — Design Doc

**Date**: 2026-02-19
**Author**: Claude Opus 4.6
**Status**: Draft

## Context

Cryonix is a production autonomous crypto trading system with 8 Docker services, 29 Next.js API routes, 14 Python engine endpoints, 19 Postgres tables, 79+ Redis keys, 8 cron jobs, WebSocket server, Telegram bots, and Binance integration. The system has evolved significantly and needs a comprehensive integration test to verify all components work correctly.

## File to Create

`scripts/system-test.sh` — Single Bash script (~500 lines)

## Design Decisions

1. **Pure Bash** — Zero dependencies beyond curl, jq, redis-cli (via docker exec), psql (via docker exec), docker, node. No npm install, no build step.
2. **Parallel execution** — 25 test groups run as background subshells, results collected via temp files.
3. **Read-only safety** — No POST to /api/auto-trade (trades), /api/signals (creates signals), /api/analyze (GROK tokens), /api/x-sentiment POST (GROK tokens), /api/tanks/approvals POST (moves queue), /api/grid-config POST (GROK tokens).
4. **Docker exec** for Redis/Postgres/Engine — Engine has no host port in prod, Redis/Postgres bound to 127.0.0.1 but docker exec is more reliable.
5. **Inline Node.js** for WebSocket tests — Uses `ws` module from project's node_modules.
6. **Color-coded output** — Green PASS, Red FAIL, Yellow SKIP with summary table.

## Architecture

```
scripts/system-test.sh
├── Config (URLs, timeouts, temp dir)
├── Dependency check (curl, jq, docker, node)
├── Helper functions
│   ├── http_test URL EXPECTED_STATUS [JQ_FILTER EXPECTED_VALUE]
│   ├── redis_test COMMAND [EXPECTED_PATTERN]
│   ├── pg_test QUERY [EXPECTED_PATTERN]
│   ├── docker_test CONTAINER [EXPECTED_STATUS]
│   └── write_result FILE STATUS NAME DETAIL
├── 25 test group functions (run in parallel)
├── Orchestrator: launch all, wait with timeout
├── Aggregate results from /tmp/cryonix-test-XXXXXX/*.txt
└── Summary table + failures list
```

## Safety Guards (NEVER call these)

| Endpoint | Why |
|----------|-----|
| `POST /api/auto-trade` | Executes real trades on Binance |
| `POST /api/signals` | Creates signals that may be executed |
| `POST /api/analyze` | Burns GROK API tokens ($) |
| `POST /api/x-sentiment` | Burns GROK API tokens ($) |
| `POST /api/grid-config` | Burns GROK tokens for grid analysis |
| `POST /api/tanks/approvals` | Moves signals through execution queue |
| `DELETE /api/grid-config` | Cancels active grid strategies |
| `POST /api/orchestrator/start` | Starts agent systems |
| `POST /api/orchestrator/stop` | Stops agent systems |

## Test Groups (25 groups, ~82 tests)

### Group 01: Docker Infrastructure (5 tests)
All containers running and healthy.

| Test | Method | Pass |
|------|--------|------|
| postgres_running | docker ps --filter name=cryonix-postgres | Up + (healthy) |
| redis_running | docker ps --filter name=cryonix-redis | Up + (healthy) |
| engine_running | docker ps --filter name=cryonix-engine | Up |
| web_running | docker ps --filter name=cryonix-web | Up |
| container_count | docker ps --filter label=com.docker.compose.project=cryonix | >= 8 |

### Group 02: Health Endpoint (4 tests)
Composite health check.

| Test | Method | Pass |
|------|--------|------|
| health_200 | GET /api/health | HTTP 200 |
| health_redis | jq .checks.redis.status | "ok" |
| health_postgres | jq .checks.postgres.status | "ok" |
| health_overall | jq .status | "healthy" or "degraded" |

### Group 03: Health Sub-services (3 tests)

| Test | Method | Pass |
|------|--------|------|
| health_binance | jq .checks.binance.status | "ok" |
| health_engine | jq .checks.engine.status | "ok" |
| health_trading | jq .trading.regime | not null |

### Group 04: Python Engine Core (4 tests)
Via `docker exec cryonix-engine-1 curl localhost:8000/...`

| Test | Method | Pass |
|------|--------|------|
| engine_root | GET / | .status == "online" |
| engine_health | GET /health | .status == "healthy" |
| engine_tanks | GET /tanks/status | .engine_status == "online" |
| engine_risk | GET /risk/status | .status == "ok" |

### Group 05: Engine Backtest (3 tests)

| Test | Method | Pass |
|------|--------|------|
| engine_backtest_list | GET /backtest/list | .backtests is array |
| engine_backtest_quick | GET /backtest/quick?symbol=BTC/USDT&days=7 | .total_trades >= 0 |
| engine_pending | GET /tanks/pending | .count >= 0 |

### Group 06: Auto-Trade Status (4 tests)
GET only — no trades.

| Test | Method | Pass |
|------|--------|------|
| autotrade_200 | GET /api/auto-trade | HTTP 200 |
| autotrade_active | jq .status | "active" |
| autotrade_budget | jq .budget.totalCapital | > 0 |
| autotrade_config | jq .config.TRADING_MODE | "spot" |

### Group 07: Signals API (3 tests)

| Test | Method | Pass |
|------|--------|------|
| signals_list | GET /api/signals?action=list&limit=3 | .success == true |
| signals_stats | GET /api/signals?action=stats | .success == true |
| signals_unexecuted | GET /api/signals?action=unexecuted&limit=3 | .success == true |

### Group 08: Market Data (4 tests)

| Test | Method | Pass |
|------|--------|------|
| market_ticker | GET /api/market?action=ticker&symbol=BTC/USDT | .data.price > 0 |
| market_tickers | GET /api/market?action=tickers | .data is array, length >= 3 |
| market_ohlcv | GET /api/market?action=ohlcv&symbol=BTC/USDT&timeframe=15m&limit=5 | .data is array, length == 5 |
| market_orderbook | GET /api/market?action=orderbook&symbol=BTC/USDT | .data.bids is array |

### Group 09: Portfolio & Positions (4 tests)

| Test | Method | Pass |
|------|--------|------|
| portfolio_balance | GET /api/portfolio | .success == true |
| positions_open | GET /api/positions?action=open | .success == true |
| positions_summary | GET /api/positions?action=summary | .success == true |
| positions_history | GET /api/positions?action=history&limit=3 | .success == true |

### Group 10: Chart Data (4 tests)

| Test | Method | Pass |
|------|--------|------|
| chart_candles | GET /api/chart-data?action=candles&symbol=BTC/USDC&limit=10 | .candles is array |
| chart_pnl | GET /api/chart-data?action=pnl | .success == true |
| chart_patterns | GET /api/chart-data?action=patterns | .success == true |
| chart_signals | GET /api/chart-data?action=signals | .success == true |

### Group 11: Validation & Risk (4 tests)

| Test | Method | Pass |
|------|--------|------|
| validation_config | GET /api/validate-signal?action=config | .config exists |
| validation_stats | GET /api/validate-signal?action=stats | .success == true |
| validation_history | GET /api/validate-signal?action=history&limit=3 | .success == true |
| risk_config | GET /api/risk-check | HTTP 200, .data.config exists |

### Group 12: Journal & Analytics (3 tests)

| Test | Method | Pass |
|------|--------|------|
| journal | GET /api/analytics/journal?days=7 | .trades is array |
| costs | GET /api/costs | HTTP 200 |
| process_log | GET /api/process-log?limit=5 | .success == true |

### Group 13: Evolution & Calibration (3 tests)

| Test | Method | Pass |
|------|--------|------|
| evolution | GET /api/evolution | .success == true |
| calibration | GET /api/calibration | HTTP 200 |
| calibration_redis | redis GET calibration:patterns | JSON parseable or nil |

### Group 14: Grid & Scanner (3 tests)

| Test | Method | Pass |
|------|--------|------|
| grid_config | GET /api/grid-config | .success == true |
| scanner_history | GET /api/scanner-history?limit=3 | .success == true |
| scanner_redis | redis GET scanner:top_movers | JSON parseable or nil |

### Group 15: Sentiment & Agents (3 tests)

| Test | Method | Pass |
|------|--------|------|
| x_sentiment | GET /api/x-sentiment | HTTP 200 |
| agents_status | GET /api/agents | HTTP 200 |
| tank_status | GET /api/tanks/status?id=MarketScout | HTTP 200 |

### Group 16: Telegram Signals (2 tests)

| Test | Method | Pass |
|------|--------|------|
| telegram_endpoint | GET /api/telegram-signals | .success == true |
| telegram_redis | redis GET signals:telegram:active | JSON or nil |

### Group 17: Backtest API (3 tests)

| Test | Method | Pass |
|------|--------|------|
| backtest_list | GET /api/backtest?action=list | .success == true |
| backtest_status | GET /api/backtest?action=status&id=test | HTTP 200 or 404 (both valid) |
| backtest_results | GET /api/backtest?action=results&id=test | HTTP 200 or 404 |

### Group 18: Redis State (6 tests)

| Test | Method | Pass |
|------|--------|------|
| redis_ping | redis-cli PING | PONG |
| redis_positions | redis GET positions:open | JSON array or nil |
| redis_regime | redis GET market:regime | not empty |
| redis_portfolio | redis GET risk:portfolio_state | JSON parseable |
| redis_agent_status | redis KEYS "agent:*:status" | >= 1 key |
| redis_pending | redis LLEN trades:pending | integer >= 0 |

### Group 19: Postgres Schema (4 tests)

| Test | Method | Pass |
|------|--------|------|
| pg_connection | SELECT 1 | returns 1 |
| pg_core_tables | SELECT tablename FROM pg_tables | trades, signals, positions, position_history, evolution_runs exist |
| pg_signals_count | SELECT COUNT(*) FROM signals | >= 0 |
| pg_trades_count | SELECT COUNT(*) FROM trades | >= 0 |

### Group 20: WebSocket Server (3 tests)
Via inline Node.js using project's `ws` module.

| Test | Method | Pass |
|------|--------|------|
| ws_welcome | connect ws://localhost:3004, read first msg | .type == "WELCOME" |
| ws_ping | send {"type":"PING"}, read response | .type == "PONG" |
| ws_subscribe | send {"type":"SUBSCRIBE","rooms":["signals"]} | .type == "SUBSCRIBED" |

### Group 21: Binance API (3 tests)

| Test | Method | Pass |
|------|--------|------|
| binance_ticker | curl api.binance.com/api/v3/ticker/price?symbol=BTCUSDC | .price exists |
| binance_time | curl api.binance.com/api/v3/time | .serverTime exists |
| binance_balance | GET /api/portfolio | .data.totalValue > 0 |

### Group 22: Cron Jobs (4 tests)

| Test | Method | Pass |
|------|--------|------|
| cron_evolution | crontab -l | grep run_evolution.sh | found |
| cron_health | crontab -l | grep health-monitor.sh | found |
| cron_calibrate | crontab -l | grep calibrate.py | found |
| cron_ai_brain | crontab -l | grep ai_brain.py | found |

### Group 23: Config & TOML (3 tests)

| Test | Method | Pass |
|------|--------|------|
| toml_exists | test -f cryonix.toml | file exists |
| toml_parseable | python3 -c "import tomllib; ..." | no error |
| toml_sections | check for [trading], [risk], [exits], [indicators] | all present |

### Group 24: Reconciliation (3 tests)

| Test | Method | Pass |
|------|--------|------|
| no_phantoms | compare positions:open symbols vs Binance balance | all match |
| portfolio_sync | portfolio_state.total_capital > 0 | true |
| no_orphan_orders | Binance open orders count | 0 or matches tracked positions |

### Group 25: Orchestrator & Misc (3 tests)

| Test | Method | Pass |
|------|--------|------|
| orchestrator_status | GET /api/orchestrator/status | HTTP 200 |
| open_orders | GET /api/trade?symbol=BTC/USDC | HTTP 200 |
| instance_lock | redis GET instance:trading_lock | exists or nil (both valid) |

## Output Format

```
================================================================
  CRYONIX SYSTEM INTEGRATION TEST
  2026-02-19 12:00:00 UTC
================================================================

 #  Group                    Tests  Pass  Fail  Skip
 ─────────────────────────────────────────────────────
 01 Docker Infrastructure      5     5     0     0  ✓
 02 Health Endpoint             4     4     0     0  ✓
 03 Health Sub-services         3     3     0     0  ✓
 04 Python Engine Core          4     4     0     0  ✓
 05 Engine Backtest             3     3     0     0  ✓
 06 Auto-Trade Status           4     4     0     0  ✓
 07 Signals API                 3     3     0     0  ✓
 08 Market Data                 4     4     0     0  ✓
 09 Portfolio & Positions       4     4     0     0  ✓
 10 Chart Data                  4     4     0     0  ✓
 11 Validation & Risk           4     4     0     0  ✓
 12 Journal & Analytics         3     3     0     0  ✓
 13 Evolution & Calibration     3     3     0     0  ✓
 14 Grid & Scanner              3     3     0     0  ✓
 15 Sentiment & Agents          3     3     0     0  ✓
 16 Telegram Signals            2     2     0     0  ✓
 17 Backtest API                3     3     0     0  ✓
 18 Redis State                 6     6     0     0  ✓
 19 Postgres Schema             4     4     0     0  ✓
 20 WebSocket Server            3     3     0     0  ✓
 21 Binance API                 3     3     0     0  ✓
 22 Cron Jobs                   4     4     0     0  ✓
 23 Config & TOML               3     3     0     0  ✓
 24 Reconciliation              3     3     0     0  ✓
 25 Orchestrator & Misc         3     3     0     0  ✓
 ─────────────────────────────────────────────────────
 TOTAL                        88    85     2     1

 FAILURES:
 ✗ engine_backtest_quick: Timeout after 30s
 ✗ ws_subscribe: Connection reset on port 3004

 SKIPPED:
 ○ telegram_redis: No telegram data yet

 Runtime: 24s
================================================================
```

## Execution

```bash
chmod +x scripts/system-test.sh
./scripts/system-test.sh
```

- **Expected runtime**: 15-30 seconds (parallel groups, Binance rate limits are bottleneck)
- **Exit code 0**: All tests pass
- **Exit code 1**: Any test fails
- **Timeout**: 120s max for entire suite

## Reusability

- Run after every deploy (auto-deploy.sh can call it)
- Run after evolution mutations
- Add to CI/CD if needed
- Telegram notification on failures (optional future enhancement)
