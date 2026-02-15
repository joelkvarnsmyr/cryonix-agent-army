# Cryonix Operations Guide

## Infrastructure Overview

```
                    Your Laptop (Dev)                     Azure VM (Prod, 24/7)
                    ────────────────                      ─────────────────────
                    pnpm dev (localhost:3000)              Docker Compose (8 containers)
                    Docker: engine, redis, postgres        Caddy reverse proxy on :80
                                                          Tailscale: openclaw-vm
```

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
| `0 */2 * * *`   | Evolution                    | `scripts/run_evolution.sh` — RE-ENABLED              |
| `*/15 * * * *`  | X sentiment                  | `scripts/strategy-lab/x_sentiment.py` — standalone Python |
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

### First-time setup on VM

```bash
# 1. SSH into the VM
ssh azureuser@openclaw-vm

# 2. Create project directory
mkdir -p ~/cryonix

# 3. Create .env file with real API keys
cat > ~/cryonix/.env << 'EOF'
POSTGRES_PASSWORD=password
BINANCE_API_KEY=your-key
BINANCE_API_SECRET=your-secret
XAI_API_KEY=xai-your-key
EOF

# 4. Copy code (from your laptop, since repo is private)
cd c:\Projects\Code\Crypto\cryonix-agent-army
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"

# 5. Build and start everything
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build"

# 6. Seed positions into Redis (if needed)
ssh azureuser@openclaw-vm "docker exec cryonix-redis-1 redis-cli SET 'position:BTC/USDC' '{...}'"
```

### Deploy updates (routine)

Run these commands from your laptop:

```bash
# 1. Push code to VM
cd c:\Projects\Code\Crypto\cryonix-agent-army
git archive --format=tar HEAD | ssh azureuser@openclaw-vm "cd ~/cryonix && tar xf -"

# 2a. Rebuild everything
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build"

# 2b. Or rebuild only specific containers (faster)
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build engine"
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml up -d --build web"
```

### Quick commands

```bash
# Check all containers
ssh azureuser@openclaw-vm "docker ps"

# View logs (follow)
ssh azureuser@openclaw-vm "docker logs -f cryonix-engine-1"
ssh azureuser@openclaw-vm "docker logs -f cryonix-auto-trader-1"
ssh azureuser@openclaw-vm "docker logs -f cryonix-web-1"

# Restart a single container
ssh azureuser@openclaw-vm "docker restart cryonix-engine-1"

# Stop everything
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml down"

# Stop everything AND delete data volumes (destructive!)
ssh azureuser@openclaw-vm "cd ~/cryonix && docker compose -f docker-compose.prod.yml down -v"

# Check Redis queue
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
   - MarketScout scans 15 USDC pairs every 10s via CCXT (Binance)
   - Detects patterns: RSI, Bollinger, Volume Spike, MACD, EMA Cross, Dip Buy
   - RiskGate approves signals with confidence >= 75%
   - Approved signals -> Redis approval queue

2. Auto-Trader (cryonix-auto-trader-1)
   - Polls GET /api/auto-trade every 30s
   - Reads pending signals from Redis queue
   - Filters: SPOT_ONLY (rejects SELL), min $5.50 order, max 2 open positions
   - GROK AI validates each signal (second opinion)
   - If approved: executes BUY on Binance via CCXT
   - Sets stop-loss, take-profit, trailing stop on position

3. Position Monitoring (also in auto-trader loop)
   - Checks live prices for open positions
   - Updates trailing stop (1% below high water mark)
   - Triggers stop-loss or take-profit exits
```

---

## Trading Configuration

