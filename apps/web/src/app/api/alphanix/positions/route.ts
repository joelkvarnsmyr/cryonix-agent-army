import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

/** Safely parse a Redis value that might be JSON or a plain string. */
function safeParse<T = any>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw as unknown as T; }
}

export async function GET() {
  const positions: Record<string, any[]> = {};

  try {
    const orchRaw = await redis.get('alphanix:orchestrator:state');
    let podIds: string[] = [];

    if (orchRaw) {
      const orch = safeParse<any>(orchRaw as string);
      if (orch?.pods) {
        podIds = Object.keys(orch.pods);
      }
    }

    // Fallback: discover pods via key scan if orchestrator state is missing
    if (podIds.length === 0) {
      try {
        const keys = await redis.keys('alphanix:pod:*:positions');
        for (const key of keys) {
          const match = key.match(/^alphanix:pod:(.+):positions$/);
          if (match) podIds.push(match[1]);
        }
      } catch {}
    }

    // Fetch all pod positions in parallel
    if (podIds.length > 0) {
      const results = await Promise.all(
        podIds.map(async (podId) => {
          const posRaw = await redis.get(`alphanix:pod:${podId}:positions`);
          return [podId, safeParse<any[]>(posRaw as string) ?? []] as const;
        }),
      );
      for (const [podId, pos] of results) {
        positions[podId] = pos;
      }
    }
  } catch (error) {
    console.error('[alphanix/positions] Redis error:', error);
  }

  return NextResponse.json({ positions, timestamp: new Date().toISOString() });
}
