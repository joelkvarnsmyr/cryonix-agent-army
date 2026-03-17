import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  let traderTrades: any[] = [];
  let btdTrades: any[] = [];
  let futuresTrades: any[] = [];

  try {
    const [traderRaw, btdRaw, futuresRaw] = await Promise.all([
      redis.lrange('vedic_trader:trades', 0, 99),
      redis.lrange('vedic_btd:trades', 0, 99),
      redis.lrange('vedic_futures:trades', 0, 99),
    ]);

    if (traderRaw) {
      traderTrades = (traderRaw as string[]).map((r: string) => {
        try {
          const t = JSON.parse(r);
          return { ...t, source: 'trader' };
        } catch { return null; }
      }).filter(Boolean);
    }

    if (btdRaw) {
      btdTrades = (btdRaw as string[]).map((r: string) => {
        try {
          const t = JSON.parse(r);
          return { ...t, source: 'btd' };
        } catch { return null; }
      }).filter(Boolean);
    }
    if (futuresRaw) {
      futuresTrades = (futuresRaw as string[]).map((r: string) => {
        try {
          const t = JSON.parse(r);
          return { ...t, source: 'futures' };
        } catch { return null; }
      }).filter(Boolean);
    }
  } catch (error) {
    console.error('[vedic/trades] Redis error:', error);
  }

  // Merge and sort by timestamp (newest first)
  const allTrades = [...traderTrades, ...btdTrades, ...futuresTrades]
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
    .slice(0, 100);

  // Compute summary for SELL trades only
  const sells = allTrades.filter(t => t.action === 'SELL');
  const wins = sells.filter(t => (t.pnl ?? 0) > 0).length;
  const losses = sells.filter(t => (t.pnl ?? 0) <= 0).length;
  const totalPnl = sells.reduce((sum, t) => sum + (t.pnl ?? 0), 0);

  return NextResponse.json({
    trades: allTrades,
    summary: {
      total: sells.length,
      wins,
      losses,
      winRate: sells.length > 0 ? Math.round(wins / sells.length * 100) : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
    },
    counts: {
      trader: traderTrades.length,
      btd: btdTrades.length,
    },
  });
}
