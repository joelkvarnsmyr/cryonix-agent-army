import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const [spreadsRaw, oppsRaw] = await Promise.all([
            redis.get('polymarket:spreads'),
            redis.get('polymarket:spreads:opportunities'),
        ]);

        const spreads = spreadsRaw ? JSON.parse(spreadsRaw as string) : null;
        const opportunities = oppsRaw ? JSON.parse(oppsRaw as string) : [];

        return NextResponse.json({
            scanResult: spreads,
            opportunities,
            hasData: spreads !== null,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('[polymarket/spreads] Error:', error);
        return NextResponse.json({ error: 'Failed to fetch spread data' }, { status: 500 });
    }
}
