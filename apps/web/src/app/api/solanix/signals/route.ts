import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const items = await redis.lrange('solanix:signals', 0, 49);
    const signals = items.map((item) => JSON.parse(item as string));
    return NextResponse.json({ signals, timestamp: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
