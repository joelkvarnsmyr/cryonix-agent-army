import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const raw = await redis.get('solanix:positions');
    const positions: unknown[] = raw ? JSON.parse(raw as string) : [];
    return NextResponse.json({ positions, timestamp: new Date().toISOString() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
