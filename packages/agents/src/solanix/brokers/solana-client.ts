import { randomUUID } from 'crypto';
import type { BrokerClient, BrokerOrder, BrokerOrderResult } from '../../aktienix/brokers/types';
import type { AccountState, StockPosition } from '../../aktienix/types';

// USDC mint on Solana mainnet
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// Jupiter quote API — quote 1 USDC (1_000_000 micro-USDC) worth of outputMint
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote';

const KNOWN_MINTS: Record<string, string> = {
    SOL: 'So11111111111111111111111111111111111111112',
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    PYTH: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3',
    RNDR: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',
    USDC: USDC_MINT,
};

/** Token decimals — used to correctly interpret Jupiter outAmount. */
const TOKEN_DECIMALS: Record<string, number> = {
    SOL: 9,
    JUP: 6,
    BONK: 5,
    WIF: 6,
    PYTH: 6,
    RNDR: 8,
    USDC: 6,
    RAY: 6,
    ORCA: 6,
    JTO: 9,
    W: 6,
    HNT: 8,
    DRIFT: 6,
    POPCAT: 9,
    MEW: 5,
};

export interface SolanaClientConfig {
    rpcUrl: string;
    paperTrading: boolean;
    initialUsdcBalance?: number;
}

interface PaperPosition {
    symbol: string;
    mintAddress: string;
    /** Token quantity held */
    tokenQty: number;
    avgEntryPrice: number;
    currentPrice: number;
}

export class SolanaClient implements BrokerClient {
    private readonly config: SolanaClientConfig;
    private connected = false;

    // Paper trading state
    private usdcBalance: number;
    private paperPositions: Map<string, PaperPosition> = new Map();

    // Dynamic token registry (symbol -> mint address)
    private dynamicMints: Map<string, string> = new Map();

    constructor(config: SolanaClientConfig) {
        this.config = config;
        this.usdcBalance = config.initialUsdcBalance ?? 500;
    }

    // -------------------------------------------------------------------------
    // BrokerClient interface
    // -------------------------------------------------------------------------

    async connect(): Promise<void> {
        // In paper mode no wallet or RPC auth is required.
        this.connected = true;
    }

    async disconnect(): Promise<void> {
        this.connected = false;
    }

    async getAccountState(): Promise<AccountState> {
        const positionsValue = Array.from(this.paperPositions.values()).reduce(
            (sum, p) => sum + p.tokenQty * p.currentPrice,
            0,
        );
        const portfolioValue = this.usdcBalance + positionsValue;

        return {
            buyingPower: this.usdcBalance,
            settledCash: this.usdcBalance,
            portfolioValue,
            isPatternDayTrader: false,
            dailyPnl: 0,
            dailyPnlPct: 0,
            updatedAt: Date.now(),
        };
    }

    async getPositions(): Promise<StockPosition[]> {
        return Array.from(this.paperPositions.values()).map((p) => ({
            symbol: p.symbol,
            qty: p.tokenQty,
            avgEntryPrice: p.avgEntryPrice,
            currentPrice: p.currentPrice,
            marketValue: p.tokenQty * p.currentPrice,
            unrealizedPl: p.tokenQty * (p.currentPrice - p.avgEntryPrice),
            unrealizedPlPct: p.avgEntryPrice > 0
                ? ((p.currentPrice - p.avgEntryPrice) / p.avgEntryPrice) * 100
                : 0,
        }));
    }

    async submitOrder(order: BrokerOrder): Promise<BrokerOrderResult> {
        if (!this.connected) {
            return { success: false, message: 'Client not connected' };
        }

        const mint = this.getMintAddress(order.symbol);
        if (!mint) {
            return {
                success: false,
                message: `Unknown symbol ${order.symbol} — call addDynamicToken() first`,
            };
        }

        // qty is dollar amount (USDC)
        const usdcAmount = order.qty;

        // Fetch price from Jupiter
        const priceResult = await this.fetchJupiterPrice(mint, order.action, usdcAmount);
        if (!priceResult.success) {
            return { success: false, message: priceResult.message };
        }
        const tokenPrice = priceResult.price!;

        if (order.action === 'BUY') {
            return this.executePaperBuy(order.symbol, mint, usdcAmount, tokenPrice);
        } else {
            return this.executePaperSell(order.symbol, usdcAmount, tokenPrice);
        }
    }

