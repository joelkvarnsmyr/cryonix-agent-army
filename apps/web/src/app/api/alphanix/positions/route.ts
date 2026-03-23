import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  const positions: Record<string, any[]> = {};

  try {
    const orchRaw = await redis.get('alphanix:orchestrator:state');
    if (orchRaw) {
      const orch = JSON.parse(orchRaw as string);
      for (const podId of Object.keys(orch.pods || {})) {
        const posRaw = await redis.get(`alphanix:pod:${podId}:positions`);
        positions[podId] = posRaw ? JSON.parse(posRaw as string) : [];
      }
    }
  } catch (error) {
    console.error('[alphanix/positions] Redis error:', error);
  }

  return NextResponse.json({ positions, timestamp: new Date().toISOString() });
}
