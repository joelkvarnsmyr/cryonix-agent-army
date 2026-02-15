import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

/**
 * POST /api/scanner-history
 * Stores GainerScanner snapshots as a time-series in Redis lists.
 * Keeps last 96 snapshots (24h at 15min intervals).
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const snapshot = {
      ...body,
      stored_at: new Date().toISOString(),
    };

    await redis.lpush('scanner:history', JSON.stringify(snapshot));
    await redis.ltrim('scanner:history', 0, 95); // Keep 96 snapshots = 24h

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error storing scanner history:', error);
    return NextResponse.json({ success: false }, { status: 500 });
  }
}

/**
 * GET /api/scanner-history
 * Returns scanner snapshots for analysis.
 * Query: ?limit=10 (default 10)
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '10');

    const raw = await redis.lrange('scanner:history', 0, limit - 1);
    const snapshots = raw.map(r => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);

    return NextResponse.json({ success: true, count: snapshots.length, data: snapshots });
  } catch (error) {
    return NextResponse.json({ success: false }, { status: 500 });
  }
}
