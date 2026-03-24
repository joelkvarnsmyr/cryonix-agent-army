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
    private reconnectAttempts = 0;
    private readonly MAX_RECONNECTS = 3;
    private everConnected = false; // true only after successful open

    constructor(heliusKey: string, wallets: string[]) {
        this.heliusKey = heliusKey;
        this.wallets = wallets;
    }

    /**
     * Connect to Helius WebSocket and subscribe to wallet transactions.
     */
    async connect(): Promise<boolean> {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const WebSocket = require('ws');
            // Use Helius RPC WebSocket (free tier includes standard RPC WS)
            // or fall back to env-configured SOLANA_WS_URL
            const wsUrl = process.env.SOLANA_WS_URL
                ?? `wss://mainnet.helius-rpc.com/?api-key=${this.heliusKey}`;

            return new Promise((resolve) => {
                this.ws = new WebSocket(wsUrl);

                this.ws.on('open', () => {
                    console.log('[WS-Monitor] Connected to Solana WebSocket');
                    this.connected = true;
                    this.everConnected = true;
                    this.reconnectAttempts = 0;
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
                    if (this.everConnected) {
                        // Was connected before — try to reconnect
                        console.warn('[WS-Monitor] WebSocket disconnected — reconnecting in 30s');
                        this.connected = false;
                        this.scheduleReconnect();
                    }
                    // Never connected (initial 403) → don't reconnect, silently use polling
                });

                this.ws.on('error', (err: any) => {
                    if (!this.connected) {
                        // Initial connection failed — log once and give up
                        console.warn(`[WS-Monitor] WebSocket failed: ${err.message} — using polling mode`);
                    }
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
     * Subscribe to log events mentioning tracked wallets.
     * Uses standard Solana logsSubscribe (free, no API key).
     *
     * We subscribe per wallet using "mentions" filter — each subscription
     * fires when the wallet appears in any transaction logs.
     * Max ~40 subscriptions on public RPC.
     */
    private subscribe(): void {
        if (!this.ws || !this.connected) return;

        // Subscribe to wallets up to Solana/Helius WS limit (~25 per connection).
        // Priority wallets (first in array) get subscribed first.
        // Remaining wallets are covered by polling.
        const maxSubs = 25;
        const walletsToSub = this.wallets.slice(0, maxSubs);
        for (let i = 0; i < walletsToSub.length; i++) {
            const subscribeMsg = {
                jsonrpc: '2.0',
                id: i + 1,
                method: 'logsSubscribe',
                params: [
                    { mentions: [walletsToSub[i]] },
                    { commitment: 'confirmed' },
                ],
            };
            this.ws.send(JSON.stringify(subscribeMsg));
        }

        console.log(`[WS-Monitor] Subscribed to ${walletsToSub.length}/${this.wallets.length} wallets via logsSubscribe (limit: ${maxSubs})`);
    }

    /**
     * Handle incoming WebSocket message.
     * logsSubscribe returns log notifications with signature — we then
     * use Helius enhanced API to get full parsed transaction details.
     */
    private handleMessage(msg: any): void {
        // Subscription confirmations
        if (msg.result !== undefined && typeof msg.id === 'number') {
            if (!this.subscriptionId) {
                this.subscriptionId = msg.result;
                console.log(`[WS-Monitor] First subscription confirmed (id: ${msg.result})`);
            }
            return;
        }

        // Log notification — a tracked wallet had activity
        if (msg.method === 'logsNotification' && msg.params?.result?.value) {
            const value = msg.params.result.value;
            const signature = value.signature;
            const err = value.err;

            // Skip failed transactions
            if (err) return;

            // Detect swap programs in the logs
            const logs: string[] = value.logs ?? [];
            const isSwap = logs.some((log: string) =>
                log.includes('JUP') ||           // Jupiter
                log.includes('whirLbMiicV') ||    // Orca Whirlpool
                log.includes('675kPX9MHTjS') ||   // Raydium AMM
                log.includes('CAMMCzo5Y') ||       // Raydium CLMM
                log.includes('srmqPvymJe') ||      // Serum/OpenBook
                log.includes('Swap') ||
                log.includes('swap'),
            );

            if (!isSwap) return;

            // We detected a swap — fetch full details via Helius
            this.fetchAndParseTransaction(signature);
        }
    }

    /**
     * Fetch full transaction details from Helius and parse swap direction.
     * Called when WebSocket detects swap activity.
     */
    private async fetchAndParseTransaction(signature: string): Promise<void> {
        try {
            const url = `https://api.helius.xyz/v0/transactions/?api-key=${this.heliusKey}&transactions=${signature}`;
            const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
            if (!res.ok) return;

            const txns = await res.json() as any[];
            if (!Array.isArray(txns) || txns.length === 0) return;

            const tx = txns[0];
            const feePayer = tx.feePayer;
            if (!feePayer || !this.wallets.includes(feePayer)) return;

            // Parse swap from Helius enhanced format
            if (tx.events?.swap) {
                const swap = tx.events.swap;
                const tokenIn = swap.tokenInputs?.[0];
                const tokenOut = swap.tokenOutputs?.[0];
                if (!tokenIn || !tokenOut) return;

                const isBuy = STABLECOINS.has(tokenIn.mint) && !STABLECOINS.has(tokenOut.mint);
                const isSell = !STABLECOINS.has(tokenIn.mint) && STABLECOINS.has(tokenOut.mint);
                if (!isBuy && !isSell) return;

                const trade: WalletTrade = {
                    walletAddress: feePayer,
                    tokenMint: isBuy ? tokenOut.mint : tokenIn.mint,
                    tokenSymbol: isBuy ? (tokenOut.symbol ?? 'UNKNOWN') : (tokenIn.symbol ?? 'UNKNOWN'),
                    action: isBuy ? 'BUY' : 'SELL',
                    amountUsd: 0,
                    priceUsd: 0,
                    timestamp: (tx.timestamp ?? 0) * 1000 || Date.now(),
                    txSignature: signature,
                };

                this.tradeBuffer.push(trade);
                console.log(`[WS-Monitor] REAL-TIME ${trade.action}: ${feePayer.slice(0, 8)}... ${trade.tokenSymbol}`);
            }
        } catch {
            // Non-critical — skip this transaction
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
        this.reconnectAttempts++;
        if (this.reconnectAttempts > this.MAX_RECONNECTS) {
            console.warn(`[WS-Monitor] Max reconnects (${this.MAX_RECONNECTS}) reached — giving up, using polling`);
            return;
        }
        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            console.log(`[WS-Monitor] Reconnect attempt ${this.reconnectAttempts}/${this.MAX_RECONNECTS}...`);
            await this.connect();
        }, 30_000);
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
