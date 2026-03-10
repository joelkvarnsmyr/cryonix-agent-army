import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { readFileSync } from 'fs';
import { join } from 'path';
import { parse } from '@iarna/toml';

export const dynamic = 'force-dynamic';

type MarketPhase = 'pre' | 'regular' | 'after' | 'closed';

function getMarketHours(): { phase: MarketPhase; isOpen: boolean; localTime: string } {
  const now = new Date();
  const jan = new Date(now.getFullYear(), 0, 1).getTimezoneOffset();
  const jul = new Date(now.getFullYear(), 6, 1).getTimezoneOffset();
  const isDST = now.getTimezoneOffset() < Math.max(jan, jul);
  const etOffset = isDST ? -4 : -5;
  const etMs = now.getTime() + (now.getTimezoneOffset() + etOffset * 60) * 60_000;
  const et = new Date(etMs);
  const day = et.getDay();
  const h = et.getHours();
  const m = et.getMinutes();
  const mins = h * 60 + m;
  const localTime = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ET`;

  if (day === 0 || day === 6) return { phase: 'closed', isOpen: false, localTime };
  if (mins < 240) return { phase: 'closed', isOpen: false, localTime };
  if (mins < 570) return { phase: 'pre', isOpen: false, localTime };
  if (mins < 960) return { phase: 'regular', isOpen: true, localTime };
  if (mins < 1200) return { phase: 'after', isOpen: false, localTime };
  return { phase: 'closed', isOpen: false, localTime };
}

function getBrokerFromConfig(): string {
  try {
    const filePath = join(process.cwd(), '..', '..', 'aktienix.toml');
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = parse(raw) as any;
    return parsed.broker?.provider || 'alpaca';
  } catch (e) {
    return 'alpaca';
  }
}

interface AccountState {
  buyingPower: number;
  settledCash: number;
  portfolioValue: number;
  isPatternDayTrader: boolean;
}

interface RiskState {
  canTrade: boolean;
  dailyPnl: number;
  consecutiveLosses: number;
  tradesToday: number;
}

export async function GET() {
  const marketHours = getMarketHours();
  const broker = getBrokerFromConfig();

  let agentStatus: string | null = null;
  let account: AccountState | null = null;
  let risk: RiskState | null = null;

  try {
    const [statusRaw, accountRaw, riskRaw] = await Promise.all([
      redis.get('aktienix:status'),
      redis.get('aktienix:account'),
      redis.get('aktienix:risk'),
    ]);

    agentStatus = (statusRaw as string) ?? null;

    if (accountRaw) {
      try { account = JSON.parse(accountRaw as string); } catch { /* ignore malformed */ }
    }

    if (riskRaw) {
      try { risk = JSON.parse(riskRaw as string); } catch { /* ignore malformed */ }
    }
  } catch (error) {
    console.error('[aktienix/status] Redis error:', error);
  }

  return NextResponse.json({
    status: agentStatus,
    agent: {
      running: agentStatus === 'running',
      broker: broker,
      lastPoll: new Date().toISOString()
    },
    account,
    risk,
    market: marketHours,
    timestamp: new Date().toISOString(),
  });
}
