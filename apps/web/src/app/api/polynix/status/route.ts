import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  let agentStatus: string | null = null;
  let account: any = null;
  let risk: any = null;
  let lastSignal: any = null;

  try {
    const [statusRaw, accountRaw, riskRaw, signalRaw] = await Promise.all([
      redis.get('polynix:status'),
      redis.get('polynix:account'),
      redis.get('polynix:risk'),
      redis.get('polynix:last_signal'),
    ]);

    agentStatus = (statusRaw as string) ?? null;
    if (accountRaw) try { account = JSON.parse(accountRaw as string); } catch { /* ignore */ }
    if (riskRaw) try { risk = JSON.parse(riskRaw as string); } catch { /* ignore */ }
    if (signalRaw) try { lastSignal = JSON.parse(signalRaw as string); } catch { /* ignore */ }
  } catch (error) {
    console.error('[polynix/status] Redis error:', error);
  }

  // Determine if agent is running: status key set OR fresh account data exists
  const isRunning = agentStatus === 'running' || (account !== null && risk !== null);

  return NextResponse.json({
    status: agentStatus,
    agent: {
      running: isRunning,
      paperTrading: true, // Phase 1 is always paper
    },
    account,
    risk,
    lastSignal,
    timestamp: new Date().toISOString(),
  });
}
