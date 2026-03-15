import type { TrackedWallet } from './types';
import { WalletProfiler } from './wallet-profiler';
import {
    fetchTrendingGeckoTerminal,
    fetchTrendingDexScreener,
    fetchTopTradersDexCheck,
    type TrendingToken,
    type TopTrader,
} from './sources';

/**
 * WalletDiscovery — finds new profitable Solana wallets to copy.
 *
 * Multi-source pipeline:
 *   Source A: DexCheck top trader leaderboards (direct wallet + PnL data)
 *   Source B: GeckoTerminal trending → Helius/RPC early buyers → WalletProfiler
 *   Source C: DexScreener trending (fallback for Source B)
 *
 * All sources feed into the same qualification pipeline.
 */

interface CandidateWallet {
    address: string;
    trades: number;
    wins: number;
    totalPnlUsd: number;
    winRate: number;
    lastSeen: number;
    source: string;
}

export class WalletDiscovery {
    private heliusKey: string | null;
    private existing: Set<string>;
    private maxTracked: number;

    constructor(config: {
        helius_api_key: string | null;
        existing_wallets: string[];
        max_tracked: number;
    }) {
        this.heliusKey = config.helius_api_key;
        this.existing = new Set(config.existing_wallets);
        this.maxTracked = config.max_tracked;
    }

    /**
     * Discover new wallets using multiple sources in parallel.
     */
    async discover(): Promise<TrackedWallet[]> {
        const slotsAvailable = this.maxTracked - this.existing.size;
        if (slotsAvailable <= 0) {
            console.log('[WalletDiscovery] Max tracked wallets reached');
            return [];
        }

        console.log(`[WalletDiscovery] Starting multi-source discovery (${slotsAvailable} slots available)...`);

        // Run sources in parallel
        const [dexCheckWallets, trendingWallets] = await Promise.all([
            this.discoverViaDexCheck(),
            this.discoverViaTrending(),
        ]);

        // Merge candidates, dedup by address
        const merged = new Map<string, CandidateWallet>();

        for (const w of [...dexCheckWallets, ...trendingWallets]) {
            if (this.existing.has(w.address)) continue;
            // Prefer DexCheck data (has real PnL) over trending estimates
            if (!merged.has(w.address) || w.source === 'dexcheck') {
                merged.set(w.address, w);
            }
        }

        console.log(`[WalletDiscovery] ${merged.size} unique candidates (DexCheck: ${dexCheckWallets.length}, Trending: ${trendingWallets.length})`);

        if (merged.size === 0) {
            console.log('[WalletDiscovery] No candidates found from any source');
            return [];
        }

        // Score and rank
        const ranked = Array.from(merged.values())
            .sort((a, b) => {
                // DexCheck wallets get priority (verified PnL)
                const bonusA = a.source === 'dexcheck' ? 2.0 : 1.0;
                const bonusB = b.source === 'dexcheck' ? 2.0 : 1.0;
                const scoreA = (a.winRate / 100) * Math.sqrt(a.trades) * Math.log10(Math.max(1, a.totalPnlUsd + 1)) * bonusA;
                const scoreB = (b.winRate / 100) * Math.sqrt(b.trades) * Math.log10(Math.max(1, b.totalPnlUsd + 1)) * bonusB;
                return scoreB - scoreA;
            })
            .slice(0, slotsAvailable);

        console.log(`[WalletDiscovery] ${ranked.length} wallet(s) selected:`);
        for (const w of ranked) {
            console.log(`  ${w.address.slice(0, 8)}... WR=${w.winRate.toFixed(0)}% PnL=$${w.totalPnlUsd.toFixed(0)} trades=${w.trades} [${w.source}]`);
        }

        const now = Date.now();
        return ranked.map(w => ({
            address: w.address,
            label: `${w.source}-${w.address.slice(0, 6)}`,
            // DexCheck wallets with verified PnL can get higher scores
            score: Math.min(
                w.source === 'dexcheck' ? 90 : 75,
                Math.round(w.winRate * 0.6 + Math.min(40, w.trades * 2)),
            ),
            winRate: w.winRate,
            tradeCount30d: w.trades,
            roi30d: 0,
            lastActive: w.lastSeen,
            addedAt: now,
            source: 'discovery' as const,
        }));
    }

    // ── Source A: DexCheck Top Trader Leaderboards ───────────────────

