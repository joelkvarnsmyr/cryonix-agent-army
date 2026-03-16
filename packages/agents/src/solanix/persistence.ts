/**
 * Solanix Persistence — saves paper positions and trades to Postgres
 * so they survive container restarts.
 */

import pg from 'pg';

const { Pool } = pg;

export interface PersistedPosition {
    id: number;
    symbol: string;
    mintAddress: string;
    qty: number;
    avgEntryPrice: number;
    currentPrice: number;
    highWatermark: number;
    trailingStopActive: boolean;
    openedAt: number; // Unix ms
    confidence: number;
    reasoning: string;
}

export interface TradeRecord {
    symbol: string;
    mintAddress: string;
    side: 'BUY' | 'SELL';
    qty: number;
    fillPrice: number;
    dollarAmount: number;
    realizedPnl?: number;
    confidence?: number;
    reasoning?: string;
    exitReason?: string;
    orderId?: string;
    positionId?: number;
    paperTrading: boolean;
}

export class SolanixPersistence {
    private pool: pg.Pool | null = null;

    constructor(private readonly postgresUrl?: string) {}

    async connect(): Promise<boolean> {
        const url = this.postgresUrl || process.env.POSTGRES_URL;
        if (!url) {
            console.log('[solanix-persist] No POSTGRES_URL — persistence disabled');
            return false;
        }
        try {
            this.pool = new Pool({ connectionString: url, max: 2 });
            await this.pool.query('SELECT 1');
            await this.ensureTables();
            console.log('[solanix-persist] Connected to Postgres');
            return true;
        } catch (err: any) {
            console.error('[solanix-persist] Connection failed:', err.message);
            this.pool = null;
            return false;
        }
    }

