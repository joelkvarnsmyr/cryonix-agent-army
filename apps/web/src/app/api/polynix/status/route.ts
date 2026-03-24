import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

/** Build account stats from Postgres polynix_trades when Redis keys have expired. */
async function loadAccountFromDb(): Promise<any | null> {
  try {
    const statsRes = await db.execute(sql.raw(`
      SELECT
        COUNT(*) FILTER (WHERE status != 'open') AS settled,
        COUNT(*) FILTER (WHERE status != 'open' AND pnl > 0) AS wins,
        COUNT(*) FILTER (WHERE status != 'open' AND pnl <= 0) AS losses,
        COALESCE(SUM(pnl) FILTER (WHERE status != 'open'), 0) AS total_pnl,
        COUNT(*) FILTER (WHERE status = 'open') AS open_positions,
        COALESCE(SUM(cost_basis) FILTER (WHERE status = 'open'), 0) AS open_exposure
      FROM polynix_trades
    `));
    const row = Array.from(statsRes as any)[0] as any;
    if (!row) return null;

    const settled = parseInt(row.settled) || 0;
    const wins = parseInt(row.wins) || 0;
    const losses = parseInt(row.losses) || 0;
    const totalPnl = parseFloat(row.total_pnl) || 0;
    const openPositions = parseInt(row.open_positions) || 0;
    const openExposure = parseFloat(row.open_exposure) || 0;
    const startingBalance = 3000; // from polynix.toml [capital] starting_balance_usd
    const balance = startingBalance + totalPnl - openExposure;

    return {
      balance,
      totalPnl,
      openPositions,
      tradesTotal: settled,
      wins,
      losses,
      winRate: settled > 0 ? (wins / settled) * 100 : 0,
      startingBalance,
      source: 'postgres',
    };
  } catch (err) {
    console.error('[polynix/status] Postgres fallback error:', err);
    return null;
  }
}

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

  // Fallback: if Redis has no account data, load from Postgres
  if (!account) {
    account = await loadAccountFromDb();
  }

  // Determine if agent is running: status key set OR fresh Redis data exists
  const isRunning = agentStatus === 'running';

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
