export interface SolanaPosition {
    symbol: string;
    mintAddress: string;
    qty: number;
    avgEntryPrice: number;
    currentPrice: number;
    unrealizedPl: number;
    entryTime: number;
    highWatermark: number;
    trailingStopActive?: boolean;
    stagnationDays?: number;
}

export interface SolanaSignal {
    symbol: string;
    mintAddress: string;
    action: 'BUY' | 'SELL' | 'WAIT';
    confidence: number;
    reasoning: string[];
    currentPrice: number;
    source: 'ta' | 'dexscreener';
    timestamp: number;
}

export interface SolanaAccountState {
    usdcBalance: number;
    solBalance: number;
    portfolioValue: number;
}

export interface DexScreenerToken {
    symbol: string;
    mintAddress: string;
    priceUsd: number;
    volume24h: number;
    volumeChange1h: number;
    liquidityUsd: number;
    pairCreatedAt: number;
}
