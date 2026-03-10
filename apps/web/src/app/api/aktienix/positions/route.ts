import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export interface AktienixPosition {
  id?: number;
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  stopLoss?: number;
  takeProfit?: number;
  openedAt: string;
  status?: string;
  broker?: string;
  paperTrading?: boolean;
}

export async function GET() {
  // 1. Try Redis first (TTL 5min set by the agent)
  try {
    const raw = await redis.get('aktienix:positions');
    if (raw) {
      const positions: AktienixPosition[] = JSON.parse(raw as string);
      return NextResponse.json({
        positions,
        source: 'redis',
        count: positions.length,
      });
    }
  } catch (error) {
    console.error('[aktienix/positions] Redis error, falling back to DB:', error);
  }

  // 2. Fallback to Postgres
  try {
    const rows = await db.execute(sql`
      SELECT
        id,
        symbol,
        qty,
        avg_entry_price AS "avgEntryPrice",
        current_price   AS "currentPrice",
        market_value    AS "marketValue",
        unrealized_pl   AS "unrealizedPl",
        CASE
          WHEN avg_entry_price > 0
          THEN (unrealized_pl / (avg_entry_price * qty)) * 100
          ELSE 0
        END             AS "unrealizedPlPct",
        opened_at       AS "openedAt",
        status,
        broker,
        paper_trading   AS "paperTrading"
      FROM aktienix_positions
      WHERE status = 'OPEN'
      ORDER BY opened_at DESC
    `);

    const positions = Array.from(rows) as unknown as AktienixPosition[];
    return NextResponse.json({
      positions,
      source: 'database',
      count: positions.length,
    });
  } catch (error) {
    console.error('[aktienix/positions] DB error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch positions', details: String(error) },
      { status: 500 }
    );
  }
}