    private async discoverViaDexCheck(): Promise<CandidateWallet[]> {
        try {
            const traders = await fetchTopTradersDexCheck('7d');
            return traders.map(t => ({
                address: t.walletAddress,
                trades: t.tradeCount,
                wins: Math.round(t.tradeCount * (t.winRate / 100)),
                totalPnlUsd: t.totalPnlUsd,
                winRate: t.winRate,
                lastSeen: Date.now(),
                source: 'dexcheck',
            }));
        } catch (err) {
            console.warn(`[WalletDiscovery] DexCheck error: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }

    // ── Source B: Trending tokens → early buyer analysis ─────────────

    private async discoverViaTrending(): Promise<CandidateWallet[]> {
        // Try GeckoTerminal first, fallback to DexScreener
        let trending = await fetchTrendingGeckoTerminal();
        if (trending.length === 0) {
            console.log('[WalletDiscovery] GeckoTerminal empty — trying DexScreener fallback');
            trending = await fetchTrendingDexScreener();
        }

        if (trending.length === 0) {
            console.log('[WalletDiscovery] No trending tokens from any source');
            return [];
        }

        // For each trending token, find active wallets
        const candidates = new Map<string, CandidateWallet>();
        let heliusAvailable = !!this.heliusKey;

        for (const token of trending.slice(0, 5)) {
            try {
                let buyers: CandidateWallet[] = [];

                if (heliusAvailable) {
                    buyers = await this.findEarlyBuyersHelius(token.mint);
                    if (buyers.length === 0 && candidates.size === 0) {
                        console.log('[WalletDiscovery] Helius unavailable — switching to RPC');
                        heliusAvailable = false;
                    }
                }

                if (!heliusAvailable) {
                    buyers = await this.findTradersViaRpc(token.mint);
                }

                for (const b of buyers) {
                    if (this.existing.has(b.address)) continue;
                    const existing = candidates.get(b.address);
                    if (existing) {
                        existing.trades += b.trades;
                        existing.wins += b.wins;
                        existing.lastSeen = Math.max(existing.lastSeen, b.lastSeen);
                    } else {
                        candidates.set(b.address, b);
                    }
                }

                await new Promise(r => setTimeout(r, heliusAvailable ? 2000 : 1000));
            } catch (err) {
                console.warn(`[WalletDiscovery] Trending error ${token.mint.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }

        // Pre-filter
        const preFiltered = Array.from(candidates.values())
            .filter(c => c.trades >= 2)
            .sort((a, b) => b.trades - a.trades)
            .slice(0, 5);

        // Deep profile if Helius available
        if (heliusAvailable && this.heliusKey && preFiltered.length > 0) {
            console.log(`[WalletDiscovery] Deep profiling ${preFiltered.length} candidates...`);
            const profiler = new WalletProfiler(this.heliusKey);
            const verified: CandidateWallet[] = [];

            for (const c of preFiltered) {
                try {
                    const profile = await profiler.profile(c.address);
                    if (profile.isQualified) {
                        verified.push({
                            ...c,
                            winRate: profile.winRate,
                            totalPnlUsd: profile.estimatedPnlUsd,
                            trades: profile.totalTrades,
                            source: 'helius-verified',
                        });
                    }
                    await new Promise(r => setTimeout(r, 2000));
                } catch { /* skip */ }
            }
            return verified;
        }

        return preFiltered;
    }

    // ── Helius early buyer analysis ────────────────────────────────

    private async findEarlyBuyersHelius(tokenMint: string): Promise<CandidateWallet[]> {
        if (!this.heliusKey) return [];

        try {
            const url = `https://api.helius.xyz/v0/addresses/${tokenMint}/transactions?api-key=${this.heliusKey}&limit=50`;
            const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
            if (!res.ok) {
                if (res.status === 429) return []; // Rate limited
                console.warn(`[WalletDiscovery] Helius HTTP ${res.status} for ${tokenMint.slice(0, 8)}`);
                return [];
            }

            const txns = await res.json() as Array<{
                signature: string; timestamp: number; type: string; feePayer: string;
                events?: { swap?: { tokenInputs?: Array<{ mint: string; tokenAmount?: number }>; tokenOutputs?: Array<{ mint: string; tokenAmount?: number }> } };
                tokenTransfers?: Array<{ mint: string; fromUserAccount?: string; toUserAccount?: string; tokenAmount?: number }>;
            }>;

            if (!Array.isArray(txns)) return [];

            const stablecoins = new Set([
                'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                'So11111111111111111111111111111111111111112',
                'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
            ]);

            const walletStats = new Map<string, { buys: number; sells: number; lastSeen: number }>();

            for (const tx of txns) {
                let isBuy = false, isSell = false;
                const wallet = tx.feePayer;

                if (tx.events?.swap) {
                    const inp = tx.events.swap.tokenInputs?.[0];
                    const out = tx.events.swap.tokenOutputs?.[0];
                    if (inp && out) {
                        isBuy = stablecoins.has(inp.mint) && out.mint === tokenMint;
                        isSell = inp.mint === tokenMint && stablecoins.has(out.mint);
                    }
                }

                if (!isBuy && !isSell && tx.tokenTransfers && tx.tokenTransfers.length >= 2) {
                    for (const t of tx.tokenTransfers) {
                        if (t.toUserAccount === wallet && t.mint === tokenMint) isBuy = true;
                        if (t.fromUserAccount === wallet && t.mint === tokenMint) isSell = true;
                    }
                    if (isBuy && isSell) { isBuy = false; isSell = false; }
                }

                if (!isBuy && !isSell) continue;

                const stats = walletStats.get(wallet) ?? { buys: 0, sells: 0, lastSeen: 0 };
                if (isBuy) stats.buys++;
                if (isSell) stats.sells++;
                stats.lastSeen = Math.max(stats.lastSeen, tx.timestamp * 1000);
                walletStats.set(wallet, stats);
            }

            const candidates: CandidateWallet[] = [];
            for (const [address, stats] of walletStats) {
                if (stats.buys === 0) continue;
                candidates.push({
                    address,
                    trades: stats.buys + stats.sells,
                    wins: Math.min(stats.sells, stats.buys),
                    totalPnlUsd: 0,
                    winRate: stats.buys > 0 ? (Math.min(stats.sells, stats.buys) / stats.buys) * 100 : 0,
                    lastSeen: stats.lastSeen,
                    source: 'helius',
                });
            }
            return candidates;
        } catch {
            return [];
        }
    }

    // ── Solana RPC fallback ────────────────────────────────────────

    private async findTradersViaRpc(tokenMint: string): Promise<CandidateWallet[]> {
        const rpcUrl = 'https://api.mainnet-beta.solana.com';
        const label = tokenMint.slice(0, 8);

        try {
            const sigRes = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1,
                    method: 'getSignaturesForAddress',
                    params: [tokenMint, { limit: 30 }],
                }),
                signal: AbortSignal.timeout(10_000),
            });

