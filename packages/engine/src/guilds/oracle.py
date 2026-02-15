from typing import Dict, Any, List
import ccxt.pro as ccxt  # Use ccxt.pro for Async/WebSockets
import asyncio
from src.core.config import settings

class OracleGuild:
    """
    The 'Eyes' of the Engine.
    Responsibilities:
    - Fetch Market Data (OHLCV)
    - Listen to WebSockets (Trade stream)
    - Fetch Social Sentiment (LunarCrush/X)
    """
    
    def __init__(self):
        self.exchange = ccxt.binance({
            'apiKey': settings.BINANCE_API_KEY,
            'secret': settings.BINANCE_API_SECRET,
            'enableRateLimit': True,
            'options': {
                'defaultType': 'future',
            }
        })
        if settings.BINANCE_TESTNET:
            self.exchange.set_sandbox_mode(True)

    async def get_ohlcv(self, symbol: str, timeframe: str = '1m', limit: int = 100) -> List[list]:
        """Fetch historical candles."""
        try:
            return await self.exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
        except Exception as e:
            print(f"[Oracle] Error fetching OHLCV for {symbol}: {e}")
            return []

    async def get_current_price(self, symbol: str) -> float:
        """Fetch current ticker price."""
        ticker = await self.exchange.fetch_ticker(symbol)
        return ticker['last']

    async def close(self):
        await self.exchange.close()

oracle = OracleGuild()
