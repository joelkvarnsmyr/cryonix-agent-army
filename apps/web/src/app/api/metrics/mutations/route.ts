import { NextResponse } from 'next/server';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET() {
    try {
        const result = await db.execute(sql`
            SELECT
                mf.run_id,
                mf.config_version_pre,
                mf.config_version_post,
                mf.regime,
                mf.pre_trades,
                mf.post_trades,
                mf.pre_wr,
                mf.post_wr,
                mf.pre_sharpe,
                mf.post_sharpe,
                mf.fitness_score,
                mf.created_at,
                er.changes_made,
                er.status as run_status
            FROM mutation_fitness_scores mf
            LEFT JOIN evolution_runs er ON er.run_id = mf.run_id
            ORDER BY mf.created_at DESC
            LIMIT 50
        `);

        const mutations = result.rows.map((r: any) => ({
            ...r,
            improved: (r.fitness_score ?? 0) > 0,
            wrDelta: ((r.post_wr ?? 0) - (r.pre_wr ?? 0)),
        }));

        const improved = mutations.filter((m: any) => m.improved).length;
        const degraded = mutations.filter((m: any) => !m.improved).length;

        return NextResponse.json({
            mutations,
            summary: {
                total: mutations.length,
                improved,
                degraded,
                improvementRate: mutations.length > 0
                    ? Math.round((improved / mutations.length) * 100)
                    : 0,
            },
            timestamp: new Date().toISOString(),
        });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
