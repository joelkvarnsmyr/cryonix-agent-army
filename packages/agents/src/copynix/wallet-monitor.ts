import type { WalletTrade } from './types';

/**
 * Wallet Monitor — polls Helius for recent trades of tracked wallets.
 *
 * Phase 1: Polling-based (free, no webhook infra needed).
 * Phase 2: Helius webhooks for real-time sub-second detection.
 */
export class WalletMonitor {
    private trackedWallets: Set<string>;
    private lastSeenTx = new Map<string, string>(); // wallet -> last tx signature
    private pollIntervalMs: number;
    private pollStats = { calls: 0, errors: 0, rateLimited: 0, swapsFound: 0 };
    private walletRotationIndex = 0;
    private readonly WALLETS_PER_POLL = 10;
    private priorityWallets: Set<string> = new Set(); // Score ≥85 wallets polled EVERY cycle

    constructor(config: {
        wallets: string[];
        poll_interval_ms: number;
    }) {
        this.trackedWallets = new Set(config.wallets);
        this.pollIntervalMs = config.poll_interval_ms;
    }

    get walletCount(): number { return this.trackedWallets.size; }

    getStats() { return { ...this.pollStats }; }

    addWallet(address: string): void {
        this.trackedWallets.add(address);
    }

    setPriorityWallets(addresses: string[]): void {
        this.priorityWallets = new Set(addresses);
    }

    removeWallet(address: string): void {
        this.trackedWallets.delete(address);
        this.lastSeenTx.delete(address);
    }

    /**
     * Poll all tracked wallets for new trades.
     * Uses Helius enhanced transactions API (free tier).
     *
     * Returns new trades since last poll.
     */
    /**
     * Poll ONLY priority wallets. Called every 30s for minimum latency.
     * Separate from pollNewTrades which handles regular rotation.
     */
    async pollPriorityOnly(): Promise<WalletTrade[]> {
        if (this.priorityWallets.size === 0) return [];
        const allTrades: WalletTrade[] = [];

        for (const wallet of this.priorityWallets) {
            const label = wallet.slice(0, 8);
            try {
                this.pollStats.calls++;
                const trades = await Promise.race([
                    this.fetchWalletSwaps(wallet),
                    new Promise<WalletTrade[]>((_, reject) =>
                        setTimeout(() => reject(new Error(`Priority ${label} timeout`)), 10_000),
                    ),
                ]);
                const lastSeen = this.lastSeenTx.get(wallet);
                let newCount = 0;
                for (const trade of trades) {
                    if (lastSeen && trade.txSignature === lastSeen) break;
                    allTrades.push(trade);
                    newCount++;
                }
                if (trades.length > 0) this.lastSeenTx.set(wallet, trades[0].txSignature);
                if (newCount > 0) {
                    this.pollStats.swapsFound += newCount;
                    console.log(`[WalletMonitor] PRIORITY ${label}... ${newCount} new swap(s)`);
                }
            } catch (err) {
                this.pollStats.errors++;
            }
            await new Promise(r => setTimeout(r, 500)); // 500ms between priority wallets
        }
        return allTrades;
    }

