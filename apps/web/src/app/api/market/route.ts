import { NextRequest, NextResponse } from 'next/server';
import ccxt from 'ccxt';

// Initialize Binance exchange for public market data
// Note: For public data (tickers, OHLCV), we use production Binance
// since testnet has limited market data availability
const exchange = new ccxt.binance({
  enableRateLimit: true,
  // No API keys needed for public market data
});

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
        const symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
        const tickers = await Promise.all(
          symbols.map(async (sym) => {
            const ticker = await exchange.fetchTicker(sym);
            return {
              symbol: ticker.symbol,
              price: ticker.last,
              change24h: ticker.percentage,
              volume24h: ticker.baseVolume,
            };
          })
        );
        return NextResponse.json({ success: true, data: tickers });
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