    /**
     * Close an entire position by selling all held tokens.
     */
    async closePosition(symbol: string): Promise<BrokerOrderResult> {
        const pos = this.paperPositions.get(symbol);
        if (!pos) {
            return { success: false, message: `No open position for ${symbol}` };
        }
        // Sell the full market value
        const marketValue = pos.tokenQty * pos.currentPrice;
        return this.submitOrder({
            symbol,
            action: 'SELL',
            qty: marketValue,
            orderType: 'MARKET',
        });
    }

    // -------------------------------------------------------------------------
    // Extended API (used by SolanaAgent)
    // -------------------------------------------------------------------------

    /** Restore a paper position from DB on restart */
    restorePaperPosition(symbol: string, mintAddress: string, qty: number, avgEntryPrice: number, currentPrice: number): void {
        this.paperPositions.set(symbol, { symbol, mintAddress, tokenQty: qty, avgEntryPrice, currentPrice });
        // Deduct from USDC balance (position cost was already spent)
        this.usdcBalance -= qty * avgEntryPrice;
        // Ensure mint is known
        if (!KNOWN_MINTS[symbol.toUpperCase()]) {
            this.dynamicMints.set(symbol.toUpperCase(), mintAddress);
        }
    }

    addDynamicToken(symbol: string, mintAddress: string, decimals?: number): void {
        const upper = symbol.toUpperCase();
        this.dynamicMints.set(upper, mintAddress);
        if (decimals !== undefined) {
            TOKEN_DECIMALS[upper] = decimals;
        }
    }

    getMintAddress(symbol: string): string | undefined {
        const upper = symbol.toUpperCase();
        return KNOWN_MINTS[upper] ?? this.dynamicMints.get(upper);
    }

