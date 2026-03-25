import { NextRequest, NextResponse } from 'next/server';
import ccxt from 'ccxt';

// Initialize Binance exchange for public market data
// Note: For public data (tickers, OHLCV), we use production Binance
// since testnet has limited market data availability
const exchange = new ccxt.binance({
  enableRateLimit: true,
  // No API keys needed for public market data
});

// Simple in-memory cache to prevent rate limits
let tickersCache: { data: any; timestamp: number } = { data: null, timestamp: 0 };
const CACHE_DURATION = 10000; // 10 seconds

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const symbol = searchParams.get('symbol') || 'BTC/USDT';
    const action = searchParams.get('action') || 'ticker';

    switch (action) {
      case 'ticker': {
        const ticker = await exchange.fetchTicker(symbol);
        return NextResponse.json({
          success: true,
          data: {
            symbol: ticker.symbol,
            price: ticker.last,
            high24h: ticker.high,
            low24h: ticker.low,
            volume24h: ticker.baseVolume,
            change24h: ticker.percentage,
            timestamp: ticker.timestamp,
          },
        });
      }

      case 'tickers': {
        const now = Date.now();
        if (tickersCache.data && (now - tickersCache.timestamp < CACHE_DURATION)) {
          return NextResponse.json({ success: true, data: tickersCache.data });
        }

        const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
        const tickers = await Promise.all(
          symbols.map(async (sym) => {
            try {
              const ticker = await exchange.fetchTicker(sym);
              return {
                symbol: ticker.symbol,
                price: ticker.last,
                change24h: ticker.percentage,
                volume24h: ticker.baseVolume,
              };
            } catch (e) {
              console.error(`Failed to fetch ticker for ${sym}`, e);
              return null;
            }
          })
        );

        const validTickers = tickers.filter(t => t !== null);
        if (validTickers.length > 0) {
          tickersCache = { data: validTickers, timestamp: now };
        }

        return NextResponse.json({ success: true, data: validTickers });
      }

      case 'ohlcv': {
        const timeframe = searchParams.get('timeframe') || '15m';
        const limit = parseInt(searchParams.get('limit') || '100');
        const ohlcv = await exchange.fetchOHLCV(symbol, timeframe, undefined, limit);

        const candles = ohlcv.map(([timestamp, open, high, low, close, volume]) => ({
          timestamp,
          open,
          high,
          low,
          close,
          volume,
        }));

        return NextResponse.json({ success: true, data: candles });
      }

      case 'orderbook': {
        const orderbook = await exchange.fetchOrderBook(symbol, 20);
        return NextResponse.json({
          success: true,
          data: {
            bids: orderbook.bids.slice(0, 10),
            asks: orderbook.asks.slice(0, 10),
          },
        });
      }

      default:
        return NextResponse.json(
          { success: false, error: 'Invalid action' },
          { status: 400 }
        );
    }
  } catch (error: any) {
    console.error('Market API Error:', error);
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}
