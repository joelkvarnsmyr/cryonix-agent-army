import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export interface PolynixPositionApi {
  id: string;
  market: {
    conditionId: string;
    title: string;
    asset: string;
    expiresAt: number;
    timeToExpiry: number;
  };
  type: 'arb' | 'directional';
  side: 'YES' | 'NO' | 'BOTH';
  entryPrice: number;
  size: number;
  costBasis: number;
  enteredAt: number;
  expiresAt: number;
  status: string;
  pnl: number;
  currentPrice?: number;
  unrealizedPnl?: number;
}

/** Load open positions from Postgres when Redis keys have expired. */
async function loadPositionsFromDb(): Promise<PolynixPositionApi[]> {
  try {
    const rows = await db.execute(sql.raw(`
      SELECT id, type, side, entry_price, size, cost_basis,
             entered_at, expires_at, market_data, status
      FROM polynix_trades
      WHERE status = 'open'
      ORDER BY entered_at
    `));
    return Array.from(rows as any).map((r: any) => {
      const market = typeof r.market_data === 'string'
        ? JSON.parse(r.market_data)
        : (r.market_data ?? {});
      const expiresAt = new Date(r.expires_at).getTime();
      return {
        id: r.id,
        market: {
          conditionId: market.conditionId ?? '',
          title: market.title ?? r.market_title ?? '',
          asset: market.asset ?? r.asset ?? '',
          expiresAt,
          timeToExpiry: Math.max(0, expiresAt - Date.now()),
        },
        type: r.type as 'arb' | 'directional',
        side: r.side as 'YES' | 'NO' | 'BOTH',
        entryPrice: parseFloat(r.entry_price) || 0,
        size: parseFloat(r.size) || 0,
        costBasis: parseFloat(r.cost_basis) || 0,
        enteredAt: new Date(r.entered_at).getTime(),
        expiresAt,
        status: r.status,
        pnl: 0,
      };
    });
  } catch (err) {
    console.error('[polynix/positions] Postgres fallback error:', err);
    return [];
  }
}

export async function GET() {
  // Try Redis first (live data from running agent)
  try {
    const raw = await redis.get('polynix:positions');
    if (raw) {
      const positions: PolynixPositionApi[] = JSON.parse(raw as string);
      return NextResponse.json({
        positions,
        source: 'redis',
        count: positions.length,
      });
    }
  } catch (error) {
    console.error('[polynix/positions] Redis error:', error);
  }

  // Fallback: load open positions from Postgres
  const positions = await loadPositionsFromDb();
  return NextResponse.json({
    positions,
    source: positions.length > 0 ? 'postgres' : 'empty',
    count: positions.length,
  });
}
