import { NextResponse } from 'next/server';
import { db } from '@cryonix/database';
import { positionHistory } from '@cryonix/database';
import { desc, gte, sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET() {
  try {
    const cutoff30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const rows = await db.select({
      symbol: positionHistory.symbol,
      pattern: positionHistory.pattern,
      pnl: positionHistory.pnl,
      pnlPercent: positionHistory.pnlPercent,
      holdingPeriod: positionHistory.holdingPeriod,
      closedAt: positionHistory.closedAt,
    }).from(positionHistory)
      .where(gte(positionHistory.closedAt, cutoff30d))
      .orderBy(desc(positionHistory.closedAt))
      .limit(500);

    const totalTrades = rows.length;
    if (totalTrades === 0) {
      return NextResponse.json(
        {
          totalTrades: 0,
          winRate: 0,
          avgHoldingTimeH: 0,
          patterns: [],
          generatedAt: new Date().toISOString(),
        },
        {
          headers: {
            ...CORS_HEADERS,
            'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
          },
        }
      );
    }

    const wins = rows.filter(r => parseFloat(r.pnl || '0') > 0).length;
    const winRate = parseFloat((wins / totalTrades * 100).toFixed(1));
    const avgHoldingTimeH = parseFloat(
      (rows.reduce((s, r) => s + (r.holdingPeriod || 0), 0) / totalTrades / 3600).toFixed(1)
    );

    // Pattern breakdown
    const patternMap: Record<string, { trades: number; wins: number }> = {};
    for (const r of rows) {
      const p = r.pattern || 'unknown';
      if (!patternMap[p]) patternMap[p] = { trades: 0, wins: 0 };
      patternMap[p].trades++;
      if (parseFloat(r.pnl || '0') > 0) patternMap[p].wins++;
    }

    const patterns = Object.entries(patternMap)
      .map(([name, data]) => ({
        name,
        trades: data.trades,
        winRate: parseFloat((data.wins / data.trades * 100).toFixed(1)),
      }))
      .sort((a, b) => b.trades - a.trades);

    return NextResponse.json(
      {
        totalTrades,
        winRate,
        avgHoldingTimeH,
        patterns,
        generatedAt: new Date().toISOString(),
      },
      {
        headers: {
          ...CORS_HEADERS,
          'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
        },
      }
    );
  } catch (error: any) {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
