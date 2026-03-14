import type { WalletTrade } from './types';

/**
 * Wallet Monitor — polls DexScreener/Birdeye for recent trades of tracked wallets.
 *
 * Phase 1: Polling-based (free, no webhook infra needed).
 * Phase 2: Helius webhooks for real-time sub-second detection.
 */
export class WalletMonitor {
    private trackedWallets: Set<string>;
    private lastSeenTx = new Map<string, string>(); // wallet -> last tx signature
    private pollIntervalMs: number;

    constructor(config: {
        wallets: string[];
        poll_interval_ms: number;
    }) {
        this.trackedWallets = new Set(config.wallets);
        this.pollIntervalMs = config.poll_interval_ms;
    }

    get walletCount(): number { return this.trackedWallets.size; }

    addWallet(address: string): void {
        this.trackedWallets.add(address);
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
    async pollNewTrades(): Promise<WalletTrade[]> {
        const allTrades: WalletTrade[] = [];

        for (const wallet of this.trackedWallets) {
            const label = wallet.slice(0, 8);
            try {
                const trades = await Promise.race([
                    this.fetchWalletSwaps(wallet),
                    new Promise<WalletTrade[]>((_, reject) =>
                        setTimeout(() => reject(new Error(`Wallet ${label} poll timeout (15s)`)), 15_000),
                    ),
                ]);
                const lastSeen = this.lastSeenTx.get(wallet);

                for (const trade of trades) {
                    // Skip already-seen transactions
                    if (lastSeen && trade.txSignature === lastSeen) break;
                    allTrades.push(trade);
                }

                // Update last seen
                if (trades.length > 0) {
                    this.lastSeenTx.set(wallet, trades[0].txSignature);
                }
            } catch (err) {
                console.error(`[WalletMonitor] ${label}... error: ${err instanceof Error ? err.message : String(err)}`);
            }

            // Rate limit between wallets
            if (this.trackedWallets.size > 1) {
                await new Promise(r => setTimeout(r, 500));
            }
        }

        return allTrades;
    }

    /**
     * Fetch recent swaps for a wallet using Helius enhanced transactions API.
     * Free tier: 1M credits/month, 10 RPS.
     */
    private async fetchWalletSwaps(walletAddress: string): Promise<WalletTrade[]> {
        const heliusKey = process.env.HELIUS_API_KEY;
        if (!heliusKey) {
            // Fallback: use Solana RPC to get recent transactions (limited parsing)
            return this.fetchViaRpc(walletAddress);
        }

        const url = `https://api.helius.xyz/v0/addresses/${walletAddress}/transactions?api-key=${heliusKey}&type=SWAP&limit=10`;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10_000);
        try {
            const res = await fetch(url, { signal: controller.signal });
            if (!res.ok) return [];

            const txns = (await res.json()) as HeliusTransaction[];
            const trades: WalletTrade[] = [];

            for (const tx of txns) {
                const swap = this.parseHeliusSwap(walletAddress, tx);
                if (swap) trades.push(swap);
            }

            return trades;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    private parseHeliusSwap(walletAddress: string, tx: HeliusTransaction): WalletTrade | null {
        if (!tx.events?.swap) return null;

        const swap = tx.events.swap;
        // Determine if this is a buy or sell based on token flow
        // If the wallet received a non-SOL/USDC token, it's a BUY
        const tokenIn = swap.tokenInputs?.[0];
        const tokenOut = swap.tokenOutputs?.[0];

        if (!tokenIn || !tokenOut) return null;

        const stablecoins = new Set(['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'So11111111111111111111111111111111111111112']);
        const isBuy = stablecoins.has(tokenIn.mint) && !stablecoins.has(tokenOut.mint);
        const isSell = !stablecoins.has(tokenIn.mint) && stablecoins.has(tokenOut.mint);

        if (!isBuy && !isSell) return null;

        const tokenMint = isBuy ? tokenOut.mint : tokenIn.mint;
        const amountUsd = isBuy ? (tokenIn.rawTokenAmount?.decimals ? tokenIn.tokenAmount : 0) : (tokenOut.tokenAmount ?? 0);

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
     * Fallback: minimal RPC-based transaction fetch (no swap parsing).
     * Only used when HELIUS_API_KEY is not set.
     */
    private async fetchViaRpc(_walletAddress: string): Promise<WalletTrade[]> {
        // Phase 1 stub — returns empty, requires Helius for real parsing
        return [];
    }
}

// Helius enhanced transaction types (minimal)
interface HeliusTransaction {
    signature: string;
    timestamp: number;
    type: string;
    events?: {
        swap?: {
            tokenInputs?: HeliusTokenTransfer[];
            tokenOutputs?: HeliusTokenTransfer[];
        };
    };
}

interface HeliusTokenTransfer {
    mint: string;
    symbol?: string;
    tokenAmount?: number;
    rawTokenAmount?: { decimals: number; tokenAmount: string };
}
