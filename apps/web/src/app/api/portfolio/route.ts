import { NextRequest, NextResponse } from 'next/server';
import ccxt from 'ccxt';

// Initialize Binance exchange
const isTestnet = process.env.BINANCE_TESTNET === 'true';
const exchange = new ccxt.binance({
  apiKey: process.env.BINANCE_API_KEY,
  secret: process.env.BINANCE_API_SECRET,
  enableRateLimit: true,
  sandbox: isTestnet,
});

// Set testnet URLs if using testnet
if (isTestnet) {
  exchange.setSandboxMode(true);
}

export async function GET(request: NextRequest) {
  try {
    // Check if we have valid API keys
    if (!process.env.BINANCE_API_KEY || !process.env.BINANCE_API_SECRET) {
      // Return mock portfolio for development without API keys
      return NextResponse.json({
        success: true,
        data: {
          totalValue: 10000,
          holdings: [
            { currency: 'USDT', amount: 5000, free: 5000, locked: 0, usdValue: 5000 },
            { currency: 'BTC', amount: 0.05, free: 0.05, locked: 0, usdValue: 4500 },
            { currency: 'ETH', amount: 0.3, free: 0.3, locked: 0, usdValue: 500 },
          ],
          updated: new Date().toISOString(),
          isMock: true,
        },
      });
    }

    // Fetch account balance
    const balance = await exchange.fetchBalance();

    // Filter non-zero balances
    const holdings = Object.entries(balance.total)
      .filter(([_, amount]) => (amount as number) > 0)
      .map(([currency, amount]) => ({
        currency,
        amount: amount as number,
        free: (balance.free as unknown as Record<string, number>)[currency] || 0,
        locked: (balance.used as unknown as Record<string, number>)[currency] || 0,
      }));

    // Calculate USD values for holdings
    const holdingsWithValue = await Promise.all(
      holdings.map(async (holding) => {
        let usdValue = 0;

        if (holding.currency === 'USDT' || holding.currency === 'USDC' || holding.currency === 'BUSD') {
          usdValue = holding.amount;
        } else {
          try {
            const ticker = await exchange.fetchTicker(`${holding.currency}/USDT`);
            usdValue = holding.amount * (ticker.last || 0);
          } catch {
            // If no USDT pair, try with BTC
            try {
              const btcTicker = await exchange.fetchTicker(`${holding.currency}/BTC`);
              const btcUsdtTicker = await exchange.fetchTicker('BTC/USDT');
              usdValue = holding.amount * (btcTicker.last || 0) * (btcUsdtTicker.last || 0);
            } catch {
              usdValue = 0;
            }
          }
        }

        return {
          ...holding,
          usdValue,
        };
      })
    );

    // Calculate total portfolio value
    const totalValue = holdingsWithValue.reduce((sum, h) => sum + h.usdValue, 0);

    // Sort by USD value
    holdingsWithValue.sort((a, b) => b.usdValue - a.usdValue);

    return NextResponse.json({
      success: true,
      data: {
        totalValue,
        holdings: holdingsWithValue,
        updated: new Date().toISOString(),
      },
    });
  } catch (error: any) {
    console.error('Portfolio API Error:', error.message);

    // Return mock data when Binance API fails (e.g., invalid keys, network issues)
    return NextResponse.json({
      success: true,
      data: {
        totalValue: 10000,
        holdings: [
          { currency: 'USDT', amount: 5000, free: 5000, locked: 0, usdValue: 5000 },
          { currency: 'BTC', amount: 0.05, free: 0.05, locked: 0, usdValue: 4500 },
          { currency: 'ETH', amount: 0.3, free: 0.3, locked: 0, usdValue: 500 },
        ],
        updated: new Date().toISOString(),
        isMock: true,
        error: error.message,
      },
    });
  }
}
