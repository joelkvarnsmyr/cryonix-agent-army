import { NextResponse } from 'next/server';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export interface AktienixTrade {
  id?: number;
  symbol: string;
  qty: number;
  fillPrice: number;
  realizedPnl: number | null;
  side: 'BUY' | 'SELL';
  reasoning: string | null;
  timestamp: string;
  exitReason: string | null;
  broker?: string;
  paperTrading?: boolean;
  orderId?: string | null;
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
    const total = parseInt(((Array.from(countResult)[0]) as { total: string }).total, 10) || 0;

    const rows = await db.execute(
      sql.raw(`
        SELECT
          id,
          symbol,
          qty,
          fill_price    AS "fillPrice",
          realized_pnl  AS "realizedPnl",
          side,
          reasoning,
          "timestamp",
          exit_reason   AS "exitReason",
          broker,
          paper_trading AS "paperTrading",
          order_id      AS "orderId"
        FROM aktienix_trades
        ${whereClause}
        ORDER BY "timestamp" DESC
        LIMIT ${limit}
      `)
    );

    const trades = Array.from(rows) as unknown as AktienixTrade[];

    // Summary: SELL trades with realized P&L are "closed" trades
    const closedTrades = trades.filter(t => t.side === 'SELL' && t.realizedPnl !== null);
    const wins = closedTrades.filter(t => (t.realizedPnl ?? 0) > 0).length;
    const totalPnl = closedTrades.reduce((sum, t) => sum + (t.realizedPnl ?? 0), 0);
    const winRate = closedTrades.length > 0 ? wins / closedTrades.length : 0;

    return NextResponse.json({
      trades,
      total,
      summary: {
        total: closedTrades.length,
        winRate,
        totalPnl,
      },
    });
  } catch (error) {
    console.error('[aktienix/trades] DB error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch trades', details: String(error) },
      { status: 500 }
    );
  }
}
