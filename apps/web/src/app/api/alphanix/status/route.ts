import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

/** Safely parse a Redis value that might be JSON or a plain string. */
function safeParse<T = any>(raw: string | null): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw as unknown as T; }
}

export async function GET() {
  let orchestratorState: any = null;
  let podStates: Record<string, any> = {};
  let status: string | null = null;

  try {
    const [statusRaw, orchRaw] = await Promise.all([
      redis.get('alphanix:status'),
      redis.get('alphanix:orchestrator:state'),
    ]);

    // Status is a plain string (e.g. "running")
    status = (statusRaw as string) ?? null;

    // Parse orchestrator state
    if (orchRaw) {
      orchestratorState = safeParse(orchRaw as string);
    }

    // Build pod detail map from orchestrator pod list
    const podIds = orchestratorState?.pods
      ? Object.keys(orchestratorState.pods)
      : [];

    // If we have no pod list from orchestrator, try discovering pods via key scan
    if (podIds.length === 0) {
      try {
        const keys = await redis.keys('alphanix:pod:*:state');
        for (const key of keys) {
          const match = key.match(/^alphanix:pod:(.+):state$/);
          if (match) podIds.push(match[1]);
        }
      } catch {}
    }

    // Derive status from orchestrator if the status key expired
    if (!status && orchestratorState) {
      const runningCount = podIds.length;
      status = runningCount > 0 ? 'running' : 'stopped';
    }

    // Fetch per-pod details in parallel
    if (podIds.length > 0) {
      const results = await Promise.all(
        podIds.map(async (podId) => {
          const [stateRaw, riskRaw, heartbeatRaw] = await Promise.all([
            redis.get(`alphanix:pod:${podId}:state`),
            redis.get(`alphanix:pod:${podId}:risk`),
            redis.get(`alphanix:pod:${podId}:heartbeat`),
          ]);

          // Pod state may be JSON-encoded string (e.g. '"running"') or a plain string
          let podState: string | null = null;
          if (stateRaw) {
            const parsed = safeParse<any>(stateRaw as string);
            podState = typeof parsed === 'string' ? parsed : (stateRaw as string);
          }

          // If no per-pod state key, fall back to orchestrator pod status
          if (!podState && orchestratorState?.pods?.[podId]) {
            const orchPodVal = orchestratorState.pods[podId];
            podState = typeof orchPodVal === 'string' ? orchPodVal : orchPodVal?.state ?? null;
          }

          return [podId, {
            state: podState,
            risk: safeParse(riskRaw as string),
            lastHeartbeat: heartbeatRaw ? parseInt(heartbeatRaw as string, 10) : null,
          }] as const;
        }),
      );

      for (const [podId, info] of results) {
        podStates[podId] = info;
      }
    }
  } catch (error) {
    console.error('[alphanix/status] Redis error:', error);
  }

  return NextResponse.json({
    status,
    orchestrator: orchestratorState,
    pods: podStates,
    timestamp: new Date().toISOString(),
  });
}