    /**
     * Refresh current prices for all held positions via Jupiter.
     * Called once per agent loop so unrealizedPl stays fresh.
     */
    async refreshPositionPrices(): Promise<void> {
        for (const [symbol, pos] of this.paperPositions.entries()) {
            const result = await this.fetchJupiterPrice(pos.mintAddress, 'BUY', 1);
            if (result.success && result.price) {
                pos.currentPrice = result.price;
                this.paperPositions.set(symbol, pos);
            }
        }
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    /**
     * Fetch token price in USD.
     * Tries Jupiter first; falls back to DexScreener if Jupiter is unavailable.
     */
    /** Resolve token decimals — checks TOKEN_DECIMALS by symbol, defaults to 6. */
    private getTokenDecimals(mint: string): number {
        // Reverse lookup: find symbol for this mint address
        for (const [sym, addr] of Object.entries(KNOWN_MINTS)) {
            if (addr === mint) return TOKEN_DECIMALS[sym] ?? 6;
        }
        for (const [sym, addr] of this.dynamicMints.entries()) {
            if (addr === mint) return TOKEN_DECIMALS[sym] ?? 6;
        }
        return 6; // conservative default
    }

    /** Max acceptable divergence between Jupiter and DexScreener prices */
    private readonly MAX_PRICE_DIVERGENCE = 0.10; // 10%

    private async fetchJupiterPrice(
        mint: string,
        _side: 'BUY' | 'SELL',
        _usdcAmount: number,
    ): Promise<{ success: boolean; price?: number; message?: string }> {
        const tokenDecimals = this.getTokenDecimals(mint);

        let jupiterPrice: number | null = null;
        let dexPrice: number | null = null;

        // 1. Try Jupiter — quote 1 USDC worth of the output token
        try {
            const url =
                `${JUPITER_QUOTE_URL}` +
                `?inputMint=${USDC_MINT}` +
                `&outputMint=${mint}` +
                `&amount=1000000` +
                `&slippageBps=50`;

            const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
            if (res.ok) {
                const data = (await res.json()) as { outAmount: string };
                const tokensPerUsdc = Number(data.outAmount) / (10 ** tokenDecimals);
                if (tokensPerUsdc > 0) {
                    jupiterPrice = 1 / tokensPerUsdc;
                }
            }
        } catch {
            // Jupiter unreachable — fall through to DexScreener
        }

        // 2. Fetch DexScreener price (always, for cross-validation)
        try {
            const res = await fetch(
                `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
                { signal: AbortSignal.timeout(8_000) },
            );
            if (res.ok) {
                const data = (await res.json()) as { pairs?: { priceUsd?: string; chainId?: string }[] };
                const solPair = data.pairs?.find(p => p.chainId === 'solana' && p.priceUsd);
                if (solPair?.priceUsd) {
                    dexPrice = parseFloat(solPair.priceUsd);
                }
            }
        } catch {
            // DexScreener unreachable
        }

        // 3. Cross-validate: if both sources available, check divergence
        if (jupiterPrice && dexPrice) {
            const divergence = Math.abs(jupiterPrice - dexPrice) / dexPrice;
            if (divergence > this.MAX_PRICE_DIVERGENCE) {
                console.warn(
                    `[price] BAD QUOTE: Jupiter=$${jupiterPrice.toFixed(6)} vs DexScreener=$${dexPrice.toFixed(6)} ` +
                    `(${(divergence * 100).toFixed(1)}% divergence) — using DexScreener`,
                );
                return { success: true, price: dexPrice };
            }
            // Both agree — use Jupiter (more precise for swaps)
            return { success: true, price: jupiterPrice };
        }

        // 4. Only one source available — use it
        if (jupiterPrice) return { success: true, price: jupiterPrice };
        if (dexPrice) return { success: true, price: dexPrice };

        return { success: false, message: 'Both Jupiter and DexScreener unavailable' };
    }

    private executePaperBuy(
        symbol: string,
        mint: string,
        usdcAmount: number,
        tokenPrice: number,
    ): BrokerOrderResult {
        if (this.usdcBalance < usdcAmount) {
            return { success: false, message: 'Insufficient USDC balance' };
        }

        const tokenQty = usdcAmount / tokenPrice;
        this.usdcBalance -= usdcAmount;

        const existing = this.paperPositions.get(symbol);
        if (existing) {
            // Average-in
            const totalTokens = existing.tokenQty + tokenQty;
            const avgPrice =
                (existing.tokenQty * existing.avgEntryPrice + tokenQty * tokenPrice) / totalTokens;
            this.paperPositions.set(symbol, {
                ...existing,
                tokenQty: totalTokens,
                avgEntryPrice: avgPrice,
                currentPrice: tokenPrice,
            });
        } else {
            this.paperPositions.set(symbol, {
                symbol,
                mintAddress: mint,
                tokenQty,
                avgEntryPrice: tokenPrice,
                currentPrice: tokenPrice,
            });
        }

        return {
            success: true,
            orderId: randomUUID(),
            status: 'filled',
            filledQty: tokenQty,
            filledAvgPrice: tokenPrice,
        };
    }

    private executePaperSell(
        symbol: string,
        usdcAmount: number,
        tokenPrice: number,
    ): BrokerOrderResult {
        const pos = this.paperPositions.get(symbol);
        if (!pos) {
            return { success: false, message: `No open position for ${symbol}` };
        }

        // qty = dollar amount to sell; convert to tokens
        const tokensToSell = Math.min(usdcAmount / tokenPrice, pos.tokenQty);
        const proceeds = tokensToSell * tokenPrice;

        const remainingTokens = pos.tokenQty - tokensToSell;
        if (remainingTokens < 1e-9) {
            this.paperPositions.delete(symbol);
        } else {
            this.paperPositions.set(symbol, { ...pos, tokenQty: remainingTokens });
        }

        this.usdcBalance += proceeds;

        return {
            success: true,
            orderId: randomUUID(),
            status: 'filled',
            filledQty: tokensToSell,
            filledAvgPrice: tokenPrice,
        };
    }
}
