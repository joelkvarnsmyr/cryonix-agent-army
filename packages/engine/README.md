# @cryonix/engine

Python 3.11 FastAPI service that serves as the market scanning and analysis brain of the Cryonix trading system. Runs in Docker and communicates with the Next.js app via Redis queues and HTTP callbacks.

## Files / Structure

```
Dockerfile                  # Python 3.11-slim, Poetry install, uvicorn entrypoint
pyproject.toml              # Poetry dependencies (FastAPI, CCXT, LangGraph, pandas, numpy)
package.json                # pnpm scripts (dev, start, build=noop for Docker)
src/
  main.py                   # FastAPI app with lifespan (starts all tank loops)
  api/
    router.py               # REST endpoints: /health, /tanks/status, /backtest
  core/
    config.py               # Pydantic settings + TOML config loader
    market_data.py           # CCXT wrapper with caching, multi-timeframe OHLCV
    risk_gate.py             # Confidence threshold + risk checks before queueing
    risk_manager.py          # Full risk management logic (Python side)
    state_sync.py            # Redis state manager (read/write tank state, signal queues)
  tanks/
    base.py                  # BaseTank: LangGraph pipeline (scan -> analyze -> risk -> execute)
    market_scout.py          # MarketScoutTank: scans 45 USDC pairs every 10s
    news_scout.py            # NewsScoutTank: RSS sentiment analysis every 15min
    gainer_scanner.py        # GainerScanner: top mover detection for confidence boost
  guilds/
    quant.py                 # QuantGuild: technical analysis + 8 pattern detectors
    grid.py                  # Grid trading strategy logic
    oracle.py                # AI oracle interface
  models/
    analysis.py              # Pydantic request/response models
  backtest/
    engine.py                # Python-side backtesting engine
```

## Key Components

### MarketScoutTank

The primary scanning agent. Monitors 45 USDC pairs across 6 tiers (core, major alts, AI/DeFi, mid-cap, meme, emerging). Every 10 seconds it:

1. Fetches 15m OHLCV candles via CCXT (Binance)
2. Passes data to QuantGuild for pattern detection
3. Filters through RiskGate (confidence >= 65%)
4. Pushes approved signals to Redis `trades:pending`
5. Persists signals to Postgres via Next.js `/api/signals`

### NewsScoutTank

Scans RSS feeds from CoinTelegraph and CoinDesk every 15 minutes. Performs AI-powered sentiment analysis via GROK and stores scores in Redis under `sentiment:{SYMBOL}`.

### GainerScanner

Identifies top market movers and provides a confidence boost (+10%) for signals on trending assets.

### QuantGuild

The technical analysis engine. Calculates indicators (RSI, MACD, Bollinger Bands, EMA, ATR, volume) and runs 8 pattern detectors:

- RSI Oversold / Overbought
- Bollinger Squeeze
- MACD Bullish/Bearish Cross
- EMA Bullish/Bearish Cross
- Volume Spike
- Dip Buy
- Deep Value Crash (multi-timeframe)
- Momentum Gainer

### BaseTank (LangGraph Pipeline)

All tanks inherit from `BaseTank`, which builds a LangGraph `StateGraph` with four nodes:

```
scan -> analyze -> risk_check -> execute
```

Each node operates on a `TankState` TypedDict containing symbol, price, OHLCV data, indicators, signal, and decision.

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/` | Status check (returns mode) |
| GET | `/health` | Health check for monitoring |
| GET | `/tanks/status` | Status of all active tanks from Redis |
| POST | `/backtest` | Run a backtest (symbol, timeframe, days) |

## Docker Setup

### Build and Run

```bash
# Via docker-compose (recommended)
docker compose up -d engine

# Standalone
docker build -t cryonix-engine packages/engine
docker run -p 8000:8000 --env-file .env cryonix-engine
```

### Development

```bash
cd packages/engine
pnpm dev    # uvicorn with --reload on port 8000
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `KV_URL` | `redis://redis:6379` | Redis connection URL |
| `BINANCE_API_KEY` | `""` | Binance API key |
| `BINANCE_API_SECRET` | `""` | Binance API secret |
| `BINANCE_TESTNET` | `true` | Use Binance testnet |
| `XAI_API_KEY` | `""` | GROK/xAI API key (for NewsScout sentiment) |
| `NEXTJS_API_URL` | `http://host.docker.internal:3000` | Next.js API for signal persistence |
| `SPOT_ONLY` | `true` | Reject SELL signals |
| `CRYONIX_ENV` | `development` | `production` enables live execution |

## Communication

### Redis Keys

| Key | Direction | Description |
|---|---|---|
| `trades:pending` | Engine -> Web | Signal queue for auto-trader |
| `trades:approved` | Web -> Engine | Approved/executed signals |
| `sentiment:{SYMBOL}` | Engine -> Web | News sentiment scores |
| `agent:MarketScout:status` | Engine -> Web | Tank health and scan stats |

### HTTP Callbacks

The engine calls `{NEXTJS_API_URL}/api/signals` to persist signals to Postgres after they pass the risk gate.

## Dependencies

Key Python packages (managed via Poetry):

| Package | Purpose |
|---|---|
| `fastapi` / `uvicorn` | Web framework and ASGI server |
| `ccxt` | Binance exchange connectivity |
| `langgraph` | State machine for tank pipelines |
| `pandas` / `numpy` | Data manipulation and indicator math |
| `redis` | State sync and signal queues |
| `httpx` | Async HTTP client for callbacks |
| `feedparser` / `beautifulsoup4` | RSS feed parsing (NewsScout) |
| `pydantic` / `pydantic-settings` | Configuration and request validation |
| `dspy-ai` | AI integration utilities |
