import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface AktienixAccount {
  portfolioValue: number;
  buyingPower: number;
  settledCash: number;
  isPatternDayTrader: boolean;
  dailyPnl: number;
  dailyPnlPct: number;
  updatedAt: string | null;
}

export async function GET() {
  try {
    const raw = await redis.get('aktienix:account');
    if (!raw) {
      const empty: AktienixAccount = {
        portfolioValue: 0, buyingPower: 0, settledCash: 0,
        isPatternDayTrader: false, dailyPnl: 0, dailyPnlPct: 0, updatedAt: null,
      };
      return NextResponse.json(empty);
    }
    const data = JSON.parse(raw as string) as AktienixAccount;
    return NextResponse.json(data);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
