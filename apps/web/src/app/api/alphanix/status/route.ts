import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  let orchestratorState: any = null;
  let podStates: Record<string, any> = {};
  let status: string | null = null;

  try {
    const [statusRaw, orchRaw] = await Promise.all([
      redis.get('alphanix:status'),
      redis.get('alphanix:orchestrator:state'),
    ]);

    status = statusRaw as string ?? null;
    if (orchRaw) {
      try { orchestratorState = JSON.parse(orchRaw as string); } catch {}
    }

    if (orchestratorState?.pods) {
      for (const podId of Object.keys(orchestratorState.pods)) {
        const [stateRaw, riskRaw, heartbeatRaw] = await Promise.all([
          redis.get(`alphanix:pod:${podId}:state`),
          redis.get(`alphanix:pod:${podId}:risk`),
          redis.get(`alphanix:pod:${podId}:heartbeat`),
        ]);
        podStates[podId] = {
          state: stateRaw,
          risk: riskRaw ? JSON.parse(riskRaw as string) : null,
          lastHeartbeat: heartbeatRaw ? parseInt(heartbeatRaw as string) : null,
        };
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
