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
  }

  // 3. Final fallback: fetch directly from Alpaca API
  try {
    const apiKey = process.env.ALPACA_PAPER_API_KEY || process.env.ALPACA_API_KEY;
    const apiSecret = process.env.ALPACA_PAPER_API_SECRET || process.env.ALPACA_API_SECRET;
    if (apiKey && apiSecret) {
      const res = await fetch('https://paper-api.alpaca.markets/v2/positions', {
        headers: { 'APCA-API-KEY-ID': apiKey, 'APCA-API-SECRET-KEY': apiSecret },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const raw = await res.json();
        const positions: AktienixPosition[] = raw.map((p: any) => ({
          symbol: p.symbol,
          qty: parseFloat(p.qty),
          avgEntryPrice: parseFloat(p.avg_entry_price),
          currentPrice: parseFloat(p.current_price),
          marketValue: parseFloat(p.market_value),
          unrealizedPl: parseFloat(p.unrealized_pl),
          unrealizedPlPct: parseFloat(p.unrealized_plpc) * 100,
          openedAt: new Date().toISOString(),
          broker: 'alpaca',
          paperTrading: true,
        }));
        // Cache for 5min
        try { await redis.set('aktienix:positions', JSON.stringify(positions), 'EX', 300); } catch { }
        return NextResponse.json({ positions, source: 'alpaca', count: positions.length });
      }
    }
  } catch { /* Alpaca unavailable */ }

  return NextResponse.json({ positions: [], source: 'none', count: 0 });
}
