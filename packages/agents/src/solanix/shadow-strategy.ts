/**
 * Shadow Strategy — parallel paper wallet for A/B testing exit parameters.
 *
 * Receives the SAME signals as the primary wallet but applies different
 * exit rules. Tracks positions + P&L independently. Logs to separate
 * Postgres tables (solanix_shadow_positions / solanix_shadow_trades).
 *
 * No extra container, no extra broker client — just math + logging.
 */

import pg from 'pg';

const { Pool } = pg;

export interface ShadowConfig {
    name: string;
    capitalUsd: number;
    maxPositions: number;
    positionSizeUsd: number;
    takeProfitPct: number;
    stopLossPct: number;
    trailingStopPct: number;
    trailingActivationPct: number;
    stagnationDays: number;
}

interface ShadowPosition {
    id?: number; // DB id
    symbol: string;
    mintAddress: string;
    qty: number;
    entryPrice: number;
    currentPrice: number;
    highWatermark: number;
    trailingActive: boolean;
    entryTime: number;
    confidence: number;
}

interface ShadowTradeLog {
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;
    price: number;
    dollarAmount: number;
    pnl?: number;
    pnlPct?: number;
    exitReason?: string;
}

export class ShadowStrategy {
    private config: ShadowConfig;
    private positions: ShadowPosition[] = [];
    private balance: number;
    private pool: pg.Pool | null = null;
    private totalRealizedPnl = 0;
    private tradeCount = 0;
    private wins = 0;
    private losses = 0;

    constructor(config: ShadowConfig) {
        this.config = config;
        this.balance = config.capitalUsd;
    }

    async connect(postgresUrl?: string): Promise<boolean> {
        const url = postgresUrl || process.env.POSTGRES_URL;
        if (!url) return false;
        try {
            this.pool = new Pool({ connectionString: url, max: 1 });
            await this.pool.query('SELECT 1');
            await this.ensureTables();
            await this.loadPositions();
            return true;
        } catch (err: any) {
            console.error(`[shadow:${this.config.name}] DB connect failed:`, err.message);
            this.pool = null;
            return false;
        }
    }

