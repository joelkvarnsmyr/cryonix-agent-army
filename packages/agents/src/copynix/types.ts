export interface TrackedWallet {
    address: string;
    label: string;
    score: number;
    winRate: number;
    tradeCount30d: number;
    roi30d: number;
    lastActive: number;
    addedAt: number;
    source: 'manual' | 'discovery';
}

export interface WalletTrade {
    walletAddress: string;
    tokenMint: string;
    tokenSymbol: string;
    action: 'BUY' | 'SELL';
    amountUsd: number;
    priceUsd: number;
    timestamp: number;
    txSignature: string;
}

export interface CopySignal {
    tokenMint: string;
    tokenSymbol: string;
    action: 'BUY' | 'SELL';
    consensusLevel: 'strong' | 'medium' | 'single';
    walletCount: number;
    wallets: string[];
    avgPriceUsd: number;
    totalVolumeUsd: number;
    confidence: number;
    reasoning: string[];
    timestamp: number;
}

export interface CopyPosition {
    tokenMint: string;
    tokenSymbol: string;
    qty: number;
    avgEntryPrice: number;
    currentPrice: number;
    unrealizedPl: number;
    entryTime: number;
    highWatermark: number;
    trailingStopActive: boolean;
    copiedFrom: string[];         // wallet addresses that triggered this copy
    consensusLevel: 'strong' | 'medium' | 'single';
}

export interface CopyAccountState {
    usdcBalance: number;
    portfolioValue: number;
    totalPositions: number;
}

export interface TokenSafetyCheck {
    tokenMint: string;
    tokenSymbol: string;
    ageHours: number;
    liquidityUsd: number;
    holderCount: number;
    lpBurntPct: number;
    immutableSupply: boolean;
    safe: boolean;
    reasons: string[];
}
