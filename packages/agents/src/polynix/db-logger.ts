/**
 * Polynix DB Logger — persists positions and trades to Postgres.
 * Survives container restarts. Uses `pg` Client directly (same as Aktienix).
 */

import { Client as PgClient } from 'pg';
import type { PolynixPosition, PolynixAccountState } from './types';

const TABLE = 'polynix_trades';

export class PolynixDbLogger {
    private pg: PgClient | null = null;

    async connect(): Promise<void> {
        const url = process.env.POSTGRES_URL;
        if (!url) {
            console.warn('[polynix-db] POSTGRES_URL not set — trades will not be persisted.');
            return;
        }
        try {
            this.pg = new PgClient({ connectionString: url });
            await this.pg.connect();
            await this.ensureTable();
            console.log('[polynix-db] Connected to Postgres.');
        } catch (err: any) {
            console.warn('[polynix-db] Postgres connect failed (non-fatal):', err.message);
            this.pg = null;
        }
    }

    private async ensureTable(): Promise<void> {
        if (!this.pg) return;
        await this.pg.query(`
            CREATE TABLE IF NOT EXISTS ${TABLE} (
                id TEXT PRIMARY KEY,
                type TEXT NOT NULL,
                side TEXT NOT NULL,
                market_title TEXT,
                market_condition_id TEXT,
                asset TEXT,
                entry_price DOUBLE PRECISION,
                size DOUBLE PRECISION,
                cost_basis DOUBLE PRECISION,
                pnl DOUBLE PRECISION DEFAULT 0,
                status TEXT DEFAULT 'open',
                entered_at TIMESTAMPTZ,
                expires_at TIMESTAMPTZ,
                settled_at TIMESTAMPTZ,
                market_data JSONB,
                exit_reason TEXT,
                exit_price DOUBLE PRECISION,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        // Add columns to existing tables
        await this.pg.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS exit_reason TEXT`).catch(() => {});
        await this.pg.query(`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS exit_price DOUBLE PRECISION`).catch(() => {});
    }

    /** Save a newly opened position. */
    async logOpen(pos: PolynixPosition): Promise<void> {
        if (!this.pg) return;
        try {
            await this.pg.query(
                `INSERT INTO ${TABLE} (id, type, side, market_title, market_condition_id, asset, entry_price, size, cost_basis, pnl, status, entered_at, expires_at, market_data)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                 ON CONFLICT (id) DO NOTHING`,
                [
                    pos.id,
                    pos.type,
                    pos.side,
                    pos.market.title,
                    pos.market.conditionId,
                    pos.market.asset,
                    pos.entryPrice,
                    pos.size,
                    pos.costBasis,
                    0,
                    'open',
                    new Date(pos.enteredAt),
                    new Date(pos.expiresAt),
                    JSON.stringify(pos.market),
                ],
            );
        } catch (err: any) {
            console.warn('[polynix-db] logOpen error:', err.message);
        }
    }

    /** Update a position after settlement. */
    async logSettle(pos: PolynixPosition): Promise<void> {
        if (!this.pg) return;
        try {
            await this.pg.query(
                `UPDATE ${TABLE} SET pnl = $1, status = $2, settled_at = NOW(), exit_reason = $4, exit_price = $5 WHERE id = $3`,
                [pos.pnl, pos.status, pos.id, pos.exitReason ?? null, pos.exitPrice ?? null],
            );
        } catch (err: any) {
            console.warn('[polynix-db] logSettle error:', err.message);
        }
    }

    /**
     * Load persisted state on startup.
     * Returns open positions + account stats from settled trades.
     */
    async loadState(): Promise<{
        openPositions: PolynixPosition[];
        accountState: Partial<PolynixAccountState>;
    } | null> {
        if (!this.pg) return null;
        try {
            // Load open positions
            const openRes = await this.pg.query(
                `SELECT id, type, side, entry_price, size, cost_basis, entered_at, expires_at, market_data
                 FROM ${TABLE} WHERE status = 'open' ORDER BY entered_at`
            );

            const openPositions: PolynixPosition[] = openRes.rows.map((r: any) => ({
                id: r.id,
                market: typeof r.market_data === 'string' ? JSON.parse(r.market_data) : (r.market_data ?? {}),
                type: r.type,
                side: r.side,
                entryPrice: parseFloat(r.entry_price),
                size: parseFloat(r.size),
                costBasis: parseFloat(r.cost_basis),
                enteredAt: new Date(r.entered_at).getTime(),
                expiresAt: new Date(r.expires_at).getTime(),
                status: 'open' as const,
                pnl: 0,
            }));

            // Load account stats from SETTLED trades only (exclude open)
            const statsRes = await this.pg.query(
                `SELECT
                    COUNT(*) AS total,
                    COUNT(*) FILTER (WHERE pnl > 0) AS wins,
                    COUNT(*) FILTER (WHERE pnl <= 0) AS losses,
                    COALESCE(SUM(pnl), 0) AS total_pnl
                 FROM ${TABLE}
                 WHERE status != 'open'`
            );
            const stats = statsRes.rows[0];
            const settled = parseInt(stats.total);

            return {
                openPositions,
                accountState: {
                    totalPnl: parseFloat(stats.total_pnl),
                    tradesTotal: settled,
                    wins: parseInt(stats.wins),
                    losses: parseInt(stats.losses),
                    openPositions: openPositions.length,
                },
            };
        } catch (err: any) {
            console.warn('[polynix-db] loadState error:', err.message);
            return null;
        }
    }

    async disconnect(): Promise<void> {
        try {
            await this.pg?.end();
        } catch { /* ignore */ }
    }
}
