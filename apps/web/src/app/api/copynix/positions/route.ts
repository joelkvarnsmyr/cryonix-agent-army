import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface CopynixPosition {
  tokenSymbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  unrealizedPl: number;
  side: string;
  copiedFrom: string[];
  consensusLevel: 'strong' | 'medium' | 'single';
}

export async function GET() {
  try {
    const raw = await redis.get('copynix:positions');
    if (!raw) {
      return NextResponse.json({
        positions: [],
        source: 'redis',
        count: 0,
      });
    }

    const positions: CopynixPosition[] = JSON.parse(raw as string);
    return NextResponse.json({
      positions,
      source: 'redis',
      count: positions.length,
    });
  } catch (error) {
    console.error('[copynix/positions] Redis error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch positions', details: String(error) },
      { status: 500 },
    );
  }
}
