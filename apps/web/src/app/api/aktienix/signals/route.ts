import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export interface AktienixSignal {
  id?: number;
  symbol: string;
  action: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  patterns: string[];
  reasoning?: string;
  executed: boolean;
  executedAt?: string | null;
  createdAt: string;
  source?: string;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 100);
  const executedParam = searchParams.get('executed');
  const executedFilter =
    executedParam === 'true' ? true : executedParam === 'false' ? false : null;

  // 1. Try Redis first (list stored newest-first by agent)
  try {
    const rawItems = await redis.lrange('aktienix:signals', 0, limit - 1);
    if (rawItems && rawItems.length > 0) {
      let signals: AktienixSignal[] = rawItems.map((item) => {
        try { return JSON.parse(item as string); } catch { return null; }
      }).filter(Boolean) as AktienixSignal[];

      // Apply executed filter if requested
      if (executedFilter !== null) {
        signals = signals.filter((s) => s.executed === executedFilter);
      }

      return NextResponse.json({
        signals,
        source: 'redis',
      });
    }
  } catch (error) {
    console.error('[aktienix/signals] Redis error, falling back to DB:', error);
  }

  // 2. Fallback to Postgres
  try {
    const executedWhere =
      executedFilter === true
        ? "AND executed = true"
        : executedFilter === false
        ? "AND executed = false"
        : '';

    const rows = await db.execute(
      sql.raw(`
        SELECT
          id,
          symbol,
          action,
          confidence,
          patterns,
          reasoning,
          executed,
          executed_at  AS "executedAt",
          created_at   AS "createdAt",
          source
        FROM aktienix_signals
        WHERE 1=1 ${executedWhere}
        ORDER BY created_at DESC
        LIMIT ${limit}
      `)
    );

    return NextResponse.json({
      signals: Array.from(rows) as unknown as AktienixSignal[],
      source: 'database',
    });
  } catch (error) {
    console.error('[aktienix/signals] DB error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch signals', details: String(error) },
      { status: 500 }
    );
  }
}
