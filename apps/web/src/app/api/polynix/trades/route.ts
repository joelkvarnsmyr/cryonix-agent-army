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
  let trades: PolynixTrade[] = [];

  try {
    const raw = await redis.get('polynix:trades');
    if (raw) {
      const parsed = JSON.parse(raw as string);
      // Map agent PolynixPosition[] (settled) to PolynixTrade[]
      trades = (Array.isArray(parsed) ? parsed : []).map((t: any) => ({
        id: t.id ?? '',
        type: t.type ?? 'directional',
        side: t.side ?? 'YES',
        marketTitle: t.market?.title ?? t.marketTitle ?? '',
        asset: t.market?.asset ?? t.asset ?? '',
        entryPrice: t.entryPrice ?? 0,
        size: t.size ?? 0,
        costBasis: t.costBasis ?? 0,
        pnl: t.pnl ?? 0,
        status: t.status ?? 'settled',
        enteredAt: t.enteredAt ?? 0,
        settledAt: t.expiresAt ?? t.settledAt ?? Date.now(),
      }));
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
  });
}
