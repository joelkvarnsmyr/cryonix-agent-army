import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from '@iarna/toml';

export const dynamic = 'force-dynamic';

interface AccountState {
  buyingPower: number;
  settledCash: number;
  portfolioValue: number;
  isPatternDayTrader: boolean;
}

interface RiskState {
  canTrade: boolean;
  dailyPnlDollar: number;
  weeklyPnlDollar: number;
  consecutiveLosses: number;
  tradesToday: number;
  dayTradesThisWeek: number;
}

function loadCopynixConfig(): { paperTrading: boolean; trackedWallets: number } {
  const paths = [
    '/app/copynix.toml',
    join(process.cwd(), 'copynix.toml'),
    join(process.cwd(), '../../copynix.toml'),
  ];
  for (const filePath of paths) {
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = parse(raw) as any;
    return {
      paperTrading: parsed.broker?.paper_trading ?? true,
      trackedWallets: Array.isArray(parsed.wallets?.tracked) ? parsed.wallets.tracked.length : 0,
    };
  } catch {
    continue;
  }
  }
  return { paperTrading: true, trackedWallets: 0 };
}

export async function GET() {
  const config = loadCopynixConfig();

  let agentStatus: string | null = null;
  let account: AccountState | null = null;
  let risk: RiskState | null = null;

  try {
    const [statusRaw, accountRaw, riskRaw] = await Promise.all([
      redis.get('copynix:status'),
      redis.get('copynix:account'),
      redis.get('copynix:risk'),
    ]);

    agentStatus = (statusRaw as string) ?? null;

    if (accountRaw) {
      try { account = JSON.parse(accountRaw as string); } catch { /* ignore malformed */ }
    }

    if (riskRaw) {
      try { risk = JSON.parse(riskRaw as string); } catch { /* ignore malformed */ }
    }
  } catch (error) {
    console.error('[copynix/status] Redis error:', error);
  }

  return NextResponse.json({
    status: agentStatus,
    paperTrading: config.paperTrading,
    trackedWallets: config.trackedWallets,
    portfolioValue: account?.portfolioValue ?? 0,
    totalPositions: 0, // derived from positions key, kept lightweight here
    tradesToday: risk?.tradesToday ?? 0,
    account: account ? {
      ...account,
      usdcBalance: account.settledCash ?? account.buyingPower ?? 0,
    } : null,
    risk,
    timestamp: new Date().toISOString(),
  });
}
