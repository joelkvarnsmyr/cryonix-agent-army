# Cryonix Operations Guide

## Infrastructure Overview

```
  Your Laptop (Dev)                           Azure VM (Prod, 24/7)
  ──────────────────                          ─────────────────────
  docker compose up (local containers)        docker compose -f docker-compose.prod.yml
  CRYONIX_ENV=development                     CRYONIX_ENV=production
  BINANCE_TESTNET=true                        BINANCE_TESTNET=false
  ⛔ Orders BLOCKED (env guard)               ✅ Real Binance execution
  ⛔ Signals NOT queued to Redis              ✅ Signals → Redis → auto-trader
  ✅ Engine scans + analysis (read-only)      ✅ Full pipeline active
  ✅ Postgres signal logging                  ✅ Cron: evolution, calibration, backup
  Own Redis + Postgres (isolated)             Own Redis + Postgres (production data)
```

### Environment Isolation (CRITICAL)

The system uses `CRYONIX_ENV` as a hard execution guard:

| Guard Location | What it blocks | Env var check |
|---|---|---|
| `executeBuy()` in auto-trade | Real BUY orders on Binance | `CRYONIX_ENV !== 'production'` |
| `executeMarginSell()` | Real SELL orders on Binance | `CRYONIX_ENV !== 'production'` |
| `monitorPositions()` sell path | Real position exits | `CRYONIX_ENV !== 'production'` |
| `execute_order()` in base.py | Signal queuing to Redis | `settings.is_production == False` |

**Local Docker** (`docker-compose.yml`) sets:
- `CRYONIX_ENV=development` → all execution blocked
- `BINANCE_TESTNET=true` → CCXT points to testnet if accidentally called

**Production Docker** (`docker-compose.prod.yml`) sets:
- `CRYONIX_ENV=production` → execution enabled
- `BINANCE_TESTNET=false` → real Binance

⚠️ **Never copy `.env` with prod API keys to your laptop's Docker.** Local Docker uses its own isolated Redis + Postgres and cannot execute real trades regardless, but API keys should stay on the VM.

### Azure VM

| Property       | Value                                      |
|----------------|--------------------------------------------|
| Name           | `vm-openclaw` (Resource Group: `RG-CLAW`)  |
| Size           | `Standard_B2pls_v2` (2 vCPU ARM64, 4GB RAM)|
| Tailscale name | `openclaw-vm`                              |
| Tailscale IP   | `100.81.85.80`                             |
| DNS            | `openclaw-vm.taila1abdb.ts.net`            |
| SSH            | `ssh azureuser@openclaw-vm`                |
| Project dir    | `~/cryonix`                                |

---

## Cron Jobs (Active)

| Schedule         | Job                          | Details                                              |
|------------------|------------------------------|------------------------------------------------------|
| `* * * * *`     | **Auto-deploy**              | `scripts/auto-deploy.sh` — pulls origin/main, rebuilds if new commits |
| `0 */2 * * *`   | Evolution                    | `scripts/run_evolution.sh` — RE-ENABLED              |
| `*/15 * * * *`  | X sentiment                  | `scripts/strategy-lab/x_sentiment.py` — standalone Python |
| `*/5 * * * *`   | Health monitor               | `scripts/health-monitor.sh` — container health + alerts |
| `0 */6 * * *`   | Calibration                  | `scripts/strategy-lab/calibrate.py --days 30`        |
| `0 3 * * *`     | Postgres backup              | `scripts/backup-postgres.sh` — 7-day rotation        |
| `0 6 * * *`     | Morning report               | `scripts/strategy-lab/run.sh`                        |

---

## Web GUIs & Endpoints

### Dashboard (Next.js)

| Environment | URL                              |
|-------------|----------------------------------|
| Production  | `http://openclaw-vm`             |
| Production  | `http://100.81.85.80`            |
| Local dev   | `http://localhost:3000`          |

The dashboard has a 3-column layout:

