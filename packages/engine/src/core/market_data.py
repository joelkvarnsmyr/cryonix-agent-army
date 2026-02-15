"""
Market Data Fetcher using CCXT
Fetches real OHLCV data from Binance (testnet or live)
"""
import ccxt
import asyncio
from typing import List, Dict, Any, Optional
from src.core.config import settings

class MarketDataFetcher:
    """
    Fetches real market data from exchanges via CCXT.
    Supports both sync and async operations.
    """

    def __init__(self):
        trading_mode = settings.TRADING_MODE  # 'spot', 'margin', or 'future'
        print(f"[MarketData] Initializing CCXT with mode: {trading_mode}")
        
        self.exchange = ccxt.binance({
            'apiKey': settings.BINANCE_API_KEY or None,
            'secret': settings.BINANCE_API_SECRET or None,
            'enableRateLimit': True,
            'options': {
                'defaultType': trading_mode if trading_mode != 'margin' else 'spot',
                'defaultMarginMode': settings.MARGIN_TYPE if trading_mode == 'margin' else None,
            }
        })

        # Use testnet if configured
        if settings.BINANCE_TESTNET:
            self.exchange.set_sandbox_mode(True)

        self.trading_mode = trading_mode
        
        # Cache for rate limiting
        self._cache: Dict[str, Any] = {}
        self._cache_ttl = 5  # seconds

    def fetch_ohlcv(
        self,
        symbol: str,
        timeframe: str = '15m',
        limit: int = 100
    ) -> List[list]:
        """
        Fetch OHLCV candles for a symbol.
        Returns: [[timestamp, open, high, low, close, volume], ...]
        """
        try:
            ohlcv = self.exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
            return ohlcv
        except Exception as e:
            print(f"[MarketData] Error fetching {symbol}: {e}")
            return []

    def fetch_ticker(self, symbol: str) -> Dict[str, Any]:
        """
        Fetch current ticker data for a symbol.
        Returns: {last, high, low, volume, change, ...}
        """
        try:
            ticker = self.exchange.fetch_ticker(symbol)
            return {
                'symbol': symbol,
                'price': ticker['last'],
                'high': ticker['high'],
                'low': ticker['low'],
                'volume': ticker['baseVolume'],
                'change': ticker['percentage'],
                'timestamp': ticker['timestamp'],
            }
        except Exception as e:
            print(f"[MarketData] Error fetching ticker {symbol}: {e}")
            return {'symbol': symbol, 'price': 0, 'error': str(e)}

    def fetch_total_capital(self) -> float:
        """Fetch actual total portfolio value from Binance in USD."""
        import time
        cache_key = "_total_capital"
        cached = self._cache.get(cache_key)
        if cached and (time.time() - cached['ts']) < 300:  # 5min cache
            return cached['data']

        try:
            # Use spot balance regardless of trading mode
            spot_exchange = ccxt.binance({
                'apiKey': settings.BINANCE_API_KEY or None,
                'secret': settings.BINANCE_API_SECRET or None,
                'enableRateLimit': True,
                'options': {'defaultType': 'spot'},
            })
            if settings.BINANCE_TESTNET:
                spot_exchange.set_sandbox_mode(True)

            bal = spot_exchange.fetch_balance()
            total = 0.0
            for coin, amount in (bal.get('free', {}) or {}).items():
                amt = float(amount or 0)
                if amt <= 0:
                    continue
                if coin in ('USDC', 'USDT', 'BUSD', 'USD'):
                    total += amt
                else:
                    try:
                        t = spot_exchange.fetch_ticker(f"{coin}/USDC")
                        total += amt * (t.get('last', 0) or 0)
                    except:
                        pass
            self._cache[cache_key] = {'data': total, 'ts': time.time()}
            print(f"[MarketData] Total capital from Binance: ${total:.2f}")
            return total
        except Exception as e:
            print(f"[MarketData] Capital fetch error: {e}")
            return cached['data'] if cached else 42.0

    def fetch_multi_timeframe(
        self,
        symbol: str,
        timeframes: Optional[Dict[str, int]] = None
    ) -> Dict[str, List[list]]:
        """
        Fetch OHLCV data across multiple timeframes for deep value analysis.
        Returns: {'15m': [[...], ...], '1h': [...], '4h': [...], '1d': [...]}
        Uses per-timeframe caching to avoid excessive API calls.
        """
        if timeframes is None:
            timeframes = {'15m': 100, '1h': 48, '4h': 24, '1d': 14}

        import time
        result = {}
        # TTL per timeframe (seconds)
        ttl_map = {'15m': 60, '1h': 300, '4h': 900, '1d': 3600}

        for tf, limit in timeframes.items():
            cache_key = f"mtf:{symbol}:{tf}"
            cached = self._cache.get(cache_key)
            now = time.time()

            if cached and (now - cached['ts']) < ttl_map.get(tf, 300):
                result[tf] = cached['data']
                continue

            try:
                ohlcv = self.exchange.fetch_ohlcv(symbol, tf, limit=limit)
                result[tf] = ohlcv
                self._cache[cache_key] = {'data': ohlcv, 'ts': now}
            except Exception as e:
                print(f"[MarketData] Error fetching {symbol} {tf}: {e}")
                result[tf] = []

        return result

    def fetch_order_book(self, symbol: str, limit: int = 10) -> Dict[str, Any]:
        """
        Fetch order book for a symbol.
        Returns: {bids: [[price, amount], ...], asks: [[price, amount], ...]}
        """
        try:
            book = self.exchange.fetch_order_book(symbol, limit)
            return {
                'bids': book['bids'][:limit],
                'asks': book['asks'][:limit],
                'spread': book['asks'][0][0] - book['bids'][0][0] if book['bids'] and book['asks'] else 0,
            }
        except Exception as e:
            print(f"[MarketData] Error fetching order book {symbol}: {e}")
            return {'bids': [], 'asks': [], 'spread': 0}

# Singleton instance
market_data = MarketDataFetcher()
