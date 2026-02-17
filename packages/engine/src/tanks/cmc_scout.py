"""
CMCScout — CoinMarketCap macro intelligence layer.

Polls CoinMarketCap API (Free tier) for:
  1. Global metrics (total market cap, BTC dominance, 24h volume)
  2. Fear & Greed Index
  3. Market cap + rank + FDV for all traded symbols

Writes structured data to Redis for the auto-trader to consume:
  - cmc:global        — total MC, BTC dominance, 24h changes
  - cmc:fear_greed    — current F&G index value + label
  - cmc:mcap:{SYMBOL} — rank, market cap, FDV, FDV/MC ratio per coin

Runs every 10 minutes (configurable via cryonix.toml [coinmarketcap]).
Uses ~5,500 of 10,000 free monthly credits.
"""
import asyncio
import json
import os
import time
from typing import Any, Dict, Optional

import httpx

from src.core.config import get_toml
from src.core.state_sync import state_manager

# Base asset names from our trading pairs (used for CMC quote lookup)
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

CMC_BASE_URL = "https://pro-api.coinmarketcap.com"

# Redis TTL: data valid for 20 minutes (2x poll interval as buffer)
REDIS_TTL = 1200


class CMCScout:
    """Fetches macro intelligence from CoinMarketCap and writes to Redis."""

    def __init__(self, redis_client):
        self.redis = redis_client
        self.name = "CMCScout"
        self.api_key = os.environ.get("CMC_API_KEY", "")
        self.enabled = bool(self.api_key) and get_toml("coinmarketcap", "enabled", False)
        self.poll_interval = get_toml("coinmarketcap", "poll_interval_seconds", 600)
        self.last_run = 0.0

    def _headers(self) -> Dict[str, str]:
        return {
            "Accept": "application/json",
            "X-CMC_PRO_API_KEY": self.api_key,
        }

    # ── API calls ─────────────────────────────────────────────────────

    async def _fetch_global_metrics(self, client: httpx.AsyncClient) -> Optional[Dict]:
        """GET /v1/global-metrics/quotes/latest — total MC, BTC dominance, volume."""
        try:
            resp = await client.get(
                f"{CMC_BASE_URL}/v1/global-metrics/quotes/latest",
                headers=self._headers(),
            )
            resp.raise_for_status()
            data = resp.json().get("data", {})
            quote = data.get("quote", {}).get("USD", {})

            return {
                "total_market_cap": quote.get("total_market_cap", 0),
                "total_market_cap_yesterday_pct": quote.get("total_market_cap_yesterday_percentage_change", 0),
                "total_volume_24h": quote.get("total_volume_24h", 0),
                "total_volume_24h_yesterday_pct": quote.get("total_volume_24h_yesterday_percentage_change", 0),
                "btc_dominance": data.get("btc_dominance", 0),
                "btc_dominance_24h_pct": data.get("btc_dominance_24h_percentage_change", 0),
                "eth_dominance": data.get("eth_dominance", 0),
                "active_cryptocurrencies": data.get("active_cryptocurrencies", 0),
                "fear_greed_value": data.get("fear_and_greed", {}).get("value", 50),
                "fear_greed_label": data.get("fear_and_greed", {}).get("value_classification", "Neutral"),
                "timestamp": time.time(),
            }
        except Exception as e:
            print(f"[{self.name}] Global metrics fetch failed: {e}")
            return None

    async def _fetch_quotes(self, client: httpx.AsyncClient) -> Optional[Dict[str, Dict]]:
        """GET /v2/cryptocurrency/quotes/latest — MC, rank, FDV for traded symbols.

        Batches all symbols in one call (1 credit per 100 data points).
        """
        try:
            symbols_str = ",".join(TRACKED_SYMBOLS)
            resp = await client.get(
                f"{CMC_BASE_URL}/v2/cryptocurrency/quotes/latest",
                headers=self._headers(),
                params={"symbol": symbols_str, "convert": "USD"},
            )
            resp.raise_for_status()
            raw_data = resp.json().get("data", {})

            result: Dict[str, Dict] = {}
            for symbol, entries in raw_data.items():
                # v2 returns a list per symbol (multiple coins can share a symbol)
                # Take the first entry (highest rank / most relevant)
                entry = entries[0] if isinstance(entries, list) and entries else entries
                if not entry:
                    continue

                quote = entry.get("quote", {}).get("USD", {})
                market_cap = quote.get("market_cap", 0) or 0
                fdv = quote.get("fully_diluted_market_cap", 0) or 0

                result[symbol] = {
                    "rank": entry.get("cmc_rank", 9999),
                    "market_cap": market_cap,
                    "fdv": fdv,
                    "fdv_mc_ratio": round(fdv / market_cap, 2) if market_cap > 0 else 0,
                    "price": quote.get("price", 0),
                    "percent_change_24h": quote.get("percent_change_24h", 0),
                    "percent_change_7d": quote.get("percent_change_7d", 0),
                    "volume_24h": quote.get("volume_24h", 0),
                    "circulating_supply": entry.get("circulating_supply", 0),
                    "max_supply": entry.get("max_supply", 0),
                    "timestamp": time.time(),
                }

            return result
        except Exception as e:
            print(f"[{self.name}] Quotes fetch failed: {e}")
            return None

    # ── Main scan ─────────────────────────────────────────────────────

    async def scan(self) -> Dict[str, Any]:
        """Run full CMC scan: global metrics + per-symbol quotes."""
        async with httpx.AsyncClient(timeout=15.0) as client:
            global_data, quotes = await asyncio.gather(
                self._fetch_global_metrics(client),
                self._fetch_quotes(client),
            )

        results: Dict[str, Any] = {"status": "ok", "timestamp": time.time()}
        pipe = self.redis.pipeline()

        # ── Global metrics + Fear & Greed ──
        if global_data:
            pipe.set("cmc:global", json.dumps(global_data), ex=REDIS_TTL)

            fg_value = global_data.get("fear_greed_value", 50)
            fg_label = global_data.get("fear_greed_label", "Neutral")
            pipe.set("cmc:fear_greed", json.dumps({
                "value": fg_value,
                "label": fg_label,
                "timestamp": time.time(),
            }), ex=REDIS_TTL)

            results["global"] = {
                "total_mc_change_24h": global_data.get("total_market_cap_yesterday_pct", 0),
                "btc_dominance": global_data.get("btc_dominance", 0),
                "btc_dominance_change": global_data.get("btc_dominance_24h_pct", 0),
                "fear_greed": fg_value,
                "fear_greed_label": fg_label,
            }
            print(
                f"[{self.name}] Global: F&G={fg_value} ({fg_label}), "
                f"BTC dom={global_data.get('btc_dominance', 0):.1f}%, "
                f"MC 24h={global_data.get('total_market_cap_yesterday_pct', 0):+.1f}%"
            )
        else:
            results["global"] = None

        # ── Per-symbol market cap data ──
        if quotes:
            for symbol, data in quotes.items():
                pipe.set(f"cmc:mcap:{symbol}", json.dumps(data), ex=REDIS_TTL)

            results["symbols_updated"] = len(quotes)

            # Log top/bottom ranked
            ranked = sorted(quotes.items(), key=lambda x: x[1].get("rank", 9999))
            top3 = ", ".join(f"{s} #{d['rank']}" for s, d in ranked[:3])
            print(f"[{self.name}] Updated {len(quotes)} symbols. Top: {top3}")
        else:
            results["symbols_updated"] = 0

        await pipe.execute()

        # Update agent status
        await state_manager.set_agent_status(self.name, "active", {
            "message": f"Scan complete: {results.get('symbols_updated', 0)} symbols",
            "fear_greed": results.get("global", {}).get("fear_greed") if results.get("global") else None,
        })

        return results

    # ── Run loop ──────────────────────────────────────────────────────

    async def run_loop(self):
        """Periodically poll CoinMarketCap."""
        if not self.enabled:
            print(f"[{self.name}] Disabled (CMC_API_KEY not set or coinmarketcap.enabled=false)")
            await state_manager.set_agent_status(self.name, "disabled", {
                "message": "CMC_API_KEY not set or coinmarketcap.enabled=false in cryonix.toml"
            })
            return

        print(f"[{self.name}] Starting CMC scout loop (every {self.poll_interval}s)")

        while True:
            try:
                now = time.time()
                if now - self.last_run >= self.poll_interval:
                    await self.scan()
                    self.last_run = now
            except Exception as e:
                print(f"[{self.name}] Error: {e}")
                await state_manager.set_agent_status(self.name, "error", {
                    "message": str(e),
                })
                # Back off on error
                await asyncio.sleep(60)
                continue

            await asyncio.sleep(30)  # Check interval (actual poll governed by poll_interval)
