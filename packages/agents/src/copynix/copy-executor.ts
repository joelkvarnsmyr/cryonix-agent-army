import type { CopySignal, CopyPosition, CopyAccountState } from './types';

/**
 * Copy Executor — manages paper trading positions for Copynix.
 *
 * Phase 1: Virtual positions with real market prices.
 * Phase 2: Jupiter swap execution.
 */
export class CopyExecutor {
    private positions = new Map<string, CopyPosition>();
    private usdcBalance: number;
    private initialBalance: number;
    private maxPositionSizeUsd: number;
    private maxCapitalPerTradePct: number;
    private minOrderValue: number;

    constructor(config: {
        initial_usdc_balance: number;
        max_position_size_usd: number;
        max_capital_per_trade_pct: number;
        min_order_value: number;
    }) {
        this.usdcBalance = config.initial_usdc_balance;
        this.initialBalance = config.initial_usdc_balance;
        this.maxPositionSizeUsd = config.max_position_size_usd;
        this.maxCapitalPerTradePct = config.max_capital_per_trade_pct;
        this.minOrderValue = config.min_order_value;
    }

    /**
     * Execute a copy trade based on a consensus signal.
     */
    executeBuy(signal: CopySignal): { success: boolean; message: string } {
        if (this.positions.has(signal.tokenMint)) {
            return { success: false, message: `Already have position in ${signal.tokenSymbol}` };
        }

        // Size based on consensus level
        const sizePct = signal.consensusLevel === 'strong' ? 1.0
            : signal.consensusLevel === 'medium' ? 0.6
            : 0.4;

        let orderSize = this.maxPositionSizeUsd * sizePct;

        // Cap at max capital per trade
        const portfolioValue = this.getPortfolioValue();
        const maxFromPortfolio = portfolioValue * this.maxCapitalPerTradePct;
        orderSize = Math.min(orderSize, maxFromPortfolio, this.usdcBalance);

        if (orderSize < this.minOrderValue) {
            return { success: false, message: `Order size $${orderSize.toFixed(2)} below minimum $${this.minOrderValue}` };
        }

        if (signal.avgPriceUsd <= 0) {
            return { success: false, message: 'Invalid price' };
        }

        const qty = orderSize / signal.avgPriceUsd;
        this.usdcBalance -= orderSize;

        const position: CopyPosition = {
            tokenMint: signal.tokenMint,
            tokenSymbol: signal.tokenSymbol,
            qty,
            avgEntryPrice: signal.avgPriceUsd,
            currentPrice: signal.avgPriceUsd,
            unrealizedPl: 0,
            entryTime: Date.now(),
            highWatermark: signal.avgPriceUsd,
            trailingStopActive: false,
            partialTpTaken: false,
            copiedFrom: signal.wallets,
            consensusLevel: signal.consensusLevel,
        };

        this.positions.set(signal.tokenMint, position);
        return { success: true, message: `Bought $${orderSize.toFixed(2)} of ${signal.tokenSymbol} @ $${signal.avgPriceUsd.toFixed(6)} (${signal.consensusLevel} consensus)` };
    }

    /**
     * Reduce position quantity (for partial take profits).
     */
    reducePosition(tokenMint: string, reduceQty: number): void {
        const pos = this.positions.get(tokenMint);
        if (!pos) return;
        pos.qty = Math.max(0, pos.qty - reduceQty);
        this.usdcBalance += reduceQty * pos.currentPrice;
        if (pos.qty <= 0) {
            this.positions.delete(tokenMint);
        }
    }

    /**
     * Close a position (sell all).
     */
    executeSell(tokenMint: string, currentPrice: number, reason: string): { success: boolean; message: string; pnl: number } {
        const pos = this.positions.get(tokenMint);
        if (!pos) {
            return { success: false, message: `No position for mint ${tokenMint}`, pnl: 0 };
        }

        const marketValue = pos.qty * currentPrice;
        const costBasis = pos.qty * pos.avgEntryPrice;
        const pnl = marketValue - costBasis;
        const pnlPct = (pnl / costBasis) * 100;

        this.usdcBalance += marketValue;
        this.positions.delete(tokenMint);

        return {
            success: true,
            message: `Sold ${pos.tokenSymbol}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%) — ${reason}`,
            pnl,
        };
    }

    /**
     * Update position prices from market data.
     */
    updatePrice(tokenMint: string, currentPrice: number): void {
        const pos = this.positions.get(tokenMint);
        if (!pos) return;

        pos.currentPrice = currentPrice;
        pos.unrealizedPl = (currentPrice - pos.avgEntryPrice) * pos.qty;

        if (currentPrice > pos.highWatermark) {
            pos.highWatermark = currentPrice;
        }
    }

    getPositions(): CopyPosition[] {
        return Array.from(this.positions.values());
    }

    getPosition(tokenMint: string): CopyPosition | undefined {
        return this.positions.get(tokenMint);
    }

    getAccountState(): CopyAccountState {
        return {
            usdcBalance: this.usdcBalance,
            portfolioValue: this.getPortfolioValue(),
            totalPositions: this.positions.size,
        };
    }

    private getPortfolioValue(): number {
        let posValue = 0;
        for (const pos of this.positions.values()) {
            posValue += pos.qty * pos.currentPrice;
        }
        return this.usdcBalance + posValue;
    }
}
