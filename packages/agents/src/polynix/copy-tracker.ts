/**
 * Polynix Copy Tracker — follow profitable Polymarket wallets.
 * Phase 1: Probe API + accumulate wallet stats. Signals are STUB (disabled by default).
 */

import type { CopyTraderConfig } from './types';

interface WalletStats {
    address: string;
    trades: number;
    wins: number;
    losses: number;
    totalPnl: number;
    winRate: number;
    lastSeen: number;
}

interface CopySignal {
    wallet: string;
    market: string;
    side: 'YES' | 'NO';
    size: number;
    price: number;
    confidence: number;
}

export class CopyTracker {
    private config: CopyTraderConfig;
    private walletStats: Map<string, WalletStats> = new Map();
    private probeOk = false;
    private lastPoll = 0;

    constructor(polynixConfig: { copy_trader?: CopyTraderConfig }) {
        this.config = polynixConfig.copy_trader ?? {
            enabled: false,
            poll_interval_ms: 300_000,
            min_wallet_pnl: 100,
            min_wallet_trades: 10,
            max_copy_size_usd: 15,
        };
    }

    /** Probe the Polymarket trades API to validate data format. */
    async probe(): Promise<boolean> {
        try {
            const url = 'https://clob.polymarket.com/trades?limit=50';
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) {
                console.log(`[copy-tracker] probe FAILED: HTTP ${res.status}`);
                this.probeOk = false;
                return false;
            }

            const data = await res.json() as any;

            // Validate expected fields exist
            if (!Array.isArray(data)) {
                // Some endpoints wrap in { data: [...] }
                const arr = data?.data ?? data?.trades ?? data;
                if (!Array.isArray(arr)) {
                    console.log('[copy-tracker] probe FAILED: response is not an array');
                    this.probeOk = false;
                    return false;
                }
            }

            const trades = Array.isArray(data) ? data : (data?.data ?? data?.trades ?? []);
            if (trades.length === 0) {
                console.log('[copy-tracker] probe OK: empty response (no recent trades)');
                this.probeOk = true;
                return true;
            }

            // Validate first trade has expected fields
            const sample = trades[0];
            const requiredFields = ['id', 'side', 'size', 'price'];
            const hasFields = requiredFields.every(f => f in sample);

            if (hasFields) {
                console.log(`[copy-tracker] probe OK: ${trades.length} trades, fields: ${Object.keys(sample).join(', ')}`);
                this.probeOk = true;
                return true;
            } else {
                console.log(`[copy-tracker] probe PARTIAL: missing fields. Got: ${Object.keys(sample).join(', ')}`);
                this.probeOk = true; // Still usable
                return true;
            }
        } catch (err: any) {
            console.log(`[copy-tracker] probe FAILED: ${err.message}`);
            this.probeOk = false;
            return false;
        }
    }

    /** Poll for new trades and accumulate wallet stats (STUB). */
    async poll(): Promise<void> {
        if (!this.config.enabled || !this.probeOk) return;

        const now = Date.now();
        if (now - this.lastPoll < this.config.poll_interval_ms) return;
        this.lastPoll = now;

        // STUB: In Phase 2, fetch trades, extract proxyWallet, accumulate stats
        // For now, just log that we would poll
        console.log('[copy-tracker] poll: STUB — wallet accumulation not yet implemented');
    }

    /** Get consensus signals from top wallets (STUB — returns empty). */
    getSignals(): CopySignal[] {
        // STUB: Phase 2 will analyze top wallet positions for consensus signals
        return [];
    }

    /** Get leaderboard of top wallets sorted by PnL. */
    getLeaderboard(): WalletStats[] {
        return Array.from(this.walletStats.values())
            .filter(w => w.trades >= this.config.min_wallet_trades && w.totalPnl >= this.config.min_wallet_pnl)
            .sort((a, b) => b.totalPnl - a.totalPnl)
            .slice(0, 20);
    }

    isEnabled(): boolean {
        return this.config.enabled;
    }

    isProbeOk(): boolean {
        return this.probeOk;
    }
}
