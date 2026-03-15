import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface PolynixPositionApi {
  id: string;
  market: {
    conditionId: string;
    title: string;
    asset: string;
    expiresAt: number;
    timeToExpiry: number;
  };
  type: 'arb' | 'directional';
  side: 'YES' | 'NO' | 'BOTH';
  entryPrice: number;
  size: number;
  costBasis: number;
  enteredAt: number;
  expiresAt: number;
  status: string;
  pnl: number;
}

export async function GET() {
  try {
    const raw = await redis.get('polynix:positions');
    if (raw) {
      const positions: PolynixPositionApi[] = JSON.parse(raw as string);
      return NextResponse.json({
        positions,
        source: 'redis',
        count: positions.length,
      });
    }
  } catch (error) {
    console.error('[polynix/positions] Redis error:', error);
  }

  return NextResponse.json({
    positions: [],
    source: 'empty',
    count: 0,
  });
}