- **Left sidebar**: Value stats, Tank monitor, Portfolio summary, AI Signals
- **Center**: Risk Gate approval queue, TradingView chart (BTC/USDT)
- **Right sidebar**: Quick Trade, Active Positions

### API Endpoints

All available at `http://openclaw-vm/api/...` (prod) or `http://localhost:3000/api/...` (dev):

| Endpoint                    | Method     | Description                                    |
|-----------------------------|------------|------------------------------------------------|
| `/api/auto-trade`           | GET / POST | Auto-trader status (incl. `budget` capital allocation) & trigger trade execution |
| `/api/health`               | GET        | System health (Redis, Postgres, Engine, Scout) |
| `/api/portfolio`            | GET        | Portfolio balances from Binance                |
| `/api/positions`            | GET        | Open positions with live P&L                   |
| `/api/signals`              | GET / POST | Trading signals (from DB)                      |
| `/api/market`               | GET        | Market data                                    |
| `/api/risk`                 | GET        | Risk manager status                            |
| `/api/risk-check`           | POST       | Run risk check on a signal                     |
| `/api/validate-signal`      | POST       | GROK AI validation of a signal                 |
| `/api/trade`                | POST       | Execute a trade on Binance                     |
| `/api/tanks/status`         | GET        | Python engine tank statuses                    |
| `/api/tanks/approvals`      | GET        | Pending approval queue from Redis              |
| `/api/agents`               | GET / POST | TypeScript agent statuses / start-stop         |
| `/api/orchestrator/start`   | POST       | Start orchestrator                             |
| `/api/orchestrator/stop`    | POST       | Stop orchestrator                              |
| `/api/orchestrator/status`  | GET        | Orchestrator status                            |
| `/api/chat`                 | POST       | Chat with GROK AI assistant                    |
| `/api/analyze`              | POST       | AI market analysis                             |
| `/api/backtest`             | POST       | Run backtest                                   |
| `/api/calibration`          | POST       | Pattern EV calibration                         |
| `/api/x-sentiment`          | POST       | X/Twitter sentiment scanning                   |

### WebSocket

| Environment | URL                              |
|-------------|----------------------------------|
| Production  | `ws://openclaw-vm/ws`            |
| Local dev   | `ws://localhost:3004`            |

Real-time events: agent status, signals, trades, portfolio updates.

### Python Engine (internal)

| Environment | URL                                   |
|-------------|---------------------------------------|
| Production  | `http://engine:8000` (Docker internal)|
| Local dev   | `http://localhost:8000`               |

Not exposed externally in production. Only accessible from other containers on `cryonix-net`.

---

## Docker Containers (Production)

```
docker compose -f docker-compose.prod.yml ps
```

| Container       | Image                  | Ports         | Role                                  |
|-----------------|------------------------|---------------|---------------------------------------|
| `cryonix-postgres-1`  | postgres:15-alpine | (internal)    | Database (persistent volume)          |
| `cryonix-redis-1`     | redis:7-alpine     | (internal)    | Signal queue, state, sentiment cache  |
| `cryonix-engine-1`    | custom (Python)    | 8000 internal | MarketScout + NewsScout scanning      |
| `cryonix-web-1`       | custom (Next.js)   | 3000 internal | Dashboard + API routes                |
| `cryonix-auto-trader-1`| custom (Node)     | none          | Polls /api/auto-trade every 30s       |
| `cryonix-ws-server-1` | custom (Node)      | 3004          | WebSocket for real-time dashboard     |
| `cryonix-telegram-bot-1`| custom (Node)    | none          | Telegram bot for evolution reports    |
| `cryonix-caddy-1`     | caddy:2-alpine     | 80            | Reverse proxy, routes /ws to ws-server|

---

## Deploy Process

### Auto-deploy (active — cron pull-based)

A cron job runs every minute and checks if `origin/main` has new commits. If yes, it pulls and rebuilds automatically.

```
git push → (within 60s) → VM fetches → git reset --hard → docker compose build → health check
```

- Script: `scripts/auto-deploy.sh`
- Lock file: `/tmp/cryonix-deploy.lock` (prevents concurrent deploys, auto-clears after 15min)
- Log: `/tmp/auto-deploy.log`
- Stale lock protection: locks older than 900s are auto-removed