    private async ensureTables(): Promise<void> {
        if (!this.pool) return;
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS solanix_shadow_positions (
                id SERIAL PRIMARY KEY,
                strategy VARCHAR(30) NOT NULL,
                symbol VARCHAR(20) NOT NULL,
                mint_address VARCHAR(64),
                qty DECIMAL(20,8) NOT NULL,
                entry_price DECIMAL(20,10) NOT NULL,
                current_price DECIMAL(20,10),
                high_watermark DECIMAL(20,10),
                trailing_active BOOLEAN DEFAULT FALSE,
                confidence DECIMAL(5,4),
                opened_at TIMESTAMP DEFAULT NOW(),
                closed_at TIMESTAMP,
                close_reason VARCHAR(30),
                pnl DECIMAL(20,8),
                pnl_pct DECIMAL(10,4),
                status VARCHAR(10) DEFAULT 'OPEN'
            );
            CREATE INDEX IF NOT EXISTS shadow_pos_strategy_status ON solanix_shadow_positions(strategy, status);

            CREATE TABLE IF NOT EXISTS solanix_shadow_trades (
                id SERIAL PRIMARY KEY,
                strategy VARCHAR(30) NOT NULL,
                timestamp TIMESTAMP DEFAULT NOW(),
                symbol VARCHAR(20) NOT NULL,
                side VARCHAR(4) NOT NULL,
                qty DECIMAL(20,8),
                price DECIMAL(20,10),
                dollar_amount DECIMAL(20,2),
                pnl DECIMAL(20,8),
                pnl_pct DECIMAL(10,4),
                exit_reason VARCHAR(30)
            );
            CREATE INDEX IF NOT EXISTS shadow_trades_strategy ON solanix_shadow_trades(strategy);
        `);
    }

    private async loadPositions(): Promise<void> {
        if (!this.pool) return;
        try {
            const { rows } = await this.pool.query(
                `SELECT * FROM solanix_shadow_positions WHERE strategy = $1 AND status = 'OPEN'`,
                [this.config.name],
            );
            this.positions = rows.map((r: any) => ({
                id: r.id,
                symbol: r.symbol,
                mintAddress: r.mint_address ?? '',
                qty: parseFloat(r.qty),
                entryPrice: parseFloat(r.entry_price),
                currentPrice: parseFloat(r.current_price ?? r.entry_price),
                highWatermark: parseFloat(r.high_watermark ?? r.entry_price),
                trailingActive: r.trailing_active ?? false,
                entryTime: new Date(r.opened_at).getTime(),
                confidence: parseFloat(r.confidence ?? '0'),
            }));
            // Recalculate balance from positions
            const invested = this.positions.reduce((s, p) => s + p.qty * p.entryPrice, 0);
            this.balance = this.config.capitalUsd - invested;
            if (this.positions.length > 0) {
                console.log(`[shadow:${this.config.name}] Restored ${this.positions.length} positions`);
            }
        } catch (err: any) {
            console.error(`[shadow:${this.config.name}] loadPositions error:`, err.message);
        }
    }

    /**
     * Mirror a BUY from the primary wallet.
     * Called when the primary wallet successfully fills a BUY order.
     */
    async onPrimaryBuy(symbol: string, mintAddress: string, fillPrice: number, confidence: number): Promise<void> {
        // Skip if already holding or at max positions
        if (this.positions.some(p => p.symbol === symbol)) return;
        if (this.positions.length >= this.config.maxPositions) return;

        const dollarAmount = Math.min(this.config.positionSizeUsd, this.balance);
        if (dollarAmount < 1) return;

        const qty = dollarAmount / fillPrice;
        this.balance -= dollarAmount;

        const pos: ShadowPosition = {
            symbol, mintAddress, qty, entryPrice: fillPrice,
            currentPrice: fillPrice, highWatermark: fillPrice,
            trailingActive: false, entryTime: Date.now(), confidence,
        };

        // Save to DB
        if (this.pool) {
            try {
                const { rows } = await this.pool.query(
                    `INSERT INTO solanix_shadow_positions
                        (strategy, symbol, mint_address, qty, entry_price, current_price, high_watermark, confidence)
                     VALUES ($1,$2,$3,$4,$5,$5,$5,$6) RETURNING id`,
                    [this.config.name, symbol, mintAddress, qty, fillPrice, confidence],
                );
                pos.id = rows[0]?.id;
            } catch (err: any) {
                console.error(`[shadow:${this.config.name}] save BUY error:`, err.message);
            }
        }

        this.positions.push(pos);
        await this.logTrade({ symbol, side: 'BUY', qty, price: fillPrice, dollarAmount });
    }

    /**
     * Update prices and check exits. Called every loop iteration.
     * Returns list of exits for logging.
     */
    async tick(priceMap: Map<string, number>): Promise<string[]> {
        const exits: string[] = [];
        const remaining: ShadowPosition[] = [];
        const cfg = this.config;

        for (const pos of this.positions) {
            const price = priceMap.get(pos.symbol) ?? pos.currentPrice;
            pos.currentPrice = price;

            // Update HWM
            if (price > pos.highWatermark) {
                pos.highWatermark = price;
            }

            // Activate trailing
            const pnlPct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
            if (pnlPct >= cfg.trailingActivationPct) {
                pos.trailingActive = true;
            }

            // Check exits
            let exitReason: string | null = null;

            // Take profit
            if (pnlPct >= cfg.takeProfitPct) {
                exitReason = 'take_profit';
            }
            // Stop loss
            else if (pnlPct <= -cfg.stopLossPct) {
                exitReason = 'stop_loss';
            }
            // Trailing stop
            else if (pos.trailingActive) {
                const pullback = ((pos.highWatermark - price) / pos.highWatermark) * 100;
                if (pullback >= cfg.trailingStopPct || pnlPct < 0) {
                    exitReason = 'trailing_stop';
                }
            }
            // Stagnation
            else if (cfg.stagnationDays > 0) {
                const daysHeld = (Date.now() - pos.entryTime) / (1000 * 60 * 60 * 24);
                if (daysHeld >= cfg.stagnationDays && Math.abs(pnlPct) < 0.5) {
                    exitReason = 'stagnation';
                }
            }

            if (exitReason) {
                const pnlDollar = pos.qty * (price - pos.entryPrice);
                this.balance += pos.qty * price;
                this.totalRealizedPnl += pnlDollar;
                this.tradeCount++;
                if (pnlDollar > 0) this.wins++; else this.losses++;

                exits.push(`[shadow:${cfg.name}] EXIT ${pos.symbol}: ${exitReason} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% / $${pnlDollar.toFixed(2)})`);

                // Persist
                if (this.pool && pos.id) {
                    try {
                        await this.pool.query(
                            `UPDATE solanix_shadow_positions
                             SET status='CLOSED', closed_at=NOW(), close_reason=$2, pnl=$3, pnl_pct=$4, current_price=$5
                             WHERE id=$1`,
                            [pos.id, exitReason, pnlDollar, pnlPct, price],
                        );
                    } catch { /* swallow */ }
                }
                await this.logTrade({
                    symbol: pos.symbol, side: 'SELL', qty: pos.qty, price,
                    dollarAmount: pos.qty * price, pnl: pnlDollar, pnlPct, exitReason,
                });
            } else {
                // Update price in DB
                if (this.pool && pos.id) {
                    try {
                        await this.pool.query(
                            `UPDATE solanix_shadow_positions SET current_price=$2, high_watermark=$3, trailing_active=$4 WHERE id=$1`,
                            [pos.id, price, pos.highWatermark, pos.trailingActive],
                        );
                    } catch { /* swallow */ }
                }
                remaining.push(pos);
            }
        }

        this.positions = remaining;
        return exits;
    }

    private async logTrade(t: ShadowTradeLog): Promise<void> {
        if (!this.pool) return;
        try {
            await this.pool.query(
                `INSERT INTO solanix_shadow_trades (strategy,symbol,side,qty,price,dollar_amount,pnl,pnl_pct,exit_reason)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
                [this.config.name, t.symbol, t.side, t.qty, t.price, t.dollarAmount, t.pnl ?? null, t.pnlPct ?? null, t.exitReason ?? null],
            );
        } catch { /* swallow */ }
    }

    /** Portfolio value for dashboard/logging */
    getStats(): { name: string; balance: number; portfolioValue: number; positions: number; realizedPnl: number; trades: number; winRate: number } {
        const posValue = this.positions.reduce((s, p) => s + p.qty * p.currentPrice, 0);
        return {
            name: this.config.name,
            balance: this.balance,
            portfolioValue: this.balance + posValue,
            positions: this.positions.length,
            realizedPnl: this.totalRealizedPnl,
            trades: this.tradeCount,
            winRate: this.tradeCount > 0 ? (this.wins / this.tradeCount) * 100 : 0,
        };
    }

    async disconnect(): Promise<void> {
        await this.pool?.end();
    }
}