    /**
     * Poll regular wallets in rotating batches. Priority wallets excluded
     * (they're polled separately via pollPriorityOnly every 30s).
     */
    async pollNewTrades(): Promise<WalletTrade[]> {
        const allTrades: WalletTrade[] = [];

        // Priority wallets (score ≥85) are polled EVERY cycle for minimum latency.
        // Regular wallets rotate in batches of WALLETS_PER_POLL.
        const walletArray = Array.from(this.trackedWallets);
        const regularWallets = walletArray.filter(w => !this.priorityWallets.has(w));

        // Always include priority wallets
        const batch: string[] = [...this.priorityWallets];

        // Add rotating batch of regular wallets
        const regularBatch = regularWallets.slice(
            this.walletRotationIndex,
            this.walletRotationIndex + this.WALLETS_PER_POLL,
        );
        if (regularBatch.length < this.WALLETS_PER_POLL && this.walletRotationIndex > 0) {
            const remaining = this.WALLETS_PER_POLL - regularBatch.length;
            regularBatch.push(...regularWallets.slice(0, remaining));
        }
        this.walletRotationIndex = (this.walletRotationIndex + this.WALLETS_PER_POLL) % Math.max(1, regularWallets.length);
        batch.push(...regularBatch);

        for (const wallet of batch) {
            const label = wallet.slice(0, 8);
            try {
                this.pollStats.calls++;
                const trades = await Promise.race([
                    this.fetchWalletSwaps(wallet),
                    new Promise<WalletTrade[]>((_, reject) =>
                        setTimeout(() => reject(new Error(`Wallet ${label} poll timeout (15s)`)), 15_000),
                    ),
                ]);
                const lastSeen = this.lastSeenTx.get(wallet);

                let newCount = 0;
                for (const trade of trades) {
                    // Skip already-seen transactions
                    if (lastSeen && trade.txSignature === lastSeen) break;
                    allTrades.push(trade);
                    newCount++;
                }

                // Update last seen
                if (trades.length > 0) {
                    this.lastSeenTx.set(wallet, trades[0].txSignature);
                }

                if (newCount > 0) {
                    this.pollStats.swapsFound += newCount;
                    console.log(`[WalletMonitor] ${label}... ${newCount} new swap(s) detected`);
                }
            } catch (err) {
                this.pollStats.errors++;
                console.error(`[WalletMonitor] ${label}... error: ${err instanceof Error ? err.message : String(err)}`);
            }

            // Rate limit between wallets (1s to stay under Helius 10 RPS free tier)
            if (this.trackedWallets.size > 1) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        return allTrades;
    }

    /**
     * Fetch recent swaps for a wallet using Helius enhanced transactions API.
     * Free tier: 1M credits/month, 10 RPS.
     *
     * NOTE: We fetch ALL transaction types (not just SWAP) because Jupiter
     * aggregator swaps can be classified as different types by Helius.
     * We then parse swap events in code.
     */
    private async fetchWalletSwaps(walletAddress: string): Promise<WalletTrade[]> {
        const heliusKey = process.env.HELIUS_API_KEY;
        if (!heliusKey) {
            return this.fetchViaRpc(walletAddress);
        }

        const label = walletAddress.slice(0, 8);

        // Fetch all types, not just SWAP — Jupiter/Raydium/Orca swaps can be
        // classified differently by Helius (TRANSFER, UNKNOWN, etc.)
        const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${heliusKey}&limit=20`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) {
                if (res.status === 429) {
                    this.pollStats.rateLimited++;
                    // Fall back to Shyft if available, then RPC
                    const shyftResult = await this.fetchViaShyft(walletAddress);
                    if (shyftResult.length > 0) return shyftResult;
                    return this.fetchViaRpc(walletAddress);
                }
                console.warn(`[WalletMonitor] ${label}... Helius HTTP ${res.status}: ${res.statusText}`);
                return [];
            }

            const txns = (await res.json()) as HeliusTransaction[];
            if (!Array.isArray(txns)) {
                console.warn(`[WalletMonitor] ${label}... Helius returned non-array response`);
                return [];
            }

            const trades: WalletTrade[] = [];
            const typeCounts = new Map<string, number>();

            for (const tx of txns) {
                // Track transaction types for diagnostics
                const txType = tx.type ?? 'UNKNOWN';
                typeCounts.set(txType, (typeCounts.get(txType) ?? 0) + 1);

                const swap = this.parseHeliusSwap(walletAddress, tx);
                if (swap) trades.push(swap);
            }

            // Log diagnostics on first poll or when we find something interesting
            if (!this.lastSeenTx.has(walletAddress) || trades.length > 0) {
                const typeStr = Array.from(typeCounts.entries()).map(([t, c]) => `${t}:${c}`).join(', ');
                console.log(`[WalletMonitor] ${label}... ${txns.length} tx(s) [${typeStr}] → ${trades.length} swap(s)`);
            }

            return trades;
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                console.warn(`[WalletMonitor] ${label}... Helius request timed out (10s)`);
            } else {
                console.warn(`[WalletMonitor] ${label}... Helius fetch error: ${err instanceof Error ? err.message : String(err)}`);
            }
            return [];
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private parseHeliusSwap(walletAddress: string, tx: HeliusTransaction): WalletTrade | null {
        // Try events.swap first (standard Helius swap detection)
        if (tx.events?.swap) {
            return this.parseSwapEvent(walletAddress, tx, tx.events.swap);
        }

        // Fallback: check tokenTransfers for swap-like patterns
        // (Jupiter V6 sometimes classified as UNKNOWN or TRANSFER)
        if (tx.tokenTransfers && tx.tokenTransfers.length >= 2) {
            return this.parseTokenTransfers(walletAddress, tx);
        }

        return null;
    }

    private parseSwapEvent(
        walletAddress: string,
        tx: HeliusTransaction,
        swap: NonNullable<HeliusTransaction['events']>['swap'],
    ): WalletTrade | null {
        if (!swap) return null;

        const tokenIn = swap.tokenInputs?.[0];
        const tokenOut = swap.tokenOutputs?.[0];
        if (!tokenIn || !tokenOut) return null;

        const stablecoins = new Set([
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
            'So11111111111111111111111111111111111111112',      // SOL (wrapped)
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',   // USDT
        ]);
        const isBuy = stablecoins.has(tokenIn.mint) && !stablecoins.has(tokenOut.mint);
        const isSell = !stablecoins.has(tokenIn.mint) && stablecoins.has(tokenOut.mint);

        if (!isBuy && !isSell) return null;

        const tokenMint = isBuy ? tokenOut.mint : tokenIn.mint;
        const amountUsd = isBuy ? (tokenIn.tokenAmount ?? 0) : (tokenOut.tokenAmount ?? 0);

        return {
            walletAddress,
            tokenMint,
            tokenSymbol: isBuy ? (tokenOut.symbol ?? 'UNKNOWN') : (tokenIn.symbol ?? 'UNKNOWN'),
            action: isBuy ? 'BUY' : 'SELL',
            amountUsd: amountUsd ?? 0,
            priceUsd: 0, // Will be enriched by DexScreener lookup
            timestamp: tx.timestamp * 1000,
            txSignature: tx.signature,
        };
    }

    /**
     * Fallback swap detection: analyze tokenTransfers array.
     * Handles Jupiter V6 routes, Raydium, and other DEX swaps that
     * Helius doesn't classify under events.swap.
     */
    private parseTokenTransfers(walletAddress: string, tx: HeliusTransaction): WalletTrade | null {
        const transfers = tx.tokenTransfers ?? [];
        const walletLower = walletAddress.toLowerCase();

        const stablecoins = new Set([
            'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
            'So11111111111111111111111111111111111111112',
            'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
        ]);

        // Find what the wallet sent out and received
        let sentStable = false;
        let receivedToken: { mint: string; symbol: string; amount: number } | null = null;
        let sentToken: { mint: string; symbol: string; amount: number } | null = null;
        let receivedStable = false;

        for (const t of transfers) {
            const fromWallet = t.fromUserAccount?.toLowerCase() === walletLower;
            const toWallet = t.toUserAccount?.toLowerCase() === walletLower;

            if (fromWallet && stablecoins.has(t.mint)) {
                sentStable = true;
            }
            if (toWallet && !stablecoins.has(t.mint)) {
                receivedToken = { mint: t.mint, symbol: t.symbol ?? 'UNKNOWN', amount: t.tokenAmount ?? 0 };
            }
            if (fromWallet && !stablecoins.has(t.mint)) {
                sentToken = { mint: t.mint, symbol: t.symbol ?? 'UNKNOWN', amount: t.tokenAmount ?? 0 };
            }
            if (toWallet && stablecoins.has(t.mint)) {
                receivedStable = true;
            }
        }

        // BUY: sent stable, received token
        if (sentStable && receivedToken) {
            return {
                walletAddress,
                tokenMint: receivedToken.mint,
                tokenSymbol: receivedToken.symbol,
                action: 'BUY',
                amountUsd: 0,
                priceUsd: 0,
                timestamp: tx.timestamp * 1000,
                txSignature: tx.signature,
            };
        }

        // SELL: sent token, received stable
        if (sentToken && receivedStable) {
            return {
                walletAddress,
                tokenMint: sentToken.mint,
                tokenSymbol: sentToken.symbol,
                action: 'SELL',
                amountUsd: 0,
                priceUsd: 0,
                timestamp: tx.timestamp * 1000,
                txSignature: tx.signature,
            };
        }

        return null;
    }

    /**
     * Fallback: detect wallet activity via public Solana RPC.
     * Cannot parse swap details without Helius — logs activity for monitoring.
     */
    private async fetchViaShyft(walletAddress: string): Promise<WalletTrade[]> {
        const shyftKey = process.env.SHYFT_API_KEY;
        if (!shyftKey) return [];

        try {
            // Shyft transaction history API — similar to Helius enhanced
            const url = `https://api.shyft.to/sol/v1/transaction/history?network=mainnet-beta&tx_num=10&account=${walletAddress}&enable_raw=false`;
            const res = await fetch(url, {
                headers: { 'x-api-key': shyftKey },
                signal: AbortSignal.timeout(10_000),
            });

            if (!res.ok) return [];

            const json = await res.json() as { success: boolean; result: any[] };
            if (!json.success || !Array.isArray(json.result)) return [];

            const trades: WalletTrade[] = [];
            for (const tx of json.result) {
                // Shyft returns parsed actions
                const actions = tx.actions ?? [];
                for (const action of actions) {
                    if (action.type !== 'TOKEN_SWAP' && action.type !== 'SWAP') continue;
                    const info = action.info ?? {};

                    const isBuy = STABLECOINS.has(info.tokens_swapped?.in?.token_address ?? '') &&
                                  !STABLECOINS.has(info.tokens_swapped?.out?.token_address ?? '');
                    const isSell = !STABLECOINS.has(info.tokens_swapped?.in?.token_address ?? '') &&
                                   STABLECOINS.has(info.tokens_swapped?.out?.token_address ?? '');

                    if (!isBuy && !isSell) continue;

                    trades.push({
                        walletAddress,
                        tokenMint: isBuy ? info.tokens_swapped.out.token_address : info.tokens_swapped.in.token_address,
                        tokenSymbol: isBuy ? (info.tokens_swapped.out.symbol ?? 'UNKNOWN') : (info.tokens_swapped.in.symbol ?? 'UNKNOWN'),
                        action: isBuy ? 'BUY' : 'SELL',
                        amountUsd: 0,
                        priceUsd: 0,
                        timestamp: (tx.timestamp ? new Date(tx.timestamp).getTime() : Date.now()),
                        txSignature: tx.signatures?.[0] ?? tx.txhash ?? '',
                    });
                }
            }

            if (trades.length > 0) {
                console.log(`[WalletMonitor] Shyft: ${walletAddress.slice(0, 8)}... ${trades.length} swap(s)`);
            }
            return trades;
        } catch {
            return [];
        }
    }

