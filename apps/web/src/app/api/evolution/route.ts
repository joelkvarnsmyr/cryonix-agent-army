import { NextResponse } from 'next/server';
import { db, evolutionRuns } from '@cryonix/database';
import { desc } from 'drizzle-orm';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Fetch evolution runs from Postgres
    const runs = await db
      .select()
      .from(evolutionRuns)
      .orderBy(desc(evolutionRuns.startedAt))
      .limit(20);

    // Fetch latest evolution status from Redis
    const keys = await redis.keys('evolution:evo_*');
    const latestMeta: Record<string, any> = {};
    for (const key of keys.slice(0, 5)) {
      const data = await redis.hgetall(key);
      if (data && Object.keys(data).length > 0) {
        latestMeta[key.replace('evolution:', '')] = data;
      }
    }

    // Fetch calibration data (pattern performance from last evolution)
    let calibration = null;
    const calRaw = await redis.get('calibration:patterns');
    if (calRaw) {
      calibration = JSON.parse(calRaw);
    }

    return NextResponse.json({
      success: true,
      runs: runs.map(r => ({
        id: r.id,
        runId: r.runId,
        startedAt: r.startedAt?.toISOString(),
        endedAt: r.endedAt?.toISOString(),
        durationSeconds: r.durationSeconds,
        status: r.status,
        performanceData: r.performanceData,
        changesMade: r.changesMade,
      })),
      meta: latestMeta,
      calibration,
      totalRuns: runs.length,
    });
  } catch (error: any) {
    return NextResponse.json({
      success: false,
      runs: [],
      error: error.message,
    });
  }
}
