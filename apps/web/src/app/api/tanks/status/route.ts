import { redis } from '@/lib/redis';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
        return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    }

    try {
        const key = `agent:${id}:status`;
        // ioredis returns string (if stored as string), we need to parse if it's JSON
        const rawData = await redis.get(key);
        const data = rawData ? JSON.parse(rawData) : null;

        return NextResponse.json(data || { status: 'offline' });
    } catch (error) {
        console.error('Redis Error:', error);
        return NextResponse.json({ error: 'Failed to fetch status' }, { status: 500 });
    }
}
