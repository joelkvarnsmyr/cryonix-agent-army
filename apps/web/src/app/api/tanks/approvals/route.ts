import { redis } from '@/lib/redis';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        // Get list of pending trades
        const rawList = await redis.lrange('trades:pending', 0, -1);
        const pending = rawList.map(item => JSON.parse(item));

        return NextResponse.json(pending);
    } catch (error) {
        console.error('Approvals Fetch Error:', error);
        return NextResponse.json({ error: 'Failed to fetch pending trades' }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const body = await request.json();
        const { signal, decision } = body; // decision: 'APPROVE' or 'REJECT'

        // Remove from pending queue
        const signalStr = JSON.stringify(signal);
        await redis.lrem('trades:pending', 1, signalStr);

        if (decision === 'APPROVE') {
            await redis.lpush('trades:approved', signalStr);
        } else {
            await redis.lpush('trades:rejected', signalStr);
        }

        return NextResponse.json({ success: true, decision });
    } catch (error) {
        console.error('Approvals Post Error:', error);
        return NextResponse.json({ error: 'Failed to process approval' }, { status: 500 });
    }
}
