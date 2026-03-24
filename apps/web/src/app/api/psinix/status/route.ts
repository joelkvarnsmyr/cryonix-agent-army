import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const raw = await redis.get('psinix:state');
        if (!raw) return NextResponse.json({ status: 'offline' });
        return NextResponse.json(JSON.parse(raw));
    } catch {
        return NextResponse.json({ status: 'offline' });
    }
}
