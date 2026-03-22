import { NextResponse } from 'next/server';
import { redis } from '@/lib/redis';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const [krRaw, adRaw, mfsRaw, cvRaw, ecrRaw, ecrHistoryRaw] = await Promise.all([
            redis.get('metrics:kill_rate'),
            redis.get('metrics:alpha_decay'),
            redis.get('metrics:mutation_fitness'),
            redis.get('metrics:capital_velocity'),
            redis.get('metrics:ecr'),
            redis.lrange('metrics:ecr:history', 0, -1),
        ]);

        return NextResponse.json({
            killRate: krRaw ? JSON.parse(krRaw as string) : null,
            alphaDecay: adRaw ? JSON.parse(adRaw as string) : null,
            mutationFitness: mfsRaw ? JSON.parse(mfsRaw as string) : null,
            capitalVelocity: cvRaw ? JSON.parse(cvRaw as string) : null,
            edgeCaptureRatio: ecrRaw ? JSON.parse(ecrRaw as string) : null,
            ecrHistory: ecrHistoryRaw ? (ecrHistoryRaw as string[]).map((r: string) => JSON.parse(r)).reverse() : [],
            timestamp: new Date().toISOString(),
        });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
