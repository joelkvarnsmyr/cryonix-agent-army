import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface PolynixTrade {
  id: string;
  type: 'arb' | 'directional';
  side: 'YES' | 'NO' | 'BOTH';
  marketTitle: string;
  asset: string;
  entryPrice: number;
  size: number;
  costBasis: number;
  pnl: number;
  status: 'won' | 'lost' | 'settled';
  enteredAt: number;
  settledAt: number;
}

export async function GET() {
  // Trades are stored in the account state as settled history
  // For now, read from polynix:trades Redis key (set by agent)
  let trades: PolynixTrade[] = [];
  let lastSignal: any = null;

  try {
    const [tradesRaw, signalRaw] = await Promise.all([
      redis.get('polynix:trades'),
      redis.get('polynix:last_signal'),
    ]);

    if (tradesRaw) {
      trades = JSON.parse(tradesRaw as string);
    }
    if (signalRaw) {
      try { lastSignal = JSON.parse(signalRaw as string); } catch { /* ignore */ }
    }
  } catch (error) {
    console.error('[polynix/trades] Redis error:', error);
  }

  const wins = trades.filter(t => t.pnl >= 0).length;
  const losses = trades.filter(t => t.pnl < 0).length;
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  return NextResponse.json({
    trades: trades.slice(0, 50),
    summary: {
      total: trades.length,
      wins,
      losses,
      winRate: trades.length > 0 ? wins / trades.length : 0,
      totalPnl,
    },
    lastSignal,
  });
}
