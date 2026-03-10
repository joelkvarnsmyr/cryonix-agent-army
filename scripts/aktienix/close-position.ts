// scripts/aktienix/close-position.ts
// Usage: npx tsx scripts/aktienix/close-position.ts <SYMBOL>
// Exits 0 on success, 1 on failure.
import * as dotenv from 'dotenv';
import * as path from 'path';
import { Client } from 'pg';
import Alpaca from '@alpacahq/alpaca-trade-api';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../apps/aktienix/.env') });

const symbol = process.argv[2]?.toUpperCase();
if (!symbol) {
    console.error('Usage: close-position.ts <SYMBOL>');
    process.exit(1);
}

async function logTrade(opts: {
    symbol: string;
    qty: number;
    fillPrice: number;
    avgEntry: number;
    realizedPnl: number;
    orderId: string;
    isPaper: boolean;
}) {
    const pgUrl = process.env.POSTGRES_URL;
    if (!pgUrl) {
        console.warn('[close-position] POSTGRES_URL not set — skipping DB log');
        return;
    }
    const db = new Client({ connectionString: pgUrl });
    try {
        await db.connect();
        await db.query(
            `INSERT INTO aktienix_trades
             (symbol, qty, fill_price, realized_pnl, side, reasoning, timestamp, exit_reason, broker, paper_trading, order_id)
             VALUES ($1, $2, $3, $4, 'SELL', 'Brain intervention', NOW(), 'brain_intervention', 'alpaca', $5, $6)`,
            [opts.symbol, opts.qty, opts.fillPrice, opts.realizedPnl, opts.isPaper, opts.orderId]
        );
        console.log('[close-position] Trade logged to Postgres.');
    } catch (err: any) {
        console.error('[close-position] DB log failed:', err.message);
        // Do not exit 1 — the trade was placed, logging failure is not fatal
    } finally {
        await db.end();
    }
}

async function main() {
    const isPaper = !!process.env.ALPACA_PAPER_API_KEY;
    const apiKey    = isPaper ? process.env.ALPACA_PAPER_API_KEY    : process.env.ALPACA_API_KEY;
    const apiSecret = isPaper ? process.env.ALPACA_PAPER_API_SECRET : process.env.ALPACA_API_SECRET;

    if (!apiKey || !apiSecret) {
        console.error('[close-position] Missing Alpaca credentials in environment.');
        process.exit(1);
    }

    const alpaca = new (Alpaca as any)({
        keyId: apiKey,
        secretKey: apiSecret,
        paper: isPaper, // Paper if ALPACA_PAPER_API_KEY is set, live otherwise
    });

    // 1. Fetch position
    let position: any;
    try {
        position = await alpaca.getPosition(symbol);
    } catch (err: any) {
        console.error(`[close-position] No position found for ${symbol}: ${err.message}`);
        process.exit(1);
    }

    const qty = Math.abs(parseFloat(position.qty));
    const avgEntry = parseFloat(position.avg_entry_price);
    console.log(`[close-position] Found position: ${qty} shares @ $${avgEntry.toFixed(2)}`);

    // 2. Submit SELL MARKET order
    let order: any;
    try {
        order = await alpaca.createOrder({
            symbol,
            qty,
            side: 'sell',
            type: 'market',
            time_in_force: 'day',
        });
    } catch (err: any) {
        console.error(`[close-position] Order submission failed: ${err.message}`);
        process.exit(1);
    }
    console.log(`[close-position] Order submitted: ${order.id} (status: ${order.status})`);

    // 3. Poll until filled (max 30s)
    let filled = order.status === 'filled';
    const deadline = Date.now() + 30_000;
    while (!filled && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 1000));
        try {
            const updated = await alpaca.getOrder(order.id);
            filled = updated.status === 'filled';
            if (filled) {
                order = updated;
                console.log(`[close-position] Order filled at $${parseFloat(updated.filled_avg_price).toFixed(2)}`);
            }
        } catch { /* ignore polling errors */ }
    }

    if (!filled) {
        console.warn('[close-position] Order not confirmed filled within 30s — proceeding with submission price');
    }

    const fillPrice = filled
        ? parseFloat(order.filled_avg_price ?? avgEntry)
        : avgEntry;

    const realizedPnl = (fillPrice - avgEntry) * qty;
    console.log(`[close-position] Realized P&L: $${realizedPnl.toFixed(2)}`);

    // 4. Log to Postgres
    await logTrade({ symbol, qty, fillPrice, avgEntry, realizedPnl, orderId: order.id, isPaper });

    console.log('[close-position] Done.');
    process.exit(0);
}

main().catch(err => {
    console.error('[close-position] Fatal:', err.message);
    process.exit(1);
});
