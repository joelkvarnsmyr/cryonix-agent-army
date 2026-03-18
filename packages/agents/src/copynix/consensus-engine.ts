import type { WalletTrade, CopySignal } from './types';

interface PendingConsensus {
    tokenMint: string;
    tokenSymbol: string;
    trades: WalletTrade[];
    firstSeen: number;
}

/**
 * Consensus Engine — aggregates wallet trades and fires copy signals
 * when N+ tracked wallets buy the same token within a time window.
 */
export class ConsensusEngine {
    private pending = new Map<string, PendingConsensus>();
    private cooldowns = new Map<string, number>(); // tokenMint -> cooldown expiry timestamp

    private minWalletsStrong: number;
    private minWalletsMedium: number;
    private timeWindowMs: number;
    private cooldownMs: number;

    constructor(config: {
        min_wallets_strong: number;
        min_wallets_medium: number;
        time_window_minutes: number;
        cooldown_hours: number;
    }) {
        this.minWalletsStrong = config.min_wallets_strong;
        this.minWalletsMedium = config.min_wallets_medium;
        this.timeWindowMs = config.time_window_minutes * 60_000;
        this.cooldownMs = config.cooldown_hours * 3_600_000;
    }

    /**
     * Ingest a new trade from a tracked wallet.
     * Returns a CopySignal if consensus threshold is met, null otherwise.
     */
    ingest(trade: WalletTrade): CopySignal | null {
        if (trade.action !== 'BUY') return null;

        const now = Date.now();

        // Check cooldown
        const cooldownExpiry = this.cooldowns.get(trade.tokenMint);
        if (cooldownExpiry && now < cooldownExpiry) return null;

        // Clean expired pending entries
        this.cleanExpired(now);

        // Add to pending consensus
        let entry = this.pending.get(trade.tokenMint);
        if (!entry) {
            entry = {
                tokenMint: trade.tokenMint,
                tokenSymbol: trade.tokenSymbol,
                trades: [],
                firstSeen: now,
            };
            this.pending.set(trade.tokenMint, entry);
        }

        // Don't double-count same wallet
        if (entry.trades.some(t => t.walletAddress === trade.walletAddress)) return null;

        entry.trades.push(trade);

        // Check if consensus reached
        const uniqueWallets = new Set(entry.trades.map(t => t.walletAddress));
        const walletCount = uniqueWallets.size;

        // Check if consensus reached — only strong (3+) fires
        // Medium consensus DISABLED — data shows 25% WR vs 100% for single whale.
        // Waiting for 2nd wallet adds latency without improving signal quality.
        let consensusLevel: CopySignal['consensusLevel'] | null = null;
        if (walletCount >= this.minWalletsStrong) {
            consensusLevel = 'strong';
        }

        if (!consensusLevel) return null;

        // Strong consensus reached — fire signal
        const wallets = Array.from(uniqueWallets);
        const avgPrice = entry.trades.reduce((s, t) => s + t.priceUsd, 0) / entry.trades.length;
        const totalVolume = entry.trades.reduce((s, t) => s + t.amountUsd, 0);
        const confidence = 85;

        const signal: CopySignal = {
            tokenMint: trade.tokenMint,
            tokenSymbol: trade.tokenSymbol,
            action: 'BUY',
            consensusLevel,
            walletCount,
            wallets,
            avgPriceUsd: avgPrice,
            totalVolumeUsd: totalVolume,
            confidence,
            reasoning: [
                `${walletCount} tracked wallets bought ${trade.tokenSymbol}`,
                `consensus: ${consensusLevel} (within ${Math.round(this.timeWindowMs / 60_000)}min)`,
                `total volume: $${totalVolume.toFixed(0)}`,
            ],
            timestamp: now,
        };

        // Set cooldown and clean up pending
        this.cooldowns.set(trade.tokenMint, now + this.cooldownMs);
        this.pending.delete(trade.tokenMint);

        return signal;
    }

    /**
     * Force-check for a single-whale signal (top-scored wallet, no consensus needed).
     * Called separately with wallet score context.
     */
    createSingleWhaleSignal(trade: WalletTrade, walletScore: number): CopySignal | null {
        const now = Date.now();
        const cooldownExpiry = this.cooldowns.get(trade.tokenMint);
        if (cooldownExpiry && now < cooldownExpiry) return null;

        if (walletScore < 80) return null; // Only top-tier wallets

        this.cooldowns.set(trade.tokenMint, now + this.cooldownMs);

        return {
            tokenMint: trade.tokenMint,
            tokenSymbol: trade.tokenSymbol,
            action: 'BUY',
            consensusLevel: 'single',
            walletCount: 1,
            wallets: [trade.walletAddress],
            avgPriceUsd: trade.priceUsd,
            totalVolumeUsd: trade.amountUsd,
            confidence: 50,
            reasoning: [
                `Top wallet (score ${walletScore}) bought ${trade.tokenSymbol}`,
                `single whale signal — reduced position size`,
                `volume: $${trade.amountUsd.toFixed(0)}`,
            ],
            timestamp: now,
        };
    }

    /** Get all pending consensus entries (for monitoring/logging). */
    getPending(): Map<string, PendingConsensus> {
        this.cleanExpired(Date.now());
        return new Map(this.pending);
    }

    /** Get active cooldowns. */
    getActiveCooldowns(): Map<string, number> {
        const now = Date.now();
        const active = new Map<string, number>();
        for (const [mint, expiry] of this.cooldowns) {
            if (expiry > now) active.set(mint, expiry);
        }
        return active;
    }

    private cleanExpired(now: number): void {
        for (const [mint, entry] of this.pending) {
            if (now - entry.firstSeen > this.timeWindowMs) {
                this.pending.delete(mint);
            }
        }
        // Clean expired cooldowns
        for (const [mint, expiry] of this.cooldowns) {
            if (now >= expiry) this.cooldowns.delete(mint);
        }
    }
}
