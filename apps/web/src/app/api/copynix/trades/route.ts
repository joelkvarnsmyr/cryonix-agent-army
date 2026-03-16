import { NextResponse } from 'next/server';
import { Pool } from 'pg';

export const dynamic = 'force-dynamic';

const pool = new Pool({ connectionString: process.env.POSTGRES_URL ?? '' });

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') ?? '50', 10), 200);

  try {
    const { rows } = await pool.query(
      `SELECT id, timestamp, token_mint, token_symbol, side, qty, entry_price, exit_price,
              dollar_amount, realized_pnl, consensus_level, wallet_count, confidence,
              exit_reason, metadata
       FROM copynix_trades
       ORDER BY timestamp DESC
       LIMIT $1`,
      [limit],
    );

    // Compute summary from SELL trades (closed positions)
    const sells = rows.filter((r: any) => r.side === 'SELL' && r.realized_pnl != null);
    const wins = sells.filter((r: any) => r.realized_pnl > 0).length;
    const totalPnl = sells.reduce((s: number, r: any) => s + (r.realized_pnl ?? 0), 0);

    const trades = rows.map((r: any) => ({
      id: r.id,
      timestamp: r.timestamp,
      symbol: r.token_symbol,
      mint: r.token_mint,
      side: r.side,
      qty: r.qty ? parseFloat(r.qty) : null,
      entryPrice: r.entry_price ? parseFloat(r.entry_price) : null,
      exitPrice: r.exit_price ? parseFloat(r.exit_price) : null,
      dollarAmount: r.dollar_amount ? parseFloat(r.dollar_amount) : null,
      realizedPnl: r.realized_pnl ? parseFloat(r.realized_pnl) : null,
      consensusLevel: r.consensus_level,
      walletCount: r.wallet_count,
      confidence: r.confidence ? parseFloat(r.confidence) : null,
      exitReason: r.exit_reason,
      metadata: r.metadata,
    }));

    // Build equity curve from SELL trades
    const equityCurve: Array<{ timestamp: string; cumulativePnl: number }> = [];
    let cumPnl = 0;
    const sellsChronological = [...sells].reverse();
    for (const s of sellsChronological) {
      cumPnl += parseFloat(s.realized_pnl);
      equityCurve.push({
        timestamp: s.timestamp,
        cumulativePnl: Math.round(cumPnl * 100) / 100,
      });
    }

    return NextResponse.json({
      trades,
      total: rows.length,
      summary: {
        totalTrades: sells.length,
        wins,
        losses: sells.length - wins,
        winRate: sells.length > 0 ? wins / sells.length : 0,
        totalPnl: Math.round(totalPnl * 100) / 100,
      },
      equityCurve,
    });
  } catch (err: any) {
    // Table might not exist yet — return empty
    console.warn('[copynix/trades] DB error:', err.message);
    return NextResponse.json({
      trades: [],
      total: 0,
      summary: { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0 },
      equityCurve: [],
    });
  }
}
