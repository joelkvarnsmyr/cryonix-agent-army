import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export interface AktienixPosition {
  symbol: string;
  qty: number;
  avgEntryPrice: number;
  currentPrice: number;
  marketValue: number;
  unrealizedPl: number;
  unrealizedPlPct: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: string;
}

export async function GET() {
  try {
    const raw = await redis.get('aktienix:positions');
    const positions: AktienixPosition[] = raw ? JSON.parse(raw as string) : [];
    return NextResponse.json({ positions });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
