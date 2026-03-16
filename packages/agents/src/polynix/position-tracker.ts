import type { PolynixPosition, CryptoMicroMarket } from './types';
import { randomUUID } from 'crypto';

export class PositionTracker {
    private positions: Map<string, PolynixPosition> = new Map();
    private settledTrades: PolynixPosition[] = [];
    private lastAdded: PolynixPosition | null = null;

    addPosition(
        market: CryptoMicroMarket,
        type: 'arb' | 'directional',
        side: 'YES' | 'NO' | 'BOTH',
        entryPrice: number,
        size: number,
        costBasis: number,
    ): PolynixPosition {
        const pos: PolynixPosition = {
            id: randomUUID(),
            market,
            type,
            side,
            entryPrice,
            size,
            costBasis,
            enteredAt: Date.now(),
            expiresAt: market.expiresAt,
            status: 'open',
            pnl: 0,
        };
        this.positions.set(pos.id, pos);
        this.lastAdded = pos;
        return pos;
    }

    /** Restore a position from database (on startup). */
    restorePosition(pos: PolynixPosition): void {
        this.positions.set(pos.id, pos);
    }

    /** Get the last position added (for DB logging). */
    getLastAdded(): PolynixPosition | null {
        return this.lastAdded;
    }

    /**
     * Check all positions for expired markets and settle them.
     * In paper mode, settlement is simulated based on 50/50 random outcome
     * (since we can't query real resolution in paper mode).
     * Returns the list of newly settled positions.
     */
    async settleExpired(): Promise<PolynixPosition[]> {
        const now = Date.now();
        const settled: PolynixPosition[] = [];

        for (const [id, pos] of this.positions) {
            if (pos.status !== 'open') continue;
            if (now < pos.expiresAt) continue;

            // Settle this position
            if (pos.type === 'arb') {
                // Arb always wins: payout = size * $1.00 - costBasis
                pos.pnl = pos.size - pos.costBasis;
                pos.status = 'won';
            } else {
                // Directional: try to resolve, fallback to simulation
                const resolution = await this.queryResolution(pos.market);
                if (resolution !== null) {
                    const won = (resolution === 'YES' && pos.side === 'YES') ||
                                (resolution === 'NO' && pos.side === 'NO');
                    if (won) {
                        pos.pnl = pos.size - pos.costBasis;
                        pos.status = 'won';
                    } else {
                        pos.pnl = -pos.costBasis;
                        pos.status = 'lost';
                    }
                } else {
                    // Paper mode fallback: simulate based on entry probability
                    // Higher entry price = lower payout odds but higher win probability
                    const winChance = pos.entryPrice; // entry price ≈ implied probability
                    const won = Math.random() < winChance;
                    if (won) {
                        pos.pnl = pos.size - pos.costBasis;
                        pos.status = 'won';
                    } else {
                        pos.pnl = -pos.costBasis;
                        pos.status = 'lost';
                    }
                }
            }

            this.settledTrades.push(pos);
            this.positions.delete(id);
            settled.push(pos);
        }

        // Keep settled trades log manageable
        if (this.settledTrades.length > 200) {
            this.settledTrades = this.settledTrades.slice(-200);
        }

        return settled;
    }

    getOpen(): PolynixPosition[] {
        return Array.from(this.positions.values()).filter(p => p.status === 'open');
    }

    getOpenCount(): number {
        return this.getOpen().length;
    }

    getExposure(): number {
        return this.getOpen().reduce((sum, p) => sum + p.costBasis, 0);
    }

    getSettledTrades(): PolynixPosition[] {
        return this.settledTrades;
    }

    /**
     * Query Gamma API for market resolution.
     * Returns 'YES' or 'NO' if resolved, null if still open or error.
     */
    private async queryResolution(market: CryptoMicroMarket): Promise<'YES' | 'NO' | null> {
        try {
            const url = `https://gamma-api.polymarket.com/markets/${market.conditionId}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
            if (!res.ok) return null;
            const data = await res.json() as any;

            // Check if market is resolved
            if (!data.closed) return null;

            // outcomePrices after resolution: winner = "1", loser = "0"
            if (data.outcomePrices) {
                try {
                    const prices = JSON.parse(data.outcomePrices) as string[];
                    if (prices[0] === '1') return 'YES';
                    if (prices[1] === '1') return 'NO';
                } catch {
                    // Fall through
                }
            }
            return null;
        } catch {
            return null;
        }
    }
}
