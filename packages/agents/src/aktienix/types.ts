export interface StockPosition {
    symbol: string;
    qty: number;
    avgEntryPrice: number;
    currentPrice: number;
    marketValue: number;
    unrealizedPl: number;
    unrealizedPlPct: number;
    openedAt?: string;
}

export interface AktienixConfig {
    broker: 'alpaca' | 'ibkr' | 'mock';
    paperTrading: boolean;
    maxPositionSizeUsd: number;
    // Account constraints relevant for PDT and micro-accounts
    accountType: 'cash' | 'margin';
    // Optional intelligence configuration mapped from aktienix.toml
    intelligence?: {
        enabled: boolean;
        news_scan_interval_ms: number;
        macro_confidence_boost: number;
        macro_bearish_block: boolean;
    };
}

export interface AccountState {
    buyingPower: number;
    settledCash: number;  // Crucial for T+1 settlement logic
    portfolioValue: number;
    isPatternDayTrader: boolean;
    dailyPnl: number;
    dailyPnlPct: number;
    updatedAt: number;  // epoch ms
}
