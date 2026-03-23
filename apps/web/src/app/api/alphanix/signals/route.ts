import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  const signals: Record<string, any[]> = {};
  try {
    const orchRaw = await redis.get('alphanix:orchestrator:state');
    if (orchRaw) {
      const orch = JSON.parse(orchRaw as string);
      for (const podId of Object.keys(orch.pods || {})) {
        const sigRaw = await redis.lrange(`alphanix:pod:${podId}:signals`, 0, 49);
        signals[podId] = sigRaw ? sigRaw.map((s: string) => { try { return JSON.parse(s); } catch { return s; } }) : [];
      }
    }
  } catch (error) {
    console.error('[alphanix/signals] Redis error:', error);
  }
  return NextResponse.json({ signals, timestamp: new Date().toISOString() });
}
