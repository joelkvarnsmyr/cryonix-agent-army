import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

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

export async function GET() {
  try {
    const raw = await redis.get('polynix:account');
    if (raw) {
      const account: PolynixAccount = JSON.parse(raw as string);
      return NextResponse.json(account);
    }
  } catch (error) {
    console.error('[polynix/portfolio] Redis error:', error);
  }

  return NextResponse.json({
    balance: 0,
    totalPnl: 0,
    openPositions: 0,
    tradesTotal: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
  });
}
