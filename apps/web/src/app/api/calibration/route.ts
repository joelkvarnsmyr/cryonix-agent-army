import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

// GET: Return current calibration data
export async function GET() {
  try {
    const cached = await redis.get('calibration:patterns');
    if (cached) {
      return NextResponse.json({ status: 'ok', data: JSON.parse(cached) });
    }
    return NextResponse.json({ status: 'empty', data: {} });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST: Run calibration from trade history and store in Redis
export async function POST() {
  try {
    // Query pattern performance from closed trades
    const rows = await db.execute(sql`
      SELECT 
        pattern,
        COUNT(*)::int as trades,
        COUNT(*) FILTER (WHERE pnl > 0)::int as wins,
        ROUND(100.0 * COUNT(*) FILTER (WHERE pnl > 0) / NULLIF(COUNT(*), 0), 1) as win_rate,
        ROUND(COALESCE(AVG(CASE WHEN pnl > 0 THEN pnl END), 0)::numeric, 6) as avg_win,
        ROUND(COALESCE(AVG(CASE WHEN pnl <= 0 THEN pnl END), 0)::numeric, 6) as avg_loss,
        ROUND(COALESCE(SUM(pnl), 0)::numeric, 6) as total_pnl
      FROM trades 
      WHERE status = 'CLOSED' AND pnl IS NOT NULL AND pattern IS NOT NULL AND pattern != ''
      GROUP BY pattern
      ORDER BY trades DESC
    `);

    const calibration: Record<string, any> = {};
    for (const r of rows as any[]) {
      const winRate = parseFloat(r.win_rate) || 0;
      const avgWin = parseFloat(r.avg_win) || 0;
      const avgLoss = parseFloat(r.avg_loss) || 0;
      const ev = (winRate / 100 * avgWin) - ((100 - winRate) / 100 * Math.abs(avgLoss));

      calibration[r.pattern] = {
        pattern: r.pattern,
        trades: r.trades,
        wins: r.wins,
        winRate,
        avgWin,
        avgLoss,
        ev: Math.round(ev * 10000) / 10000,
        totalPnl: parseFloat(r.total_pnl) || 0,
      };
    }

    // Store in Redis with 24h expiry (recalculated daily)
    await redis.set('calibration:patterns', JSON.stringify(calibration), 'EX', 86400);

    console.log(`[CALIBRATION] Updated ${Object.keys(calibration).length} patterns:`,
      Object.entries(calibration).map(([k, v]: [string, any]) => `${k}: ${v.winRate}% (${v.trades}t, EV=$${v.ev})`).join(', ')
    );

    return NextResponse.json({
      status: 'ok',
      patterns: Object.keys(calibration).length,
      data: calibration,
    });
  } catch (error) {
    console.error('[CALIBRATION] Error:', error);
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
