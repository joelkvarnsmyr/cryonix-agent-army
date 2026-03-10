"""
CoinglassScout — Derivatives market intelligence layer.

Fetches funding rates, open interest, and long/short ratio from:
  - Coinglass Open API v1 (when enabled=true + COINGLASS_API_KEY set)
  - CCXT Binance USDT-M futures (fallback: funding + OI only, no L/S ratio)

Writes to Redis every 10 minutes (configurable):
  - coinglass:funding:{BASE}  → { rate, annualized_rate, next_funding_time, timestamp }
  - coinglass:oi:{BASE}       → { oi_usd, oi_change_24h_pct, timestamp }
  - coinglass:ls:{BASE}       → { long_ratio, short_ratio, ls_ratio, timestamp }  (API only)

BASE is the asset symbol without quote (e.g. BTC, ETH, SOL).
"""
import asyncio
import json
import os
import time
from typing import Any, Dict, Optional, Tuple

import httpx
import ccxt.async_support as ccxt

from src.core.config import get_toml
from src.core.state_sync import state_manager

# Base assets we track (matches CMCScout TRACKED_SYMBOLS)
TRACKED_SYMBOLS = [
    "BTC", "ETH", "SOL", "BNB", "XRP",
    "ADA", "AVAX", "LINK", "DOT", "ATOM",
    "NEAR", "SUI", "UNI", "AAVE", "TAO",
    "ARB", "OP", "INJ", "FET", "RENDER",
    "TIA", "SEI", "JUP", "WLD", "ICP",
    "APT", "FIL", "POL", "ALGO", "THETA",
    "STRK", "PYTH", "JTO", "WIF", "PENDLE",
    "DOGE", "PEPE", "SHIB", "BONK", "FLOKI",
    "LTC", "ETC", "XLM", "VET", "HBAR",
]

COINGLASS_BASE_URL = "https://open-api.coinglass.com"
REDIS_TTL = 1200  # 20 minutes (2x poll interval as buffer)


