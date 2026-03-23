import { NextResponse } from 'next/server';
import { db } from '@cryonix/database';
import { sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const days = parseInt(searchParams.get('days') ?? '7');
    const filter = searchParams.get('filter') ?? null;

    try {
        // Per-filter breakdown with won/lost counts
        const breakdownQuery = filter
            ? sql`
                SELECT rejection_reason,
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE would_have_won = true) as won,
                    COUNT(*) FILTER (WHERE would_have_won = false) as lost,
                    ROUND(AVG(phantom_pnl_pct)::numeric, 2) as avg_pnl_pct
                FROM signal_rejections
                WHERE timestamp > NOW() - ${days + ' days'}::interval
                  AND rejection_reason = ${filter}
                GROUP BY rejection_reason
            `
            : sql`
                SELECT rejection_reason,
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE would_have_won = true) as won,
                    COUNT(*) FILTER (WHERE would_have_won = false) as lost,
                    ROUND(AVG(phantom_pnl_pct)::numeric, 2) as avg_pnl_pct
                FROM signal_rejections
                WHERE timestamp > NOW() - ${days + ' days'}::interval
                GROUP BY rejection_reason
                ORDER BY total DESC
            `;

        const breakdown = await db.execute(breakdownQuery);

        // Daily kill rate trend
        const trendQuery = sql`
            SELECT timestamp::date as day,
                COUNT(*) as total,
                COUNT(*) FILTER (WHERE would_have_won = true) as won,
                ROUND((COUNT(*) FILTER (WHERE would_have_won = true))::numeric / NULLIF(COUNT(*), 0) * 100, 1) as kill_rate_pct
            FROM signal_rejections
            WHERE timestamp > NOW() - ${days + ' days'}::interval
            GROUP BY timestamp::date
            ORDER BY day DESC
        `;

        const trend = await db.execute(trendQuery);

        return NextResponse.json({
            breakdown: breakdown,
            trend: trend,
            days,
            filter,
            timestamp: new Date().toISOString(),
        });
    } catch (e) {
        return NextResponse.json({ error: String(e) }, { status: 500 });
    }
}
