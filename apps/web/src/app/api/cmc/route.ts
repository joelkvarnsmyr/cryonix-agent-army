import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [fearGreedRaw, globalRaw, regimeRaw] = await Promise.all([
      redis.get('cmc:fear_greed'),
      redis.get('cmc:global'),
      redis.get('market:regime'),
    ]);

    const fearGreed = fearGreedRaw ? JSON.parse(fearGreedRaw as string) : null;
    const global = globalRaw ? JSON.parse(globalRaw as string) : null;
    const regime = (regimeRaw as string) || 'unknown';

    return NextResponse.json({
      fearGreed,
      global,
      regime,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