**To deploy:** just `git push origin main` from anywhere. No SSH needed.

### Manual deploy (fallback)

```bash
# From laptop: push changes
git add -A && git commit -m "feat: ..." && git push

# If auto-deploy is broken, SSH in and run manually:
ssh azureuser@openclaw-vm "bash ~/cryonix/scripts/deploy-vm.sh"
```

### Rebuild specific containers

```bash
# Just web (API + dashboard changes)
docker compose -f docker-compose.prod.yml up -d --build --no-deps web

# Just engine (Python quant/scanner changes)
docker compose -f docker-compose.prod.yml up -d --build --no-deps engine

# Everything
docker compose -f docker-compose.prod.yml up -d --build
```

### Quick commands (from laptop via SSH)

```bash
# SSH to VM
ssh azureuser@openclaw-vm

# Check containers
ssh azureuser@openclaw-vm "docker ps --format 'table {{.Names}}\t{{.Status}}'"

# View logs
ssh azureuser@openclaw-vm "docker logs -f cryonix-engine-1"
ssh azureuser@openclaw-vm "docker logs -f cryonix-auto-trader-1"
ssh azureuser@openclaw-vm "docker logs -f cryonix-web-1"

# Restart a container
ssh azureuser@openclaw-vm "docker restart cryonix-engine-1"

# Check Redis
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli KEYS '*'"
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli LRANGE trades:pending 0 -1"

# Check system health
curl http://openclaw-vm/api/health
curl http://openclaw-vm/api/auto-trade
```

---

## Signal Flow (How trades happen)

```
1. Python Engine (cryonix-engine-1)
   - MarketScout scans 45 USDC pairs every 10s via CCXT (Binance)
   - 9 pattern detectors: RSI, Bollinger, Volume, MACD, EMA, Dip, Deep Value, Momentum Gainer
   - ADX regime detection → written to Redis (market:regime)
   - SELL signals skipped early (spot-only mode)
   - RiskGate approves signals with confidence >= 65%
   - Approved signals → Redis pending queue
   - [DEV MODE: signals logged but NOT queued]

2. Auto-Trader (cryonix-auto-trader-1)
   - Polls GET /api/auto-trade every 30s
   - Queue trim: if pending > 30, oldest signals dropped (logged)
   - Top-15 signals processed per cycle (sorted by confidence)
   - Capital Allocator checks budget (signal pool vs grid pool vs reserve)
   - Regime check: volatile → grid paused
   - EV model filter (reject negative-EV patterns, min 5 trades)
   - X sentiment alert check (12 keywords: hack, exploit, delist, scam...)
   - GROK AI validates (pragmatic prompt, fail-closed on parse error)
   - Order book spread check (max 0.3%)
   - NOTIONAL check: buy value must be >= 1.5x pair's Binance minimum
   - Binance BUY (spot) + native STOP_LOSS_LIMIT order
   - Position monitor (30s: SL/TP/trailing stop with persistence)
   - Live P&L persisted to Redis (pnlPct, currentPrice) for Telegram
   - [DEV MODE: all execution blocked]

3. Position Monitoring (also in auto-trader loop)
   - Checks live prices for open positions
   - Updates trailing stop (3% below high water mark) — persisted to Redis
   - Cancels native SL before software-side exit (prevent double execution)
   - Triggers stop-loss or take-profit exits
   - NOTIONAL dust handling: if sell fails due to NOTIONAL filter,
     position is written off as dust (removed from tracking, loss recorded,
     archived with closeReason=DUST_NOTIONAL)
```

---

## Trading Configuration

