import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const raw = await redis.get('vedic:forecast');
    if (raw) {
      const data = JSON.parse(raw as string);
      return NextResponse.json({ forecast: data });
    }
  } catch (error) {
    console.error('[vedic/forecast] Redis error:', error);
  }
  return NextResponse.json({ forecast: [] });
}
