import { NextResponse } from 'next/server';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export interface AktienixTrade {
  id?: number;
  symbol: string;
  qty: number;
  entryPrice: number;
  exitPrice: number | null;
  pnl: number | null;
  pnlPct: number | null;
  side: 'BUY' | 'SELL';
  signal: string | null;
  openedAt: string;
  closedAt: string | null;
  exitReason: string | null;
  broker?: string;
  paperTrading?: boolean;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const parsed = parseInt(searchParams.get('limit') || '50', 10);
  const limit = isNaN(parsed) ? 50 : Math.min(parsed, 200);
  const symbolFilter = searchParams.get('symbol');
  const sideFilter = searchParams.get('side');

  try {
    // Build WHERE clauses dynamically
    const conditions: string[] = [];
    if (symbolFilter) conditions.push(`symbol = '${symbolFilter.toUpperCase().replace(/'/g, "''")}'`);
    if (sideFilter && (sideFilter === 'BUY' || sideFilter === 'SELL')) {
      conditions.push(`side = '${sideFilter}'`);
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await db.execute(
      sql.raw(`SELECT COUNT(*) AS total FROM aktienix_trades ${whereClause}`)
    );
    const total = parseInt((countResult.rows[0] as { total: string }).total, 10) || 0;

    const rows = await db.execute(
      sql.raw(`
        SELECT
          id,
          symbol,
          qty,
          entry_price  AS "entryPrice",
          exit_price   AS "exitPrice",
          pnl,
          pnl_pct      AS "pnlPct",
          side,
          signal,
          opened_at    AS "openedAt",
          closed_at    AS "closedAt",
          exit_reason  AS "exitReason",
          broker,
          paper_trading AS "paperTrading"
        FROM aktienix_trades
        ${whereClause}
        ORDER BY opened_at DESC
        LIMIT ${limit}
      `)
    );

    return NextResponse.json({
      trades: rows.rows as AktienixTrade[],
      total,
    });
  } catch (error) {
    console.error('[aktienix/trades] DB error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch trades', details: String(error) },
      { status: 500 }
    );
  }
}