            if (!sigRes.ok) return [];

            const sigData = await sigRes.json() as { result?: Array<{ signature: string; blockTime?: number; err: unknown }> };
            const sigs = sigData.result?.filter(s => !s.err) ?? [];
            if (sigs.length === 0) return [];

            const walletActivity = new Map<string, { count: number; lastSeen: number }>();

            for (const sig of sigs.slice(0, 15)) {
                try {
                    const txRes = await fetch(rpcUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            jsonrpc: '2.0', id: 1,
                            method: 'getTransaction',
                            params: [sig.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
                        }),
                        signal: AbortSignal.timeout(10_000),
                    });

                    if (!txRes.ok) continue;
                    const txData = await txRes.json() as any;
                    const tx = txData.result;
                    if (!tx) continue;

                    const feePayer = tx.transaction?.message?.accountKeys?.[0]?.pubkey;
                    if (!feePayer || feePayer.length < 32) continue;

                    const existing = walletActivity.get(feePayer) ?? { count: 0, lastSeen: 0 };
                    existing.count++;
                    existing.lastSeen = Math.max(existing.lastSeen, (sig.blockTime ?? 0) * 1000);
                    walletActivity.set(feePayer, existing);

                    await new Promise(r => setTimeout(r, 150));
                } catch { continue; }
            }

            console.log(`[WalletDiscovery] RPC: ${label} → ${walletActivity.size} unique wallets`);

            const candidates: CandidateWallet[] = [];
            for (const [address, activity] of walletActivity) {
                if (activity.count < 2) continue;
                candidates.push({
                    address,
                    trades: activity.count,
                    wins: Math.floor(activity.count / 2),
                    totalPnlUsd: 0,
                    winRate: 50,
                    lastSeen: activity.lastSeen,
                    source: 'rpc',
                });
            }
            return candidates;
        } catch (err) {
            console.warn(`[WalletDiscovery] RPC error: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }
}
