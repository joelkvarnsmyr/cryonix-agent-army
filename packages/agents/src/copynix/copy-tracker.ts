/**
 * Copynix Copy Tracker Phase 2 — wallet performance scoring + auto-promote/demote.
 * Tracks on-chain wallet performance and Copynix copy outcomes.
 * Auto-rotates wallets between tiers based on composite score.
 */

import type { WalletPerformance } from './types';

interface CopyTrackerConfig {
    promote_threshold: number;
    demote_threshold: number;
    remove_threshold: number;
    min_trades_promote: number;
    min_trades_demote: number;
    min_trades_remove: number;
}

const DEFAULTS: CopyTrackerConfig = {
    promote_threshold: 80,
    demote_threshold: 40,
    remove_threshold: 25,
    min_trades_promote: 10,
    min_trades_demote: 15,
    min_trades_remove: 30,
};

export class CopyTracker {
    private wallets: Map<string, WalletPerformance> = new Map();
    private config: CopyTrackerConfig;

    constructor(config?: Partial<CopyTrackerConfig>) {
        this.config = { ...DEFAULTS, ...config };
    }

    /** Record a trade observed from a tracked wallet. */
    ingestTrade(walletAddress: string, pnlUsd: number, won: boolean): void {
        let perf = this.wallets.get(walletAddress);
        if (!perf) {
            perf = this.createDefault(walletAddress);
            this.wallets.set(walletAddress, perf);
        }
        perf.totalRoundTrips++;
        if (won) perf.wins++;
        else perf.losses++;
        perf.realizedPnlUsd += pnlUsd;
        perf.winRate = perf.totalRoundTrips > 0 ? perf.wins / perf.totalRoundTrips : 0;
        perf.lastActive = Date.now();
        perf.compositeScore = this.computeScore(perf);
        this.autoRotate(perf);
    }

    /** Record outcome of our copy of a wallet's trade. */
    recordCopyOutcome(walletAddress: string, pnlUsd: number, won: boolean): void {
        const perf = this.wallets.get(walletAddress);
        if (!perf) return;
        perf.copynixTrades++;
        if (won) perf.copynixWins++;
        perf.copynixPnlUsd += pnlUsd;
        perf.compositeScore = this.computeScore(perf);
        this.autoRotate(perf);
    }

    /** Get wallet weight for consensus engine (0-1). */
    getWalletWeight(address: string): number {
        const perf = this.wallets.get(address);
        if (!perf || perf.tier === 'removed') return 0;
        return perf.compositeScore / 100;
    }

    /** Get leaderboard sorted by score. */
    getLeaderboard(): WalletPerformance[] {
        return Array.from(this.wallets.values())
            .filter(w => w.tier !== 'removed')
            .sort((a, b) => b.compositeScore - a.compositeScore)
            .slice(0, 20);
    }

    /** Get all tracked wallets. */
    getTracked(): WalletPerformance[] {
        return Array.from(this.wallets.values()).filter(w => w.tier !== 'removed');
    }

    /** Restore wallet state (from Redis/DB on startup). */
    restoreWallet(perf: WalletPerformance): void {
        this.wallets.set(perf.address, perf);
    }

    private computeScore(perf: WalletPerformance): number {
        const wrNorm = Math.min(100, perf.winRate * 100);
        const roiNorm = Math.min(100, Math.max(0, perf.realizedPnlUsd));
        const copynixWr = perf.copynixTrades >= 5
            ? (perf.copynixWins / perf.copynixTrades) * 100
            : 50; // weak prior
        const now = Date.now();
        const recency = perf.lastActive > 0
            ? now - perf.lastActive < 86_400_000 ? 100
            : now - perf.lastActive < 604_800_000 ? 50
            : 0
            : 0;
        const diversity = Math.min(100, (perf.totalRoundTrips / 10) * 100);

        return Math.round(
            0.30 * wrNorm +
            0.25 * roiNorm +
            0.20 * copynixWr +
            0.15 * recency +
            0.10 * diversity,
        );
    }

    private autoRotate(perf: WalletPerformance): void {
        const { promote_threshold, demote_threshold, remove_threshold,
                min_trades_promote, min_trades_demote, min_trades_remove } = this.config;

        if (perf.compositeScore >= promote_threshold && perf.totalRoundTrips >= min_trades_promote) {
            perf.tier = 'whale';
        } else if (perf.compositeScore < remove_threshold && perf.totalRoundTrips >= min_trades_remove) {
            perf.tier = 'removed';
        } else if (perf.compositeScore < demote_threshold && perf.totalRoundTrips >= min_trades_demote) {
            perf.tier = 'probation';
        } else if (perf.tier === 'probation' && perf.compositeScore >= demote_threshold) {
            perf.tier = 'tracked';
        }
    }

    private createDefault(address: string): WalletPerformance {
        return {
            address,
            realizedPnlUsd: 0, totalRoundTrips: 0, wins: 0, losses: 0, winRate: 0,
            copynixTrades: 0, copynixWins: 0, copynixPnlUsd: 0,
            compositeScore: 50, tier: 'tracked',
            lastActive: Date.now(), addedAt: Date.now(), source: 'discovery',
        };
    }
}
