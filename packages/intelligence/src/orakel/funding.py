"""
Funding rate collector for ORAKEL forecast engine.

Fetches perpetual futures funding rates from Binance to detect
crowded positioning (longs vs shorts) as a contrarian signal.
"""

import asyncio
import logging

import ccxt
import ccxt.async_support as ccxt_async

logger = logging.getLogger(__name__)


class FundingCollector:
    """Collects and interprets funding rates from Binance perpetual futures."""

    # Funding rate thresholds (as percentage, e.g. 0.01 = 0.01%)
    BULLISH_THRESHOLD = -0.05   # Negative rate: shorts paying longs (squeeze potential)
    BEARISH_THRESHOLD = 0.08    # High positive: crowded longs (overleveraged)

    def __init__(self, exchange: ccxt_async.binance) -> None:
        """Initialize with an async CCXT Binance exchange instance.

        Args:
            exchange: Configured ccxt.async_support.binance instance with
                      futures/swap market loaded.
        """
        self.exchange = exchange

    async def fetch_funding_rates(self, symbols: list[str]) -> dict[str, dict]:
        """Fetch funding rates for a list of symbols.

        Args:
            symbols: List of trading pair symbols (e.g. ["BTC/USDC", "ETH/USDC"]).
                     These will be converted to perpetual swap symbols for the query.

        Returns:
            Dict mapping symbol to funding data:
            {
                "BTC/USDC": {
                    "rate": 0.0032,
                    "next_funding_time": "2026-03-20T08:00:00Z",
                    "signal": "neutral"
                },
                ...
            }

            Symbols without futures or that error are omitted silently.
        """
        results: dict[str, dict] = {}

        for symbol in symbols:
            try:
                data = await self._fetch_single(symbol)
                if data is not None:
                    results[symbol] = data
            except Exception as e:
                logger.debug(
                    "Skipping %s funding rate (no futures or error): %s",
                    symbol,
                    e,
                )

        logger.info(
            "Fetched funding rates for %d/%d symbols",
            len(results),
            len(symbols),
        )
        return results

    async def _fetch_single(self, symbol: str) -> dict | None:
        """Fetch funding rate for a single symbol.

        Returns None if the symbol has no perpetual futures contract.
        """
        # Convert spot symbol to perpetual swap format
        # CCXT uses the same symbol for futures on Binance
        # but we need to ensure the exchange has the market loaded
        try:
            funding = await self.exchange.fetch_funding_rate(symbol)
        except (ccxt.BadSymbol, ccxt.ExchangeError):
            # Symbol does not have a futures contract
            return None

        rate_raw = funding.get("fundingRate")
        if rate_raw is None:
            return None

        # Rate is typically a decimal (0.0001 = 0.01%)
        # Convert to percentage for threshold comparison
        rate_pct = float(rate_raw) * 100.0

        # Determine signal
        if rate_pct <= self.BULLISH_THRESHOLD:
            signal = "bullish"
        elif rate_pct >= self.BEARISH_THRESHOLD:
            signal = "bearish"
        else:
            signal = "neutral"

        next_time = funding.get("fundingDatetime") or funding.get("nextFundingDatetime", "")

        return {
            "rate": rate_pct,
            "next_funding_time": str(next_time),
            "signal": signal,
        }
