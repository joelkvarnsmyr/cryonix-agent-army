import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

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
  status: 'won' | 'lost' | 'settled' | 'exited';
  enteredAt: number;
  settledAt: number;
  exitReason?: 'take_profit' | 'stop_loss' | 'stagnation';
  exitPrice?: number;
}

/** Load settled trades from Postgres when Redis keys have expired. */
async function loadTradesFromDb(): Promise<PolynixTrade[]> {
  try {
    const rows = await db.execute(sql.raw(`
      SELECT id, type, side, market_title, asset, entry_price, size,
             cost_basis, pnl, status, entered_at, settled_at, expires_at,
             exit_reason, exit_price
      FROM polynix_trades
      WHERE status != 'open'
      ORDER BY settled_at DESC NULLS LAST
      LIMIT 50
    `));
    return Array.from(rows as any).map((r: any) => ({
      id: r.id ?? '',
      type: (r.type ?? 'directional') as 'arb' | 'directional',
      side: (r.side ?? 'YES') as 'YES' | 'NO' | 'BOTH',
      marketTitle: r.market_title ?? '',
      asset: r.asset ?? '',
      entryPrice: parseFloat(r.entry_price) || 0,
      size: parseFloat(r.size) || 0,
      costBasis: parseFloat(r.cost_basis) || 0,
      pnl: parseFloat(r.pnl) || 0,
      status: r.status ?? 'settled',
      enteredAt: r.entered_at ? new Date(r.entered_at).getTime() : 0,
      settledAt: r.settled_at ? new Date(r.settled_at).getTime()
        : (r.expires_at ? new Date(r.expires_at).getTime() : Date.now()),
      exitReason: r.exit_reason ?? undefined,
      exitPrice: r.exit_price != null ? parseFloat(r.exit_price) : undefined,
    }));
  } catch (err) {
    console.error('[polynix/trades] Postgres fallback error:', err);
    return [];
  }
}

function mapRedisToTrades(parsed: any[]): PolynixTrade[] {
  return parsed.map((t: any) => ({
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
    exitReason: t.exitReason,
    exitPrice: t.exitPrice,
  }));
}

export async function GET() {
  let trades: PolynixTrade[] = [];
  let source = 'empty';

  // Try Redis first (live data from running agent)
  try {
    const raw = await redis.get('polynix:trades');
    if (raw) {
      const parsed = JSON.parse(raw as string);
      trades = mapRedisToTrades(Array.isArray(parsed) ? parsed : []);
      source = 'redis';
    }
  } catch (error) {
    console.error('[polynix/trades] Redis error:', error);
  }

  // Fallback: load settled trades from Postgres
  if (trades.length === 0) {
    trades = await loadTradesFromDb();
    if (trades.length > 0) source = 'postgres';
  }

  const wins = trades.filter(t => t.pnl >= 0).length;
  const losses = trades.filter(t => t.pnl < 0).length;
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);

  return NextResponse.json({
    trades: trades.slice(0, 50),
    source,
    summary: {
      total: trades.length,
      wins,
      losses,
      winRate: trades.length > 0 ? wins / trades.length : 0,
      totalPnl,
    },
  });
}
