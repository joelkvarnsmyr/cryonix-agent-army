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
        };
    }

    async getPositions(): Promise<StockPosition[]> {
        return Array.from(this.paperPositions.values()).map((p) => ({
            symbol: p.symbol,
            qty: p.tokenQty,
            avgEntryPrice: p.avgEntryPrice,
            marketValue: p.tokenQty * p.currentPrice,
            unrealizedPl: p.tokenQty * (p.currentPrice - p.avgEntryPrice),
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

    // -------------------------------------------------------------------------
    // Extended API (used by SolanaAgent)
    // -------------------------------------------------------------------------

    addDynamicToken(symbol: string, mintAddress: string): void {
        this.dynamicMints.set(symbol.toUpperCase(), mintAddress);
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
     * Fetch a Jupiter quote for 1 USDC (1_000_000 micro-USDC) → outputMint.
     * Returns price per token in USDC.
     *
     * For SELL we quote the reverse (token → USDC) using 1 USDC worth of tokens
     * to get an equivalent price.
     */
    private async fetchJupiterPrice(
        mint: string,
        _side: 'BUY' | 'SELL',
        _usdcAmount: number,
    ): Promise<{ success: boolean; price?: number; message?: string }> {
        try {
            // Always quote USDC → token to get a stable price reference
            const url =
                `${JUPITER_QUOTE_URL}` +
                `?inputMint=${USDC_MINT}` +
                `&outputMint=${mint}` +
                `&amount=1000000` +
                `&slippageBps=50`;

            const res = await fetch(url);
            if (!res.ok) {
                return {
                    success: false,
                    message: `Jupiter quote request failed with status ${res.status}`,
                };
            }

            const data = (await res.json()) as { outAmount: string };
            // outAmount = tokens received for 1 USDC (6 decimals → divide by 1_000_000)
            const tokensPerUsdc = Number(data.outAmount) / 1_000_000;
            if (!tokensPerUsdc || tokensPerUsdc <= 0) {
                return { success: false, message: 'Jupiter quote returned zero outAmount' };
            }

            const pricePerToken = 1 / tokensPerUsdc;
            return { success: true, price: pricePerToken };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, message: `Jupiter quote error: ${msg}` };
        }
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