    private async fetchViaRpc(walletAddress: string): Promise<WalletTrade[]> {
        try {
            const rpcUrl = 'https://api.mainnet-beta.solana.com';
            const sigRes = await fetch(rpcUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id: 1,
                    method: 'getSignaturesForAddress',
                    params: [walletAddress, { limit: 5 }],
                }),
                signal: AbortSignal.timeout(10_000),
            });
            if (!sigRes.ok) return [];

            const sigData = (await sigRes.json()) as { result?: Array<{ signature: string; blockTime?: number; err: unknown }> };
            const sigs = sigData.result?.filter(s => !s.err) ?? [];
            if (sigs.length === 0) return [];

            // Check for new transactions since last seen
            const lastSeen = this.lastSeenTx.get(walletAddress);
            let newCount = 0;
            for (const sig of sigs) {
                if (lastSeen && sig.signature === lastSeen) break;
                newCount++;
            }

            // Update last seen for dedup
            if (sigs.length > 0) {
                this.lastSeenTx.set(walletAddress, sigs[0].signature);
            }

            if (newCount > 0) {
                console.log(`[WalletMonitor] RPC fallback: ${walletAddress.slice(0, 8)}... has ${newCount} new tx(s) — set HELIUS_API_KEY for swap parsing`);
            }

            return [];
        } catch {
            return [];
        }
    }
}

// Helius enhanced transaction types
interface HeliusTransaction {
    signature: string;
    timestamp: number;
    type: string;
    feePayer?: string;
    events?: {
        swap?: {
            tokenInputs?: HeliusTokenTransfer[];
            tokenOutputs?: HeliusTokenTransfer[];
        };
    };
    tokenTransfers?: HeliusTokenTransferFlat[];
}

interface HeliusTokenTransfer {
    mint: string;
    symbol?: string;
    tokenAmount?: number;
    rawTokenAmount?: { decimals: number; tokenAmount: string };
}

interface HeliusTokenTransferFlat {
    mint: string;
    symbol?: string;
    tokenAmount?: number;
    fromUserAccount?: string;
    toUserAccount?: string;
}
