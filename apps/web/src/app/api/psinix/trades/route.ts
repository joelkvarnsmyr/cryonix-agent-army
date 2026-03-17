import { NextResponse } from 'next/server';
import { Pool } from 'pg';

export const dynamic = 'force-dynamic';

const pool = new Pool({ connectionString: process.env.POSTGRES_URL ?? '' });

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);

    try {
        const { rows } = await pool.query(
            `SELECT id, timestamp, symbol, side, qty, price, dollar_amount,
                    realized_pnl, psi, coherence, entropy, signal_count, reason, metadata
             FROM psinix_trades ORDER BY timestamp DESC LIMIT $1`,
            [limit],
        );

        const sells = rows.filter((r: any) => r.side === 'SELL' && r.realized_pnl != null);
        const wins = sells.filter((r: any) => r.realized_pnl > 0).length;
        const totalPnl = sells.reduce((s: number, r: any) => s + (parseFloat(r.realized_pnl) ?? 0), 0);

        return NextResponse.json({
            trades: rows.map((r: any) => ({
                id: r.id, timestamp: r.timestamp, symbol: r.symbol, side: r.side,
                qty: r.qty ? parseFloat(r.qty) : null,
                price: r.price ? parseFloat(r.price) : null,
                dollarAmount: r.dollar_amount ? parseFloat(r.dollar_amount) : null,
                realizedPnl: r.realized_pnl ? parseFloat(r.realized_pnl) : null,
                psi: r.psi ? parseFloat(r.psi) : null,
                coherence: r.coherence ? parseFloat(r.coherence) : null,
                reason: r.reason,
            })),
            summary: { totalTrades: sells.length, wins, losses: sells.length - wins, winRate: sells.length > 0 ? wins / sells.length : 0, totalPnl },
        });
    } catch {
        return NextResponse.json({ trades: [], summary: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 } });
    }
}
