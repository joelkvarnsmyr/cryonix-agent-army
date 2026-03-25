# scripts/services/

Long-running background services that run as Docker containers alongside the main web and engine services. Built via `Dockerfile.scripts` (root-level) into a lightweight Node.js 20 Alpine image.

## Files

| File | Description |
|------|-------------|
| `auto-trader.mjs` | Polls `POST /api/auto-trade` every 30s to process pending signals and monitor open positions. Logs buys, sells, rejections, and periodic P&L summaries. Waits up to 60s at startup for the web service to become available. |
| `ws-server.mjs` | WebSocket server for real-time dashboard updates. Manages client connections with room-based subscriptions (signals, trades, positions, prices, agents). Supports agent registration, heartbeat/timeout, and broadcast routing. Listens on port 3004. |
| `telegram-interactive.mjs` | Interactive Telegram bot (`@cryptonixis_bot`). Responds to commands (`/status`, `/positions`, `/trades`, `/pnl`, `/signals`, `/risk`, `/gainers`, `/audit`, `/evolve`, `/help`). Sends scheduled reports: morning brief (08:00 UTC), system audit (14:00 UTC), daily summary (22:00 UTC), pipeline health (every 15min), trade alerts (every 15s), and health alerts (every 5min). |
| `telegram-bot.mjs` | Telegram notification library for evolution reports. Exports `TelegramBot` class with methods for sending evolution start/result, performance reports, Claude mutation results, verification outcomes, and git commit notifications. Also usable as CLI: `node telegram-bot.mjs "message"`. |

## Docker

These services are built from `Dockerfile.scripts` at the repository root:

```dockerfile
FROM node:20-alpine
# Installs ws, pg, ioredis, dotenv
```

Container names (defined in `docker-compose.prod.yml`):

| Service | Container | Port |
|---------|-----------|------|
| auto-trader | `cryonix-auto-trader-1` | -- |
| ws-server | `cryonix-ws-server-1` | 3004 |
| telegram-bot | `cryonix-telegram-bot-1` | -- |

## Usage

```bash
# Build and start all script services
docker compose -f docker-compose.prod.yml up -d --build auto-trader ws-server telegram-bot

# View auto-trader logs
docker logs -f cryonix-auto-trader-1

# View WebSocket server logs
docker logs -f cryonix-ws-server-1
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_APP_URL` | Base URL for the web API (default: `http://web:3000`). |
| `WS_PORT` | WebSocket server port (default: `3004`). |
| `TELEGRAM_INTERACTIVE_BOT_TOKEN` | Token for the interactive Telegram bot. |
| `TELEGRAM_BOT_TOKEN` | Token for the evolution notification bot. |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for notifications. |
| `POSTGRES_URL` / `POSTGRES_PASSWORD` | Postgres connection (used by telegram-interactive). |
| `KV_URL` | Redis connection URL (used by telegram-interactive). |
