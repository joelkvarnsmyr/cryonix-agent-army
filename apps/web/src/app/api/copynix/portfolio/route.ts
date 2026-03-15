import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface CopynixAccount {
  portfolioValue: number;
  buyingPower: number;
  totalPositions: number;
  dailyPnl: number;
  updatedAt: string | null;
}

export async function GET() {
  try {
    const [accountRaw, riskRaw] = await Promise.all([
      redis.get('copynix:account'),
      redis.get('copynix:risk'),
    ]);

    if (!accountRaw) {
      const empty: CopynixAccount = {
        portfolioValue: 0,
        buyingPower: 0,
        totalPositions: 0,
        dailyPnl: 0,
        updatedAt: null,
      };
      return NextResponse.json(empty);
    }

    const account = JSON.parse(accountRaw as string);
    const risk = riskRaw ? JSON.parse(riskRaw as string) : null;

    const data: CopynixAccount = {
      portfolioValue: account.portfolioValue ?? 0,
      buyingPower: account.buyingPower ?? account.settledCash ?? 0,
      totalPositions: account.totalPositions ?? 0,
      dailyPnl: risk?.dailyPnlDollar ?? 0,
      updatedAt: account.updatedAt ?? null,
    };

    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
