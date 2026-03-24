import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export interface PolynixAccount {
  balance: number;
  totalPnl: number;
  openPositions: number;
  tradesTotal: number;
  wins: number;
  losses: number;
  winRate: number;
}

/** Build account stats from Postgres when Redis is empty. */
async function loadAccountFromDb(): Promise<PolynixAccount> {
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
    if (!row) throw new Error('No rows');

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
    };
  } catch (err) {
    console.error('[polynix/portfolio] Postgres fallback error:', err);
    return { balance: 0, totalPnl: 0, openPositions: 0, tradesTotal: 0, wins: 0, losses: 0, winRate: 0 };
  }
}

export async function GET() {
  // Try Redis first (live data from running agent)
  try {
    const raw = await redis.get('polynix:account');
    if (raw) {
      const account: PolynixAccount = JSON.parse(raw as string);
      return NextResponse.json(account);
    }
  } catch (error) {
    console.error('[polynix/portfolio] Redis error:', error);
  }

  // Fallback: compute from Postgres
  const account = await loadAccountFromDb();
  return NextResponse.json(account);
}
