import { NextResponse } from 'next/server';
import { db } from '@cryonix/database';
import { positionHistory, trades } from '@cryonix/database';
import { desc, gte, and, eq } from 'drizzle-orm';

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
    const cutoff14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    // Last 50 closed positions (14 days)
    const closedPositions = await db.select({
      symbol: positionHistory.symbol,
      pattern: positionHistory.pattern,
      entryPrice: positionHistory.entryPrice,
      exitPrice: positionHistory.exitPrice,
      pnlPercent: positionHistory.pnlPercent,
      closeReason: positionHistory.closeReason,
      holdingPeriod: positionHistory.holdingPeriod,
      openedAt: positionHistory.openedAt,
      closedAt: positionHistory.closedAt,
    }).from(positionHistory)
      .where(gte(positionHistory.closedAt, cutoff14d))
      .orderBy(desc(positionHistory.closedAt))
      .limit(50);

    // Last 20 BUY trades
    const recentBuys = await db.select({
      symbol: trades.symbol,
      pattern: trades.pattern,
      entryPrice: trades.entryPrice,
      confidence: trades.confidence,
      timestamp: trades.timestamp,
    }).from(trades)
      .where(and(
        gte(trades.timestamp, cutoff14d),
        eq(trades.side, 'BUY'),
      ))
      .orderBy(desc(trades.timestamp))
      .limit(20);

    const closed = closedPositions.map(r => ({
      symbol: r.symbol,
      pattern: r.pattern,
      entryPrice: parseFloat(r.entryPrice || '0'),
      exitPrice: parseFloat(r.exitPrice || '0'),
      pnlPercent: parseFloat(r.pnlPercent || '0'),
      closeReason: r.closeReason,
      holdingPeriodH: Math.round((r.holdingPeriod || 0) / 360) / 10,
      openedAt: r.openedAt,
      closedAt: r.closedAt,
    }));

    const buys = recentBuys.map(t => ({
      symbol: t.symbol,
      pattern: t.pattern,
      entryPrice: parseFloat(t.entryPrice || '0'),
      confidence: parseFloat(t.confidence || '0'),
      timestamp: t.timestamp,
    }));

    return NextResponse.json(
      { closed, buys, generatedAt: new Date().toISOString() },
      {
        headers: {
          ...CORS_HEADERS,
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=120',
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
