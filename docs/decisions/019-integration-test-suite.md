# ADR-019: Comprehensive Integration Test Suite
**Date:** 2026-02-19 | **Status:** Active

**Origin:** `docs/plans/2026-02-19-system-test-design.md`

### Context (Why)

Cryonix is a production autonomous trading system with 8 Docker services, 29 Next.js API routes, 14 Python engine endpoints, 19 Postgres tables, 79+ Redis keys, 8 cron jobs, a WebSocket server, Telegram bots, and Binance integration. The system evolved rapidly with no automated way to verify all components work correctly after deploys, evolution mutations, or infrastructure changes. Manual verification was slow, incomplete, and error-prone.

### Decision (What)

A single Bash script (`scripts/system-test.sh`, ~500 lines) that runs 25 test groups (~82 tests) in parallel, covering the full system stack.

Key design choices:

- **Pure Bash**: Zero dependencies beyond curl, jq, redis-cli (via docker exec), psql (via docker exec), docker, node. No npm install, no build step.
- **Parallel execution**: 25 test groups run as background subshells, results collected via temp files. Expected runtime 15-30 seconds.
- **Read-only safety guards**: Strict exclusion list of endpoints that must NEVER be called by tests: `POST /api/auto-trade` (executes real trades), `POST /api/signals` (creates signals), `POST /api/analyze` (burns GROK tokens), `POST /api/x-sentiment` (burns GROK tokens), `POST /api/grid-config` (burns GROK tokens), `POST /api/tanks/approvals` (moves queue), and any destructive orchestrator endpoints.
- **Docker exec for internal services**: Engine has no host port in prod; Redis/Postgres accessed via docker exec for reliability.
- **Inline Node.js for WebSocket**: Tests WS welcome, ping/pong, and subscribe using the project's `ws` module.

Test coverage spans: Docker infrastructure, health endpoints, Python engine core + backtest, auto-trade status (GET only), signals/market/portfolio/chart APIs, validation/risk, journal/analytics, evolution/calibration, grid/scanner, sentiment/agents, Telegram signals, Redis state (6 key checks), Postgres schema (table existence + counts), WebSocket server, Binance API, cron jobs, TOML config, reconciliation (phantom positions, orphan orders), and orchestrator status.

### Consequences (How)

- **Positive**: Full system verification in under 30 seconds after any deploy. Can be integrated into auto-deploy pipeline, evolution post-mutation checks, and CI/CD.
- **Positive**: Safety guards prevent tests from executing trades, burning API tokens, or modifying system state. The test suite is safe to run against production.
- **Trade-off**: Bash-only means no mocking, no unit-level isolation. These are true integration tests that require all 8 Docker containers running. Not suitable for local development without the full stack.
- **Trade-off**: Test assertions are shallow (HTTP 200 + JSON field existence) rather than deep behavioral validation. Catches infrastructure failures and API contract breakage, not business logic bugs.
- **Exit codes**: 0 = all pass, 1 = any failure. 120s global timeout. Color-coded output (green PASS, red FAIL, yellow SKIP) with summary table.