| Parameter           | Value   | Description                         |
|---------------------|---------|-------------------------------------|
| TOTAL_CAPITAL       | $17     | Budget                              |
| MAX_POSITION_SIZE_PCT | 0.15  | 15% of capital per trade            |
| MIN_CONFIDENCE      | 75%     | Minimum signal confidence           |
| MAX_DAILY_LOSS      | 5%      | $0.85/day max loss                  |
| MAX_OPEN_POSITIONS  | 5       | Concurrent positions                |
| MAX_TRADES_PER_DAY  | 3       | Daily trade limit                   |
| MIN_ORDER_VALUE     | $5.50   | Binance minimum                     |
| TRAILING_STOP       | 1%      | Below high water mark               |
| SPOT_ONLY           | true    | Only BUY, never short-sell          |
| AI_VALIDATION       | true    | GROK AI second opinion on signals   |
| SIGNAL_POOL_PCT     | 0.65    | Capital allocated to signal trades  |
| GRID_POOL_PCT       | 0.25    | Capital allocated to grid trading   |
| RESERVE_PCT         | 0.10    | Capital held in reserve             |

### Scanned Pairs (15)

| Tier | Pairs                                   |
|------|-----------------------------------------|
| 1    | BTC/USDC, ETH/USDC, SOL/USDC           |
| 2    | BNB/USDC, XRP/USDC, AVAX/USDC, ADA/USDC, LINK/USDC |
| 3    | NEAR/USDC, DOGE/USDC, ARB/USDC, OP/USDC |
| 4    | SUI/USDC, ATOM/USDC, ICP/USDC          |

---

## Current Portfolio (2026-02-14)

| Asset | Amount   | Entry Price | Notes           |
|-------|----------|-------------|-----------------|
| BTC   | 0.00008  | $68,794     | +1.2% unrealized|
| ETH   | 0.0029   | $2,046      | +1.4% unrealized|
| BNB   | 0.0388   | -           | Fee reserve     |
| USDC  | 6.21     | -           | Trading reserve |

---

## Local Development

```bash
# Start infrastructure (Redis, Postgres, Python engine)
docker compose up -d

# Start Next.js + WebSocket server
pnpm dev                           # Next.js on :3000
npx ts-node apps/web/scripts/ws-server.ts  # WS on :3004

# Start auto-trader (optional, for testing)
npx ts-node apps/web/scripts/auto-trader.ts
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
    auto-trader.mjs          # Docker-compatible auto-trader (ESM)
    ws-server.mjs            # Docker-compatible WebSocket server (ESM)
  apps/web/
    src/app/page.tsx          # Dashboard UI
    src/app/api/auto-trade/   # Auto-trade API (GROK validation)
    src/app/api/health/       # Health check
    scripts/
      auto-trader.ts          # TypeScript auto-trader (local dev)
      ws-server.ts            # TypeScript WS server (local dev)
  packages/engine/
    src/main.py               # FastAPI entry point (starts tanks)
    src/tanks/market_scout.py # 15-pair scanner with QuantGuild patterns
    src/tanks/news_scout.py   # RSS sentiment analysis
    src/tanks/base.py         # BaseTank with LangGraph pipeline
    src/core/risk_gate.py     # Risk gate (confidence, position limits)
    src/core/risk_manager.py  # Advanced risk management
    src/core/state_sync.py    # Redis state sync
```

---

## Known Issues

All previously documented issues have been resolved (2026-02-14):
- Postgres schema: pushed (13 tables created)
- Health check: fixed (`ENGINE_URL` env var, 4/4 healthy)
- RSI calculation: fixed (clamped to [1, 99], no more false 0/100)

**Notes:**
- VM runs `openclaw` alongside Cryonix. Total memory ~870MB / 3.8GB available.
- Low-liquidity USDC pairs (OP, ARB, SUI) may show RSI at 1 or 99 due to thin candle data. This is real market data, not a bug.

---

## Backup

Postgres backup runs daily at **03:00 UTC** via `scripts/backup-postgres.sh`.

- Destination: `/home/azureuser/cryonix/backups/`
- Rotation: 7-day (older dumps auto-deleted)
- Cron: `0 3 * * *`
