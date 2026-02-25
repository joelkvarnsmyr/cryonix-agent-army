"""
GainerScanner — Detects top movers across all trading pairs.
Runs every 15 minutes, stores results in Redis for Telegram reporting.
"""
import asyncio
import json
import os
import time
from typing import Dict, List
from src.core.market_data import MarketDataFetcher

market_data = MarketDataFetcher()

# Same universe as MarketScout
SYMBOLS = [
    # Tier 1: Large caps
    "BTC/USDC", "ETH/USDC", "SOL/USDC", "BNB/USDC", "XRP/USDC",
    # Tier 2: Mid caps
    "ADA/USDC", "AVAX/USDC", "LINK/USDC", "DOT/USDC", "ATOM/USDC",
    "NEAR/USDC", "SUI/USDC", "UNI/USDC", "AAVE/USDC", "TAO/USDC",
    # Tier 3: High-beta
    "ARB/USDC", "OP/USDC", "INJ/USDC", "FET/USDC", "RENDER/USDC",
    "TIA/USDC", "SEI/USDC", "JUP/USDC", "WLD/USDC", "ICP/USDC",
    # Tier 4: Emerging
    "APT/USDC", "FIL/USDC", "POL/USDC", "ALGO/USDC", "THETA/USDC",
    "STRK/USDC", "PYTH/USDC", "JTO/USDC", "WIF/USDC", "PENDLE/USDC",
    # Tier 5: Meme / micro-order
    "DOGE/USDC", "PEPE/USDC", "SHIB/USDC", "BONK/USDC", "FLOKI/USDC",
    # Tier 6: Recovery plays
    "LTC/USDC", "ETC/USDC", "XLM/USDC", "VET/USDC", "HBAR/USDC",
]

SCAN_INTERVAL = 900  # 15 minutes


class GainerScanner:
    """Scans all pairs for price and volume changes."""

    def __init__(self, redis_client):
        self.redis = redis_client
        self.name = "GainerScanner"

    async def scan(self) -> Dict:
        """Scan all pairs and return top movers."""
        results = []

        for symbol in SYMBOLS:
            try:
                ohlcv = market_data.fetch_ohlcv(symbol, "1h", 25)
                if not ohlcv or len(ohlcv) < 5:
                    continue

                current = ohlcv[-1]
                price = current[4]  # close

                # 1h change
                prev_1h = ohlcv[-2][4] if len(ohlcv) >= 2 else price
                change_1h = ((price - prev_1h) / prev_1h * 100) if prev_1h > 0 else 0

                # 4h change
                prev_4h = ohlcv[-5][4] if len(ohlcv) >= 5 else price
                change_4h = ((price - prev_4h) / prev_4h * 100) if prev_4h > 0 else 0

                # 24h change (use candle at -24 if available, else oldest)
                idx_24h = -25 if len(ohlcv) >= 25 else 0
                prev_24h = ohlcv[idx_24h][4]
                change_24h = ((price - prev_24h) / prev_24h * 100) if prev_24h > 0 else 0

                # Volume surge: current vs 20-bar average
                volumes = [c[5] for c in ohlcv[-20:]]
                avg_vol = sum(volumes[:-1]) / max(len(volumes) - 1, 1)
                current_vol = volumes[-1] if volumes else 0
                vol_ratio = current_vol / avg_vol if avg_vol > 0 else 1.0

                results.append({
                    "symbol": symbol,
                    "price": price,
                    "change_1h": round(change_1h, 2),
                    "change_4h": round(change_4h, 2),
                    "change_24h": round(change_24h, 2),
                    "vol_ratio": round(vol_ratio, 2),
                    "volume_usd": round(current_vol * price, 0),
                })

            except Exception as e:
                print(f"[{self.name}] Error scanning {symbol}: {e}")
                continue

        if not results:
            return {"gainers": [], "losers": [], "volume_surges": [], "timestamp": time.time()}

        # Sort by different criteria
        gainers = sorted(results, key=lambda x: x["change_1h"], reverse=True)[:10]
        losers = sorted(results, key=lambda x: x["change_1h"])[:10]
        vol_surges = sorted(
            [r for r in results if r["vol_ratio"] > 1.5],
            key=lambda x: x["vol_ratio"], reverse=True
        )[:10]

        report = {
            "gainers": gainers,
            "losers": losers,
            "volume_surges": vol_surges,
            "total_scanned": len(results),
            "timestamp": time.time(),
        }

        # Store in Redis
        await self.redis.set("scanner:top_movers", json.dumps(report), ex=1800)

        # Persist snapshot to Postgres for evolution analysis
        try:
            import httpx
            api_url = os.environ.get("NEXTJS_API_URL", "http://host.docker.internal:3000")
            async with httpx.AsyncClient(timeout=5.0) as client:
                await client.post(f"{api_url}/api/scanner-history", json=report)
        except Exception as e:
            print(f"[{self.name}] Scanner history persist failed (non-critical): {e}")

        # Alert on significant moves (>5% in 1h)
        alerts = [r for r in results if abs(r["change_1h"]) > 5]
        if alerts:
            await self.redis.set("scanner:alerts", json.dumps(alerts), ex=900)
            print(f"[{self.name}] 🚨 {len(alerts)} coins moved >5% in 1h!")

        return report

    async def run_loop(self):
        """Run scanner every 15 minutes."""
        print(f"[{self.name}] Starting gainer scanner loop (every {SCAN_INTERVAL}s)")
        while True:
            try:
                report = await self.scan()
                top = report.get("gainers", [])[:3]
                bottom = report.get("losers", [])[:3]

                if top:
                    top_str = ", ".join(f"{g['symbol'].split('/')[0]} {g['change_1h']:+.1f}%" for g in top)
                    print(f"[{self.name}] Top gainers (1h): {top_str}")
                if bottom:
                    bot_str = ", ".join(f"{l['symbol'].split('/')[0]} {l['change_1h']:+.1f}%" for l in bottom)
                    print(f"[{self.name}] Top losers (1h): {bot_str}")

            except Exception as e:
                print(f"[{self.name}] Scan error: {e}")

            await asyncio.sleep(SCAN_INTERVAL)