| Parameter           | Value   | Description                         |
|---------------------|---------|-------------------------------------|
| TOTAL_CAPITAL       | dynamic | Fetched from Binance every 5min     |
| MAX_POSITION_SIZE_PCT | 0.15  | 15% of capital per trade            |
| MIN_CONFIDENCE      | 65%     | Minimum signal confidence           |
| MAX_DAILY_LOSS      | 5%      | Daily loss circuit breaker          |
| MAX_OPEN_POSITIONS  | 5       | Total concurrent positions          |
| MAX_SIGNAL_POSITIONS| 4       | Signal strategy positions           |
| MAX_GRID_POSITIONS  | 2       | Grid strategy positions             |
| MAX_TRADES_PER_DAY  | 6       | Daily trade limit                   |
| MIN_ORDER_VALUE     | $1.00   | Global floor (actual: 1.5x pair's Binance NOTIONAL) |
| TRAILING_STOP       | 3%      | Below high water mark               |
| SPOT_ONLY           | true    | Only BUY, never short-sell          |
| AI_VALIDATION       | true    | GROK AI (fail-closed)               |
| SIGNAL_POOL_PCT     | 0.65    | 65% capital → signal trades         |
| GRID_POOL_PCT       | 0.25    | 25% capital → grid trading          |
| RESERVE_PCT         | 0.10    | 10% always held in reserve          |

### Scanned Pairs (45)

| Tier | Pairs |
|------|-------|
| 1 | BTC, ETH, SOL, BNB, XRP |
| 2 | AVAX, ADA, LINK, DOT, POL, NEAR, ARB, OP, SUI, ATOM |
| 3 | FET, RENDER, INJ, TIA, SEI, JUP, WLD, ICP, APT, FIL |
| 4 | AAVE, UNI, LDO, TAO, CRV, DYDX, STX, IMX, ALGO |
| 5 | DOGE, SHIB, PEPE, BONK, FLOKI, WIF, 1000SATS, ANIME |
| 6 | AIXBT, ARKM, PYTH, JTO, STRK, MANTA |

---

## Current Portfolio (2026-02-15)

Portfolio is dynamic — check live state via:
```bash
docker exec cryonix-redis-1 redis-cli GET positions:open
docker exec cryonix-redis-1 redis-cli GET risk:portfolio_state
curl http://openclaw-vm/api/portfolio
```

**Capital:** ~$17 | **Positions tracked in Redis** `positions:open`

---

## 🖥️ Remote Development (VM — Copilot Agent)

The Azure VM is where production runs and where Copilot agents work. You interact with it via SSH or through Copilot CLI.

### What runs here

| Component | How | Persistent |
|---|---|---|
| 8 Docker containers | `docker-compose.prod.yml` | Yes — `restart: always` |
| Evolution pipeline | Cron every 2h | Yes |
| X sentiment scanning | Cron every 15min | Yes |
| Calibration | Cron every 6h | Yes |
| Postgres backup | Cron daily 03:00 UTC | Yes |
| Morning report | Cron daily 06:00 UTC | Yes |

### Copilot agent workflow

Copilot agents (like me) run directly on the VM and can:
- Edit code, run builds, deploy containers
- Read logs, query Redis/Postgres, check Binance state
- Run evolution, calibration, diagnostics
- Commit and push to GitHub

```bash
# Typical agent workflow
cd ~/cryonix
git pull                                    # Sync latest
# ... make changes ...
docker compose -f docker-compose.prod.yml up -d --build --no-deps web engine
git add -A && git commit -m "feat: ..." && git push
```

### Monitoring from laptop

```bash
# Dashboard
open http://openclaw-vm              # or http://100.81.85.80

# API health
curl http://openclaw-vm/api/auto-trade | jq '.budget'
curl http://openclaw-vm/api/health

# Live logs
ssh azureuser@openclaw-vm "docker logs -f cryonix-auto-trader-1"

# Strategy Lab morning report
ssh azureuser@openclaw-vm "cat ~/cryonix/logs/strategy-lab/report-$(date +%Y-%m-%d).txt"

# Evolution log
ssh azureuser@openclaw-vm "tail -50 /tmp/evolution-cron.log"
```

---

## 💻 Local Development (Laptop)

Local Docker runs the full stack but with **execution guards** — no real orders can hit Binance.

### What's different from production

| Aspect | Local (`docker-compose.yml`) | Production (`docker-compose.prod.yml`) |
|---|---|---|
| `CRYONIX_ENV` | `development` | `production` |
| `BINANCE_TESTNET` | `true` | `false` |
| Order execution | ⛔ **BLOCKED** | ✅ Live Binance |
| Signal queuing | ⛔ Logged but not queued | ✅ Queued to Redis |
| Engine scanning | ✅ Real market data (read-only) | ✅ Real market data |
| Postgres logging | ✅ Signals saved for analysis | ✅ Full trade history |
| Redis | Own isolated instance | Own isolated instance |
| Postgres | Own isolated instance | Own isolated instance |
| Containers | 3 (engine, redis, postgres) | 8 (+ web, auto-trader, ws, telegram, caddy) |

### Getting started

```bash
# 1. Clone (if not already)
git clone https://github.com/joelkvarnsmyr/cryonix-agent-army.git
cd cryonix-agent-army

# 2. Install dependencies
pnpm install

# 3. Create local .env (NO prod API keys!)
cat > apps/web/.env.local << 'EOF'
KV_URL=redis://localhost:6379
POSTGRES_URL=postgres://postgres:password@localhost:5432/cryonix
BINANCE_API_KEY=           # Leave empty or use testnet key
BINANCE_API_SECRET=        # Leave empty or use testnet key
BINANCE_TESTNET=true
CRYONIX_ENV=development
XAI_API_KEY=               # Optional: for AI validation testing
EOF

# 4. Start infrastructure (engine + redis + postgres)
docker compose up -d

# 5. Start Next.js dashboard
pnpm dev                              # http://localhost:3000

# 6. (Optional) Start WebSocket server
npx ts-node apps/web/scripts/ws-server.ts   # ws://localhost:3004

# 7. (Optional) Start auto-trader loop (safe — orders blocked)
npx ts-node apps/web/scripts/auto-trader.ts
```

### Full local Docker (all 8 containers)

If you want to run the full prod-like stack locally (but with guards):

```bash
# Use the dev compose (CRYONIX_ENV=development baked in)
docker compose up -d --build

# Or override prod compose with dev env:
CRYONIX_ENV=development BINANCE_TESTNET=true \
  docker compose -f docker-compose.prod.yml up -d --build
```

⚠️ **Never put prod Binance API keys in local `.env`** — the execution guards will block orders regardless, but keys should only exist on the VM.

### What you can do locally

✅ **Safe to do:**
- Develop dashboard UI (`pnpm dev`)
- Edit API routes and test endpoints
- Watch engine scan real market data
- See signals generated (logged to Postgres)
- Test AI validation prompts (needs XAI_API_KEY)
- Run Strategy Lab scripts against local DB
- Run `pnpm build` to check for TypeScript errors

⛔ **Cannot do (by design):**
- Execute real trades on Binance
- Queue signals for auto-trader execution
- Place stop-loss orders
- Sell/exit positions

### Claude Code / Copilot on laptop

When running Copilot or Claude Code locally, it can:
- Edit code and run builds
- Test against local Docker
- Push changes to GitHub (then VM pulls + deploys)

Typical local agent workflow:
```bash
# Edit code, test locally
pnpm build                            # Type-check
docker compose up -d --build           # Rebuild engine

# Push for production
git add -A && git commit -m "feat: ..." && git push

# Then on VM (or via Copilot on VM):
# git pull && docker compose -f docker-compose.prod.yml up -d --build --no-deps web engine
```

### Local Caddy (optional)

If using the local Caddy setup at `C:\Projects\Code\.dev\Caddyfile`:

| Domain              | Target          |
|---------------------|-----------------|
| `cryonix.local`     | localhost:3060  |
| `cryonix-ws.local`  | localhost:3064  |

Requires entries in `C:\Windows\System32\drivers\etc\hosts`:
```
127.0.0.1 cryonix.local cryonix-ws.local
```

---

## File Structure (Key files)

```
cryonix-agent-army/
  Dockerfile                 # Multi-stage Next.js build
  Dockerfile.scripts         # Lightweight auto-trader + ws-server
  docker-compose.yml         # Local dev (engine, redis, postgres)
  docker-compose.prod.yml    # Production (8 containers)
  Caddyfile                  # Reverse proxy config
  .env.prod                  # Template for production env vars
  scripts/
    auto-deploy.sh           # Cron pull-based auto-deploy (every 1min)
    deploy-vm.sh             # Manual deploy script (runs on VM)
    auto-trader.mjs          # Docker-compatible auto-trader (ESM)
    ws-server.mjs            # Docker-compatible WebSocket server (ESM)
    telegram-interactive.mjs # Interactive Telegram bot (@cryptonixis_bot)
    telegram-bot.mjs         # Evolution report bot (@cryonixEvolution_bot)
    health-monitor.sh        # Container health monitor (cron every 5min)
    strategy-lab/
      calibrate.py           # Pattern EV calibration (--days 30)
      x_sentiment.py         # X/Twitter sentiment scanner (standalone)
      morning_report.py      # Daily strategy report
      engine_diagnostik.py   # Engine health diagnostics
      backtest_momentum.py   # Momentum gainer backtesting
  apps/web/
    src/app/page.tsx          # Dashboard UI
    src/app/api/auto-trade/   # Auto-trade API (GROK validation + execution)
    src/app/api/health/       # Health check
  packages/engine/
    src/main.py               # FastAPI entry point (starts tanks)
    src/tanks/market_scout.py # 45-pair scanner with QuantGuild patterns
    src/tanks/gainer_scanner.py # Momentum gainer detection
    src/tanks/news_scout.py   # RSS sentiment analysis
    src/tanks/base.py         # BaseTank with LangGraph pipeline
    src/core/market_data.py   # CCXT wrapper (singleton, multi-TF cache)
    src/core/risk_gate.py     # Risk gate (confidence, position limits)
    src/core/risk_manager.py  # Risk management (uses singleton market_data)
    src/core/state_sync.py    # Redis state sync
    src/guilds/quant.py       # QuantGuild: all technical analysis
```

---

## Telegram Bots

| Bot | Handle | Purpose |
|-----|--------|---------|
| Interactive | `@cryptonixis_bot` | Pipeline health, /status, /report, /positions |
| Evolution   | `@cryonixEvolution_bot` | Automated evolution reports |

### Interactive bot reports include:
- Portfolio state (capital, cash %, day P&L)
- Live P&L per open position (color-coded)
- Signal funnel metrics (24h signals → trades, conversion %)
- Pipeline health (queue depth, trades/hour)

---

## Known Issues & Fixes (2026-02-15)

### Resolved
- Postgres schema: pushed (13 tables created)
- Health check: fixed (`ENGINE_URL` env var, 4/4 healthy)
- RSI calculation: fixed (clamped to [1, 99], no more false 0/100)
- **CCXT connection leak**: Engine crashed every ~70min due to leaked `MarketDataFetcher()` and `spot_exchange` instances. Fixed with singleton pattern.
- **NOTIONAL dust positions**: Positions below Binance's minimum sell value got stuck in infinite retry loop. Now auto-written-off as dust with loss recorded.
- **Telegram P&L always 0%**: `pnlPct` and `currentPrice` now persisted to Redis during monitoring.
- **Signal pipeline 0.036% conversion**: Fixed queue trim logging, top-N 5→15, softened GROK AI prompt.

### Notes
- VM runs `openclaw` alongside Cryonix. Total memory ~870MB / 3.8GB available.
- Low-liquidity USDC pairs (OP, ARB, SUI) may show RSI at 1 or 99 due to thin candle data. This is real market data, not a bug.
- Auto-deploy log: `cat /tmp/auto-deploy.log`

---

## Backup

Postgres backup runs daily at **03:00 UTC** via `scripts/backup-postgres.sh`.

- Destination: `/home/azureuser/cryonix/backups/`
- Rotation: 7-day (older dumps auto-deleted)
- Cron: `0 3 * * *`
