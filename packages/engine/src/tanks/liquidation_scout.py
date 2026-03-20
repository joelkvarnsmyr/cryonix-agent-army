"""
Liquidation Scout — Real-time liquidation cascade detection via Binance WebSocket.

Connects to Binance Futures `!forceOrder@arr` stream to detect liquidation events.
Aggregates in 5-minute rolling windows per symbol and writes cascade signals to Redis.

Signals for Cryonix auto-trade:
  - Large long liquidations → capitulation (potential dip-buy after cascade ends)
  - Large short liquidations → short squeeze (momentum signal)
  - Active cascade → don't buy during waterfall

No API key needed — Binance WebSocket is free.
"""

import asyncio
import json
import time
from collections import defaultdict
from typing import Dict, List

try:
    import websockets
    HAS_WS = True
except ImportError:
    HAS_WS = False

import redis.asyncio as aioredis
from ..core.config import get_toml


# Rolling window for aggregation
WINDOW_SECONDS = 300  # 5 minutes
WRITE_INTERVAL = 30   # Write to Redis every 30s
CASCADE_THRESHOLD_USD = 5_000_000  # $5M in 5 min = cascade

# Symbols we track (futures symbols map to spot)
FUTURES_TO_SPOT = {
    'BTCUSDT': 'BTC', 'ETHUSDT': 'ETH', 'SOLUSDT': 'SOL',
    'XRPUSDT': 'XRP', 'AVAXUSDT': 'AVAX', 'LINKUSDT': 'LINK',
    'ADAUSDT': 'ADA', 'DOTUSDT': 'DOT', 'NEARUSDT': 'NEAR',
    'SUIUSDT': 'SUI', 'ATOMUSDT': 'ATOM', 'INJUSDT': 'INJ',
    'ARBUSDT': 'ARB', 'UNIUSDT': 'UNI', 'RENDERUSDT': 'RENDER',
}


class LiquidationEvent:
    def __init__(self, symbol: str, side: str, qty: float, price: float, timestamp: float):
        self.symbol = symbol
        self.side = side  # 'BUY' = short liquidated, 'SELL' = long liquidated
        self.qty = qty
        self.price = price
        self.usd_value = qty * price
        self.timestamp = timestamp


class LiquidationScout:
    def __init__(self, kv_url: str):
        self.redis = aioredis.from_url(kv_url, decode_responses=True)
        self.events: List[LiquidationEvent] = []
        self.running = False
        self.ws_url = 'wss://fstream.binance.com/ws/!forceOrder@arr'
        self.last_write = 0

    async def start(self):
        if not HAS_WS:
            print('[LiquidationScout] websockets not installed — skipping')
            return

        self.running = True
        print('[LiquidationScout] Starting liquidation monitoring...')

        # Run WebSocket listener and Redis writer in parallel
        await asyncio.gather(
            self._ws_listener(),
            self._redis_writer(),
        )

    async def stop(self):
        self.running = False

    async def _ws_listener(self):
        """Connect to Binance futures forceOrder stream."""
        while self.running:
            try:
                async with websockets.connect(self.ws_url, ping_interval=30) as ws:
                    print('[LiquidationScout] Connected to Binance liquidation stream')
                    async for msg in ws:
                        if not self.running:
                            break
                        try:
                            data = json.loads(msg)
                            order = data.get('o', {})
                            symbol = order.get('s', '')
                            side = order.get('S', '')  # BUY = short liq, SELL = long liq
                            qty = float(order.get('q', 0))
                            price = float(order.get('p', 0))

                            if symbol in FUTURES_TO_SPOT and qty > 0 and price > 0:
                                event = LiquidationEvent(
                                    symbol=FUTURES_TO_SPOT[symbol],
                                    side=side,
                                    qty=qty,
                                    price=price,
                                    timestamp=time.time(),
                                )
                                self.events.append(event)

                                # Log large liquidations
                                if event.usd_value > 100_000:
                                    liq_type = 'SHORT-LIQ' if side == 'BUY' else 'LONG-LIQ'
                                    print(f'[LiquidationScout] {liq_type} {event.symbol}: ${event.usd_value:,.0f}')

                        except (json.JSONDecodeError, ValueError):
                            continue

            except Exception as e:
                print(f'[LiquidationScout] WS error: {e}. Reconnecting in 5s...')
                await asyncio.sleep(5)

    async def _redis_writer(self):
        """Periodically aggregate and write liquidation data to Redis."""
        while self.running:
            await asyncio.sleep(WRITE_INTERVAL)

            now = time.time()
            cutoff = now - WINDOW_SECONDS

            # Evict old events
            self.events = [e for e in self.events if e.timestamp >= cutoff]

            # Aggregate per symbol
            per_symbol: Dict[str, Dict] = defaultdict(lambda: {
                'longs': 0, 'shorts': 0, 'long_count': 0, 'short_count': 0,
            })

            total_longs = 0
            total_shorts = 0

            for event in self.events:
                bucket = per_symbol[event.symbol]
                if event.side == 'SELL':  # Long liquidated
                    bucket['longs'] += event.usd_value
                    bucket['long_count'] += 1
                    total_longs += event.usd_value
                else:  # Short liquidated
                    bucket['shorts'] += event.usd_value
                    bucket['short_count'] += 1
                    total_shorts += event.usd_value

            # Write per-symbol cascades
            try:
                pipeline = self.redis.pipeline()
                for symbol, data in per_symbol.items():
                    net = data['shorts'] - data['longs']  # positive = more shorts liq'd (bullish)
                    is_cascade = (data['longs'] > CASCADE_THRESHOLD_USD or
                                  data['shorts'] > CASCADE_THRESHOLD_USD)

                    cascade_data = json.dumps({
                        'longs_usd': round(data['longs']),
                        'shorts_usd': round(data['shorts']),
                        'net_liquidation': round(net),
                        'long_count': data['long_count'],
                        'short_count': data['short_count'],
                        'is_cascade': is_cascade,
                        'window_seconds': WINDOW_SECONDS,
                        'timestamp': now,
                    })
                    pipeline.setex(f'liquidation:cascade:{symbol}', 600, cascade_data)  # 10 min TTL

                # Summary
                pipeline.setex('liquidation:summary', 600, json.dumps({
                    'total_longs_5m': round(total_longs),
                    'total_shorts_5m': round(total_shorts),
                    'net': round(total_shorts - total_longs),
                    'symbols_active': len(per_symbol),
                    'events_in_window': len(self.events),
                    'timestamp': now,
                }))

                await pipeline.execute()

                if total_longs > 1_000_000 or total_shorts > 1_000_000:
                    print(f'[LiquidationScout] 5m summary: longs=${total_longs:,.0f} shorts=${total_shorts:,.0f} net=${total_shorts - total_longs:,.0f} events={len(self.events)}')

            except Exception as e:
                print(f'[LiquidationScout] Redis write error: {e}')
