"""
Cryonix Intelligence Layer — FastAPI application with ORAKEL forecast engine.

Starts the OrakelRunner as a background task on startup and exposes
REST endpoints for forecasts, regime, volatility, and status.
"""

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import redis.asyncio as aioredis
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from src.api.router import api_router
from src.orakel.runner import OrakelRunner

logger = logging.getLogger(__name__)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

# --- Configuration ---

KV_URL = os.getenv("KV_URL", "redis://redis:6379")

DEFAULT_SYMBOLS = ["BTC/USDC", "ETH/USDC", "SOL/USDC", "BNB/USDC"]


def _load_symbols() -> list[str]:
    """Load symbol list from cryonix.toml or fall back to defaults."""
    toml_paths = [
        Path("/app/cryonix.toml"),           # Docker mount
        Path("cryonix.toml"),                 # Local dev
        Path("../../cryonix.toml"),           # From packages/intelligence
    ]

    for toml_path in toml_paths:
        if toml_path.exists():
            try:
                import tomlkit
                with open(toml_path) as f:
                    config = tomlkit.load(f)

                # Try [orakel] section first, then [trading] section
                orakel_symbols = config.get("orakel", {}).get("symbols")
                if orakel_symbols:
                    logger.info("Loaded %d symbols from [orakel] in %s", len(orakel_symbols), toml_path)
                    return list(orakel_symbols)

                trading_symbols = config.get("trading", {}).get("symbol_whitelist")
                if trading_symbols:
                    logger.info("Loaded %d symbols from [trading] in %s", len(trading_symbols), toml_path)
                    return list(trading_symbols)

            except Exception as e:
                logger.warning("Failed to read symbols from %s: %s", toml_path, e)

    logger.info("Using default symbol list: %s", DEFAULT_SYMBOLS)
    return DEFAULT_SYMBOLS


# --- Global runner reference ---

_runner: Optional[OrakelRunner] = None
_runner_task: Optional[asyncio.Task] = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Start the OrakelRunner background task on startup, clean up on shutdown."""
    global _runner, _runner_task

    symbols = _load_symbols()
    _runner = OrakelRunner(redis_url=KV_URL, symbols=symbols)

    _runner_task = asyncio.create_task(
        _runner.run_loop(),
        name="orakel-runner",
    )
    logger.info(
        "ORAKEL runner started as background task (symbols=%s, redis=%s)",
        symbols, KV_URL,
    )

    yield

    # Shutdown
    if _runner_task and not _runner_task.done():
        _runner_task.cancel()
        try:
            await _runner_task
        except asyncio.CancelledError:
            pass

    if _runner:
        await _runner.shutdown()
    logger.info("ORAKEL runner stopped")


# --- FastAPI App ---

app = FastAPI(
    title="Cryonix Intelligence Layer",
    description="ORAKEL forecast engine — XGBoost, HMM, GARCH, Kalman fusion",
    version="0.2.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Legacy API router (analyze endpoint)
app.include_router(api_router)


# --- Redis helper ---

async def _get_redis() -> aioredis.Redis:
    """Get an async Redis connection."""
    return aioredis.from_url(KV_URL, decode_responses=True)


async def _read_redis_key(key: str) -> Optional[dict]:
    """Read and parse a JSON key from Redis."""
    r = await _get_redis()
    try:
        raw = await r.get(key)
        if raw is None:
            return None
        return json.loads(raw)
    finally:
        await r.close()


# --- Endpoints ---

@app.get("/")
async def root():
    return {"status": "online", "service": "Cryonix Intelligence Layer (ORAKEL)"}


@app.get("/health")
async def health_check():
    """Health check — verifies Redis connectivity and runner status."""
    status = {"status": "healthy", "service": "intelligence"}

    # Check Redis
    try:
        r = await _get_redis()
        await r.ping()
        status["redis"] = "connected"
        await r.close()
    except Exception as e:
        status["redis"] = f"error: {e}"
        status["status"] = "degraded"

    # Check runner
    if _runner:
        runner_status = _runner.get_status()
        status["orakel_running"] = True
        status["symbols"] = runner_status["symbols"]
        status["last_hourly"] = runner_status["last_hourly"]
        status["models_loaded"] = sum(
            1 for v in runner_status["models_loaded"].values() if v
        )
    else:
        status["orakel_running"] = False

    return status


@app.get("/forecast/{symbol}")
async def get_forecast(symbol: str):
    """Get the latest direction forecast for a symbol.

    Symbol should be provided with underscore separator (e.g., BTC_USDC).
    """
    safe_symbol = symbol.replace("/", "_")

    direction = await _read_redis_key(f"orakel:{safe_symbol}:direction")
    fused = await _read_redis_key(f"orakel:{safe_symbol}:fused")
    funding = await _read_redis_key(f"orakel:funding:{safe_symbol}")

    if direction is None and fused is None:
        raise HTTPException(
            status_code=404,
            detail=f"No forecast available for {symbol}. Available symbols: {_runner.symbols if _runner else []}",
        )

    return {
        "symbol": symbol,
        "direction": direction,
        "fused": fused,
        "funding": funding,
    }


@app.get("/regime")
async def get_regime():
    """Get the current market regime (bull/sideways/bear)."""
    regime = await _read_redis_key("orakel:regime")
    if regime is None:
        return {
            "regime": "unknown",
            "note": "Daily cycle has not run yet. Regime is updated daily at 00:05 UTC.",
        }
    return regime


@app.get("/volatility")
async def get_volatility():
    """Get the GARCH volatility forecast."""
    vol = await _read_redis_key("orakel:volatility")
    if vol is None:
        return {
            "vol_ratio": 1.0,
            "spike_warning": False,
            "note": "Daily cycle has not run yet. Volatility is updated daily at 00:05 UTC.",
        }
    return vol


@app.get("/status")
async def get_status():
    """Get ORAKEL runner status: loaded models, last update times, tracked symbols."""
    if _runner is None:
        raise HTTPException(status_code=503, detail="ORAKEL runner not initialized")
    return _runner.get_status()
