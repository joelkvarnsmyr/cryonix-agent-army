import { NextResponse } from 'next/server';
import Redis from 'ioredis';

export const dynamic = 'force-dynamic';

let redis: Redis | null = null;
function getRedis() {
    if (!redis) redis = new Redis(process.env.KV_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1, lazyConnect: true });
    return redis;
}

export async function GET() {
    try {
        const r = getRedis();
        const raw = await r.get('psinix:state');
        if (!raw) return NextResponse.json({ status: 'offline' });
        return NextResponse.json(JSON.parse(raw));
    } catch {
        return NextResponse.json({ status: 'offline' });
    }
}
