import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface AktienixTrade {
  symbol: string;
  qty: number;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  signal: string | null;
  openedAt: string;
  closedAt: string;
  exitReason: string | null;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100);

  try {
    const raw = await redis.get('aktienix:trades:history');
    const all: AktienixTrade[] = raw ? JSON.parse(raw as string) : [];
    const trades = all.slice(0, limit);
    const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
    const winCount = trades.filter(t => t.pnl > 0).length;
    return NextResponse.json({
      trades,
      summary: {
        total: trades.length,
        winRate: trades.length > 0 ? winCount / trades.length : 0,
        totalPnl,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