class CoinglassScout:
    """Fetches derivatives market intelligence and writes to Redis."""

    def __init__(self, redis_client):
        self.redis = redis_client
        self.name = "CoinglassScout"
        self.api_key = os.environ.get("COINGLASS_API_KEY", "")
        self.use_api = bool(self.api_key) and get_toml("coinglass", "enabled", False)
        self.poll_interval = get_toml("coinglass", "poll_interval_seconds", 600)
        self.last_run = 0.0

    def _cg_headers(self) -> Dict[str, str]:
        return {
            "Accept": "application/json",
            "coinglassSecret": self.api_key,
        }

    # ── Coinglass API mode ─────────────────────────────────────────────

    async def _fetch_coinglass_funding(
        self, client: httpx.AsyncClient, symbol: str
    ) -> Optional[Dict]:
        """GET /api/pro/v1/futures/funding-rate — current funding rate per exchange."""
        try:
            resp = await client.get(
                f"{COINGLASS_BASE_URL}/api/pro/v1/futures/funding-rate",
                headers=self._cg_headers(),
                params={"symbol": symbol},
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json().get("data", [])
            binance = next(
                (d for d in data if d.get("exchangeName", "").lower() == "binance"),
                data[0] if data else None,
            )
            if not binance:
                return None
            rate = float(binance.get("fundingRate", 0))
            return {
                "rate": rate,
                "annualized_rate": rate * 3 * 365,
                "next_funding_time": binance.get("nextFundingTime"),
                "timestamp": time.time(),
            }
        except Exception as e:
            print(f"[{self.name}] Coinglass funding fetch failed for {symbol}: {e}")
            return None

    async def _fetch_coinglass_oi(
        self, client: httpx.AsyncClient, symbol: str
    ) -> Optional[Dict]:
        """GET /api/pro/v1/futures/openInterest — open interest + 24h change."""
        try:
            resp = await client.get(
                f"{COINGLASS_BASE_URL}/api/pro/v1/futures/openInterest",
                headers=self._cg_headers(),
                params={"symbol": symbol},
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json().get("data", {})
            all_entry = data.get("All") or (list(data.values())[0] if data else None)
            if not all_entry:
                return None
            oi_usd = float(all_entry.get("openInterest", 0))
            oi_change = float(all_entry.get("openInterestChangePercent24h", 0)) / 100
            return {
                "oi_usd": oi_usd,
                "oi_change_24h_pct": oi_change,
                "timestamp": time.time(),
            }
        except Exception as e:
            print(f"[{self.name}] Coinglass OI fetch failed for {symbol}: {e}")
            return None

    async def _fetch_coinglass_ls(
        self, client: httpx.AsyncClient, symbol: str
    ) -> Optional[Dict]:
        """GET /api/pro/v1/futures/global-long-short-account-ratio — L/S ratio."""
        try:
            resp = await client.get(
                f"{COINGLASS_BASE_URL}/api/pro/v1/futures/global-long-short-account-ratio",
                headers=self._cg_headers(),
                params={"symbol": symbol, "interval": "h1", "limit": 1},
                timeout=10.0,
            )
            resp.raise_for_status()
            data = resp.json().get("data", [])
            latest = data[-1] if data else None
            if not latest:
                return None
            long_ratio = float(latest.get("longAccount", 0.5))
            short_ratio = float(latest.get("shortAccount", 0.5))
            ls_ratio = long_ratio / short_ratio if short_ratio > 0 else 1.0
            return {
                "long_ratio": long_ratio,
                "short_ratio": short_ratio,
                "ls_ratio": ls_ratio,
                "timestamp": time.time(),
            }
        except Exception as e:
            print(f"[{self.name}] Coinglass L/S fetch failed for {symbol}: {e}")
            return None

    async def _scan_via_api(self) -> Dict[str, Any]:
        """Fetch data from Coinglass API.

        NOTE: Coinglass free tier is ~100 req/day. At 10-minute poll intervals,
        even 1 symbol x 3 endpoints x 144 cycles/day = 432 req/day exceeds the limit.
        In API mode, poll_interval_seconds should be set to 21600 (6h) so that
        15 symbols x 3 endpoints x 4 cycles/day = 180 req/day, within the free tier.
        The CCXT fallback covers all 45 symbols every 10 minutes for free.
        """
        # Top 15 symbols only in API mode.
        # At 6h poll interval: 15 x 3 endpoints x 4 cycles/day = 180 req/day.
        TOP_SYMBOLS = [
            "BTC", "ETH", "SOL", "BNB", "XRP",
            "ADA", "AVAX", "LINK", "DOT", "ATOM",
            "NEAR", "SUI", "UNI", "AAVE", "TAO",
        ]
        results: Dict[str, Any] = {}
        async with httpx.AsyncClient() as client:
            for symbol in TOP_SYMBOLS:
                funding, oi, ls = await asyncio.gather(
                    self._fetch_coinglass_funding(client, symbol),
                    self._fetch_coinglass_oi(client, symbol),
                    self._fetch_coinglass_ls(client, symbol),
                )
                results[symbol] = {"funding": funding, "oi": oi, "ls": ls}
                await asyncio.sleep(0.3)
        return results

    # ── CCXT fallback mode ────────────────────────────────────────────

    async def _fetch_ccxt_data(
        self, exchange: ccxt.binanceusdm, symbol: str
    ) -> Tuple[Optional[Dict], Optional[Dict]]:
        """Fetch funding rate + OI for one symbol via CCXT Binance futures."""
        futures_symbol = f"{symbol}/USDT:USDT"
        try:
            funding_data = await exchange.fetch_funding_rate(futures_symbol)
            rate = float(funding_data.get("fundingRate", 0))
            funding = {
                "rate": rate,
                "annualized_rate": rate * 3 * 365,
                "next_funding_time": funding_data.get("nextFundingDatetime"),
                "timestamp": time.time(),
            }
        except Exception as e:
            print(f"[{self.name}] CCXT funding failed for {symbol}: {e}")
            funding = None

        try:
            oi_data = await exchange.fetch_open_interest(futures_symbol)
            current_oi = float(oi_data.get("openInterestValue", 0))

            # Compute change by comparing to previous Redis value
            prev_raw = await self.redis.get(f"coinglass:oi:{symbol}")
            prev_oi = json.loads(prev_raw).get("oi_usd", 0) if prev_raw else 0
            oi_change = ((current_oi - prev_oi) / prev_oi) if prev_oi > 0 else 0.0

            oi = {
                "oi_usd": current_oi,
                "oi_change_24h_pct": oi_change,
                "timestamp": time.time(),
            }
        except Exception as e:
            print(f"[{self.name}] CCXT OI failed for {symbol}: {e}")
            oi = None

        return funding, oi

    async def _scan_via_ccxt(self) -> Dict[str, Any]:
        """Fetch funding + OI for all tracked symbols via CCXT (no API key required)."""
        exchange = ccxt.binanceusdm({"options": {"defaultType": "future"}})
        results: Dict[str, Any] = {}
        try:
            for symbol in TRACKED_SYMBOLS:
                funding, oi = await self._fetch_ccxt_data(exchange, symbol)
                results[symbol] = {"funding": funding, "oi": oi, "ls": None}
        finally:
            await exchange.close()
        return results

    # ── Main scan ─────────────────────────────────────────────────────

    async def scan(self) -> Dict[str, Any]:
        """Run full Coinglass scan and write results to Redis."""
        mode = "api" if self.use_api else "ccxt"
        print(f"[{self.name}] Scanning via {mode.upper()}...")

        data = await self._scan_via_api() if self.use_api else await self._scan_via_ccxt()

        pipe = self.redis.pipeline()
        updated = {"funding": 0, "oi": 0, "ls": 0}

        for symbol, entry in data.items():
            if entry.get("funding"):
                pipe.set(f"coinglass:funding:{symbol}", json.dumps(entry["funding"]), ex=REDIS_TTL)
                updated["funding"] += 1
            if entry.get("oi"):
                pipe.set(f"coinglass:oi:{symbol}", json.dumps(entry["oi"]), ex=REDIS_TTL)
                updated["oi"] += 1
            if entry.get("ls"):
                pipe.set(f"coinglass:ls:{symbol}", json.dumps(entry["ls"]), ex=REDIS_TTL)
                updated["ls"] += 1

        await pipe.execute()

        summary = f"funding={updated['funding']} oi={updated['oi']} ls={updated['ls']} [{mode}]"
        print(f"[{self.name}] Done: {summary}")

        await state_manager.set_agent_status(self.name, "active", {"message": summary})
        return {"status": "ok", "mode": mode, **updated, "timestamp": time.time()}

    # ── Run loop ──────────────────────────────────────────────────────

    async def run_loop(self):
        """Periodically poll Coinglass (API or CCXT fallback)."""
        mode = "Coinglass API" if self.use_api else "CCXT fallback (funding + OI)"
        print(f"[{self.name}] Starting ({mode}, every {self.poll_interval}s)")

        await state_manager.set_agent_status(self.name, "active", {"message": f"Starting {mode}"})

        while True:
            try:
                now = time.time()
                if now - self.last_run >= self.poll_interval:
                    await self.scan()
                    self.last_run = now
            except Exception as e:
                print(f"[{self.name}] Error: {e}")
                await state_manager.set_agent_status(self.name, "error", {"message": str(e)})
                await asyncio.sleep(60)
                continue

            await asyncio.sleep(30)
