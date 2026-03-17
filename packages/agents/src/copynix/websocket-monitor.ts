import type { WalletTrade } from './types';

/**
 * WebSocket-based wallet monitor using Helius Enhanced WebSocket API.
 *
 * Subscribes to transactionNotification for tracked wallets.
 * Sub-second latency vs 5-minute polling — critical for Solana memecoins.
 *
 * Falls back to polling if WebSocket connection fails.
 */

const STABLECOINS = new Set([
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'So11111111111111111111111111111111111111112',      // SOL
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',   // USDT
]);

export class WebSocketMonitor {
    private ws: any = null;
    private heliusKey: string;
    private wallets: string[];
    private tradeBuffer: WalletTrade[] = [];
    private connected = false;
    private reconnectTimer: any = null;
    private subscriptionId: number | null = null;

    constructor(heliusKey: string, wallets: string[]) {
        this.heliusKey = heliusKey;
        this.wallets = wallets;
    }

    /**
     * Connect to Helius WebSocket and subscribe to wallet transactions.
     */
    async connect(): Promise<boolean> {
        try {
            const WebSocket = (await import('ws')).default;
            // Try Helius WebSocket first (enhanced, requires paid plan)
            // Fallback: standard Solana WebSocket (free but limited parsing)
            const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${this.heliusKey}`;

            return new Promise((resolve) => {
                this.ws = new WebSocket(wsUrl);

                this.ws.on('open', () => {
                    console.log('[WS-Monitor] Connected to Helius WebSocket');
                    this.connected = true;
                    this.subscribe();
                    resolve(true);
                });

                this.ws.on('message', (data: any) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        this.handleMessage(msg);
                    } catch { /* ignore parse errors */ }
                });

                this.ws.on('close', () => {
                    if (this.connected) {
                        // Only reconnect if we were previously connected (not initial 403)
                        console.warn('[WS-Monitor] WebSocket disconnected — reconnecting in 30s');
                        this.connected = false;
                        this.scheduleReconnect();
                    }
                });

                this.ws.on('error', (err: any) => {
                    console.error('[WS-Monitor] WebSocket error:', err.message);
                    this.connected = false;
                    resolve(false);
                });

                // Timeout if connection takes too long
                setTimeout(() => {
                    if (!this.connected) {
                        console.warn('[WS-Monitor] Connection timeout (10s)');
                        resolve(false);
                    }
                }, 10_000);
            });
        } catch (err) {
            console.warn('[WS-Monitor] Failed to initialize:', err instanceof Error ? err.message : String(err));
            return false;
        }
    }

    /**
     * Subscribe to transactions for all tracked wallets.
     * Uses Helius transactionSubscribe with accountInclude filter.
     */
    private subscribe(): void {
        if (!this.ws || !this.connected) return;

        // Subscribe to transactions involving any of our tracked wallets
        // Helius supports filtering by accountInclude
        const subscribeMsg = {
            jsonrpc: '2.0',
            id: 1,
            method: 'transactionSubscribe',
            params: [
                {
                    accountInclude: this.wallets,
                },
                {
                    commitment: 'confirmed',
                    encoding: 'jsonParsed',
                    transactionDetails: 'full',
                    maxSupportedTransactionVersion: 0,
                },
            ],
        };

        this.ws.send(JSON.stringify(subscribeMsg));
        console.log(`[WS-Monitor] Subscribed to ${this.wallets.length} wallets`);
    }

    /**
     * Handle incoming WebSocket message — parse for swap transactions.
     */
    private handleMessage(msg: any): void {
        // Subscription confirmation
        if (msg.result !== undefined && msg.id === 1) {
            this.subscriptionId = msg.result;
            console.log(`[WS-Monitor] Subscription confirmed: ${this.subscriptionId}`);
            return;
        }

        // Transaction notification
        if (msg.method === 'transactionNotification' && msg.params?.result) {
            const tx = msg.params.result;
            this.parseTransaction(tx);
        }
    }

    /**
     * Parse a WebSocket transaction notification for swap activity.
     */
    private parseTransaction(tx: any): void {
        try {
            const signature = tx.signature;
            const transaction = tx.transaction;
            if (!transaction) return;

            // Find which tracked wallet is the fee payer
            const accountKeys = transaction.message?.accountKeys ?? [];
            const feePayer = accountKeys[0]?.pubkey;
            if (!feePayer || !this.wallets.includes(feePayer)) return;

            // Look for token transfers that indicate swaps
            const meta = tx.meta;
            if (!meta) return;

            const preBalances = meta.preTokenBalances ?? [];
            const postBalances = meta.postTokenBalances ?? [];

            // Detect token flow: what went in/out for the fee payer
            let sentStable = false;
            let receivedToken: { mint: string; amount: number } | null = null;
            let sentToken: { mint: string; amount: number } | null = null;
            let receivedStable = false;

            for (const post of postBalances) {
                const pre = preBalances.find((p: any) => p.accountIndex === post.accountIndex && p.mint === post.mint);
                const preAmount = pre?.uiTokenAmount?.uiAmount ?? 0;
                const postAmount = post.uiTokenAmount?.uiAmount ?? 0;
                const diff = postAmount - preAmount;
                const owner = post.owner;

                if (owner !== feePayer) continue;

                if (STABLECOINS.has(post.mint)) {
                    if (diff < 0) sentStable = true;
                    if (diff > 0) receivedStable = true;
                } else {
                    if (diff > 0) receivedToken = { mint: post.mint, amount: diff };
                    if (diff < 0) sentToken = { mint: post.mint, amount: Math.abs(diff) };
                }
            }

            // Determine trade direction
            if (sentStable && receivedToken) {
                this.tradeBuffer.push({
                    walletAddress: feePayer,
                    tokenMint: receivedToken.mint,
                    tokenSymbol: 'UNKNOWN', // Will be enriched by DexScreener
                    action: 'BUY',
                    amountUsd: 0,
                    priceUsd: 0,
                    timestamp: Date.now(),
                    txSignature: signature,
                });
                console.log(`[WS-Monitor] REAL-TIME BUY detected: ${feePayer.slice(0, 8)}... → ${receivedToken.mint.slice(0, 8)}...`);
            }

            if (sentToken && receivedStable) {
                this.tradeBuffer.push({
                    walletAddress: feePayer,
                    tokenMint: sentToken.mint,
                    tokenSymbol: 'UNKNOWN',
                    action: 'SELL',
                    amountUsd: 0,
                    priceUsd: 0,
                    timestamp: Date.now(),
                    txSignature: signature,
                });
                console.log(`[WS-Monitor] REAL-TIME SELL detected: ${feePayer.slice(0, 8)}... ← ${sentToken.mint.slice(0, 8)}...`);
            }
        } catch {
            // Ignore parse errors on individual transactions
        }
    }

    /**
     * Drain the trade buffer — returns all trades since last drain.
     * Called by the main loop instead of pollNewTrades().
     */
    drainTrades(): WalletTrade[] {
        const trades = [...this.tradeBuffer];
        this.tradeBuffer = [];
        return trades;
    }

    get isConnected(): boolean {
        return this.connected;
    }

    get bufferedCount(): number {
        return this.tradeBuffer.length;
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            console.log('[WS-Monitor] Attempting reconnect...');
            await this.connect();
        }, 10_000);
    }

    async disconnect(): Promise<void> {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        try {
            this.ws?.close();
        } catch { /* ignore */ }
        this.connected = false;
    }
}
