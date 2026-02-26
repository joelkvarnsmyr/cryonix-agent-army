# Cryonix System Health Report

**Date:** 2026-02-16
**Trigger:** Post DUST_NOTIONAL fix deployment + full system audit
**Overall:** 5 PASS, 7 WARN, 1 FAIL

---

## Summary

| Area | Status | Critical Issues |
|------|--------|----------------|
| Infrastructure | WARN | Web container `unhealthy` (curl missing), disk 77%, memory 60% |
| Data Integrity | WARN | 13 stale FILLED trades in Postgres, positions:open is string not set |
| Trading System | PASS | All 5 DUST_NOTIONAL changes deployed and verified |
| Workers & Services | WARN | Caddy 502s during web restart, no systemd evolution timer |
| Code & Build | WARN | Web healthcheck FAIL (curl not in image), 3 uncommitted files |

---

## Agent 1: Infrastructure

| Test | Status | Detail |
|------|--------|--------|
| Docker containers (9) | PASS | 9/9 Up; postgres/redis healthy |
| Health API | PASS | All 4 services healthy (Redis 9ms, Postgres 8ms, Engine 163ms, Binance 288ms) |
| Auto-trade API | PASS | HTTP 200 |
| WebSocket server | PASS | HTTP 400 (expected -- WS upgrade required) |
| Disk space | WARN | 77% used (22G/29G, 6.6G free) |
| Memory | WARN | 60% used (2.3Gi/3.8Gi, 1.5Gi available) |
| Container resources | WARN | engine 378MiB, web 317MiB -- top consumers on 3.8Gi host |
| Web container health | FAIL | `unhealthy` despite /api/health returning green |

---

## Agent 2: Data Integrity

| Test | Status | Detail |
|------|--------|--------|
| Redis connectivity | PASS | PONG |
| Redis open positions | WARN | 2 positions (MANTA, TAO) stored as JSON string, not Redis set |
| Redis pending trades | PASS | Queue empty (0) |
| Redis calibration data | PASS | 8 patterns calibrated 2026-02-15 |
| Redis sentiment data | PASS | 16 sentiment keys (BTC, ETH, SOL, etc.) |
| Postgres connectivity | PASS | OK |
| Postgres trades | PASS | 32 total (15 FILLED, 17 CLOSED) |
| Postgres signals | PASS | 25,689 signals |
| Position history | WARN | 4 archived -- all DUST_NOTIONAL |
| Redis/Postgres consistency | WARN | 13 stale FILLED trades in Postgres not in Redis |

### Open Positions

| Symbol | Entry | Current | P&L % | Pattern |
|--------|-------|---------|-------|---------|
| MANTA/USDC | $0.0807 | $0.0802 | -0.62% | BOLLINGER_SQUEEZE |
| TAO/USDC | $188.30 | $186.60 | -0.90% | BOLLINGER_SQUEEZE |

### Data Issues

- **13 stale FILLED trades** in Postgres (CRV, WIF, PYTH, AIXBT, SOL, ATOM, POL, BNB, LINK, SEI, ETH) -- closed in Redis but Postgres status never updated to CLOSED
- **Duplicate BNB/USDC** entries at $635.43 opened 23ms apart -- race condition
- **trades:daily_pnl / daily_count** are nil -- counters not maintained

---

## Agent 3: Trading System

| Test | Status | Detail |
|------|--------|--------|
| Auto-trade API | PASS | active, cycle 2310, 2 positions monitored |
| DUST_NOTIONAL config (7.50) | PASS | Line 55 confirmed |
| DUST_NOTIONAL all 5 changes | PASS | All 5 found in source |
| Binance positions API | PASS | Responding |
| Portfolio balance | PASS | Total $40.50 (USDC $0.64, BNB $19.39, MANTA $10.26, TAO $10.21) |
| Risk state | PASS | Circuit breaker inactive, 0 consecutive losses |
| Auto-trader worker | PASS | Polling active, cycle 2310 |

### DUST_NOTIONAL Verification

| Change | Status | Location |
|--------|--------|----------|
| 1. MIN_ORDER_VALUE: 7.50 | FOUND | Line 55 |
| 2. pairMinNotional fallback 5.0 | FOUND | Line 1286 |
| 3. Post-rounding check | FOUND | Lines 1276-1279 |
| 4. Dust prevention exit | FOUND | Lines 596-603 |
| 5. CONFIG.MIN_ORDER_VALUE in sizing | FOUND | Line 1233 |

### Capital Budget (Regime: Ranging)

- Signal pool: $26.31 budget, $20.60 used, $5.72 remaining
- Grid pool: $10.12 budget, $0.00 used, $10.12 remaining
- Reserve: $4.05

---

## Agent 4: Workers & Services

| Service | Status | Detail |
|---------|--------|--------|
| Python engine | PASS | Healthy, scanning 45 pairs, RiskGate active |
| WebSocket server | PASS | Up 19h, ws://0.0.0.0:3004 |
| Telegram bot | PASS | Connected, scheduled reports active |
| Telegram scraper | PASS | Channel quality refreshing hourly |
| Caddy proxy | WARN | 502 errors during web restart |
| Evolution timer | WARN | No systemd timer; runs via cron every 2h |
| Cron jobs | PASS | 7 active: evolution, x-sentiment, calibration, backup, strategy-lab, health-monitor, auto-deploy |

---

## Agent 5: Code & Build

| Test | Status | Detail |
|------|--------|--------|
| Git status | WARN | 3 uncommitted (tsconfig.tsbuildinfo, backtest.py, backups/) |
| TypeScript types | PASS | tsc --noEmit clean, 0 errors |
| Deployed DUST_NOTIONAL | PASS | Confirmed in compiled route.js |
| Reconciliation code | PASS | reconcilePositions/PHANTOM/Dust prevention in build |
| Node.js version | PASS | v22.22.0 LTS, pnpm 9.15.0 |
| Docker images | PASS | web 312MB, engine 1.32GB |
| Web error logs | PASS | 0 errors |
| Web healthcheck | FAIL | curl not in Alpine image, FailingStreak: 17 |

---

## Action Items (Priority Order)

### Critical

1. **Fix web healthcheck** -- Dockerfile uses `curl` but Alpine image only has `wget`. Switch to `wget -q --spider http://localhost:3000/api/health` or install curl.

### High

2. **Clean stale Postgres trades** -- 13 FILLED trades should be CLOSED. Write migration or one-time script.
3. **Fix duplicate order race condition** -- BNB/USDC double-buy (23ms apart). Add dedup guard in executeBuy().

### Medium

4. **Disk space** -- 77% used. Clean old Docker images: `docker image prune -a`
5. **Memory** -- 60% on 3.8Gi host. Monitor for OOM. Engine uses 378MiB.
6. **Daily PnL counters** -- `trades:daily_pnl` and `trades:daily_count` are nil. Verify reset logic.

### Low

7. **Git cleanup** -- Add `tsconfig.tsbuildinfo` to .gitignore, commit backtest.py changes
8. **Evolution timer** -- Consider migrating cron to systemd timer for better observability
9. **positions:open key type** -- Current string serialization works but is non-standard