    private async ensureTables(): Promise<void> {
        if (!this.pool) return;
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS solanix_positions (
                id SERIAL PRIMARY KEY,
                symbol VARCHAR(20) NOT NULL,
                mint_address VARCHAR(64) NOT NULL,
                qty DECIMAL(20,8) NOT NULL,
                avg_entry_price DECIMAL(20,10) NOT NULL,
                current_price DECIMAL(20,10),
                unrealized_pl DECIMAL(20,8),
                high_watermark DECIMAL(20,10),
                trailing_stop_active BOOLEAN DEFAULT FALSE,
                opened_at TIMESTAMP DEFAULT NOW() NOT NULL,
                closed_at TIMESTAMP,
                close_reason VARCHAR(30),
                status VARCHAR(10) DEFAULT 'OPEN' NOT NULL,
                paper_trading BOOLEAN DEFAULT TRUE NOT NULL,
                confidence DECIMAL(5,4),
                reasoning TEXT,
                pnl DECIMAL(20,8),
                pnl_percent DECIMAL(10,4),
                metadata JSONB
            );
            CREATE INDEX IF NOT EXISTS solanix_positions_status_idx ON solanix_positions(status);
            CREATE INDEX IF NOT EXISTS solanix_positions_symbol_idx ON solanix_positions(symbol);

            CREATE TABLE IF NOT EXISTS solanix_trades (
                id SERIAL PRIMARY KEY,
                timestamp TIMESTAMP DEFAULT NOW() NOT NULL,
                symbol VARCHAR(20) NOT NULL,
                mint_address VARCHAR(64),
                side VARCHAR(4) NOT NULL,
                qty DECIMAL(20,8) NOT NULL,
                fill_price DECIMAL(20,10),
                dollar_amount DECIMAL(20,2),
                realized_pnl DECIMAL(20,8),
                confidence DECIMAL(5,4),
                reasoning TEXT,
                exit_reason VARCHAR(30),
                paper_trading BOOLEAN DEFAULT TRUE NOT NULL,
                order_id VARCHAR(64),
                position_id INTEGER REFERENCES solanix_positions(id),
                metadata JSONB
            );
            CREATE INDEX IF NOT EXISTS solanix_trades_timestamp_idx ON solanix_trades(timestamp);
            CREATE INDEX IF NOT EXISTS solanix_trades_symbol_idx ON solanix_trades(symbol);
        `);
    }

    /** Load all OPEN positions from Postgres (for restart recovery) */
    async loadOpenPositions(): Promise<PersistedPosition[]> {
        if (!this.pool) return [];
        try {
            const { rows } = await this.pool.query(
                `SELECT id, symbol, mint_address, qty, avg_entry_price, current_price,
                        high_watermark, trailing_stop_active, opened_at, confidence, reasoning
                 FROM solanix_positions WHERE status = 'OPEN' ORDER BY opened_at`,
            );
            return rows.map((r: any) => ({
                id: r.id,
                symbol: r.symbol,
                mintAddress: r.mint_address,
                qty: parseFloat(r.qty),
                avgEntryPrice: parseFloat(r.avg_entry_price),
                currentPrice: parseFloat(r.current_price ?? r.avg_entry_price),
                highWatermark: parseFloat(r.high_watermark ?? r.avg_entry_price),
                trailingStopActive: r.trailing_stop_active ?? false,
                openedAt: new Date(r.opened_at).getTime(),
                confidence: parseFloat(r.confidence ?? '0'),
                reasoning: r.reasoning ?? '',
            }));
        } catch (err: any) {
            console.error('[solanix-persist] loadOpenPositions error:', err.message);
            return [];
        }
    }

    /** Insert a new OPEN position (on BUY fill) */
    async openPosition(
        symbol: string,
        mintAddress: string,
        qty: number,
        avgEntryPrice: number,
        confidence?: number,
        reasoning?: string,
        metadata?: Record<string, unknown>,
    ): Promise<number | null> {
        if (!this.pool) return null;
        try {
            const { rows } = await this.pool.query(
                `INSERT INTO solanix_positions
                    (symbol, mint_address, qty, avg_entry_price, current_price, high_watermark, paper_trading, confidence, reasoning, metadata)
                 VALUES ($1, $2, $3, $4, $4, $4, TRUE, $5, $6, $7)
                 RETURNING id`,
                [symbol, mintAddress, qty, avgEntryPrice, confidence ?? null, reasoning ?? null, metadata ? JSON.stringify(metadata) : null],
            );
            return rows[0]?.id ?? null;
        } catch (err: any) {
            console.error('[solanix-persist] openPosition error:', err.message);
            return null;
        }
    }

    /** Update position on average-in (qty + avg price changed) */
    async updatePosition(positionId: number, qty: number, avgEntryPrice: number): Promise<void> {
        if (!this.pool) return;
        try {
            await this.pool.query(
                `UPDATE solanix_positions SET qty = $2, avg_entry_price = $3 WHERE id = $1`,
                [positionId, qty, avgEntryPrice],
            );
        } catch (err: any) {
            console.error('[solanix-persist] updatePosition error:', err.message);
        }
    }

    /** Close a position (on exit/rotation) */
    async closePosition(
        positionId: number,
        closeReason: string,
        pnl: number,
        pnlPercent: number,
        exitPrice: number,
    ): Promise<void> {
        if (!this.pool) return;
        try {
            await this.pool.query(
                `UPDATE solanix_positions
                 SET status = 'CLOSED', closed_at = NOW(), close_reason = $2,
                     pnl = $3, pnl_percent = $4, current_price = $5
                 WHERE id = $1`,
                [positionId, closeReason, pnl, pnlPercent, exitPrice],
            );
        } catch (err: any) {
            console.error('[solanix-persist] closePosition error:', err.message);
        }
    }

    /** Log a trade (BUY or SELL) */
    async logTrade(trade: TradeRecord): Promise<void> {
        if (!this.pool) return;
        try {
            await this.pool.query(
                `INSERT INTO solanix_trades
                    (symbol, mint_address, side, qty, fill_price, dollar_amount,
                     realized_pnl, confidence, reasoning, exit_reason, paper_trading,
                     order_id, position_id)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
                [
                    trade.symbol, trade.mintAddress, trade.side, trade.qty,
                    trade.fillPrice, trade.dollarAmount, trade.realizedPnl ?? null,
                    trade.confidence ?? null, trade.reasoning ?? null,
                    trade.exitReason ?? null, trade.paperTrading,
                    trade.orderId ?? null, trade.positionId ?? null,
                ],
            );
        } catch (err: any) {
            console.error('[solanix-persist] logTrade error:', err.message);
        }
    }

    /** Update prices for all open positions (periodic sync) */
    async syncPrices(updates: { id: number; currentPrice: number; highWatermark: number; trailingStopActive: boolean }[]): Promise<void> {
        if (!this.pool || updates.length === 0) return;
        try {
            const client = await this.pool.connect();
            try {
                for (const u of updates) {
                    await client.query(
                        `UPDATE solanix_positions
                         SET current_price = $2, high_watermark = $3, trailing_stop_active = $4
                         WHERE id = $1 AND status = 'OPEN'`,
                        [u.id, u.currentPrice, u.highWatermark, u.trailingStopActive],
                    );
                }
            } finally {
                client.release();
            }
        } catch (err: any) {
            console.error('[solanix-persist] syncPrices error:', err.message);
        }
    }

    async disconnect(): Promise<void> {
        await this.pool?.end();
    }
}
