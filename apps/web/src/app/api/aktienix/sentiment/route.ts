import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const [fgRaw, pcRaw, econRaw] = await Promise.all([
            redis.get('aktienix:feargreed'),
            redis.get('aktienix:putcall'),
            redis.get('aktienix:econ_calendar'),
        ]);

        return NextResponse.json({
            fearGreed: fgRaw ? JSON.parse(fgRaw as string) : null,
            putCall: pcRaw ? JSON.parse(pcRaw as string) : null,
            econCalendar: econRaw ? JSON.parse(econRaw as string) : null,
            timestamp: new Date().toISOString(),
        });
    } catch {
        return NextResponse.json({ fearGreed: null, putCall: null, econCalendar: null });
    }
}
