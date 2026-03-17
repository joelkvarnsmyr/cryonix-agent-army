import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface AktienixAccount {
  portfolioValue: number;
  buyingPower: number;
  settledCash: number;
  isPatternDayTrader: boolean;
  dailyPnl: number;
  dailyPnlPct: number;
  updatedAt: string | null;
}

export async function GET() {
  try {
    // 1. Try Redis cache first
    const raw = await redis.get('aktienix:account');
    if (raw) {
      const data = JSON.parse(raw as string) as AktienixAccount;
      return NextResponse.json(data);
    }
  } catch { /* fall through */ }

  // 2. Fallback: fetch directly from Alpaca API
  try {
    const apiKey = process.env.ALPACA_PAPER_API_KEY || process.env.ALPACA_API_KEY;
    const apiSecret = process.env.ALPACA_PAPER_API_SECRET || process.env.ALPACA_API_SECRET;
    if (apiKey && apiSecret) {
      const res = await fetch('https://paper-api.alpaca.markets/v2/account', {
        headers: { 'APCA-API-KEY-ID': apiKey, 'APCA-API-SECRET-KEY': apiSecret },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const acc = await res.json();
        const data: AktienixAccount = {
          portfolioValue: parseFloat(acc.portfolio_value),
          buyingPower: parseFloat(acc.buying_power),
          settledCash: parseFloat(acc.cash),
          isPatternDayTrader: acc.pattern_day_trader,
          dailyPnl: parseFloat(acc.equity) - parseFloat(acc.last_equity),
          dailyPnlPct: parseFloat(acc.last_equity) > 0
            ? ((parseFloat(acc.equity) - parseFloat(acc.last_equity)) / parseFloat(acc.last_equity)) * 100
            : 0,
          updatedAt: new Date().toISOString(),
        };
        // Cache for 5min
        try { await redis.set('aktienix:account', JSON.stringify(data), 'EX', 300); } catch { }
        return NextResponse.json(data);
      }
    }
  } catch { /* Alpaca unavailable */ }

  // 3. Return empty
  return NextResponse.json({
    portfolioValue: 0, buyingPower: 0, settledCash: 0,
    isPatternDayTrader: false, dailyPnl: 0, dailyPnlPct: 0, updatedAt: null,
  } satisfies AktienixAccount);
}
