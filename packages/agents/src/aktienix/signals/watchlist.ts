/**
 * Default watchlist of liquid, well-known US stocks suitable for algorithmic trading.
 * 
 * Selection criteria:
 * - High liquidity (tight spreads)
 * - Fractional share support on Alpaca
 * - Mix of sectors for diversification
 */

export const DEFAULT_WATCHLIST: string[] = [
    // Tech Giants
    'AAPL',   // Apple
    'MSFT',   // Microsoft
    'GOOGL',  // Alphabet
    'AMZN',   // Amazon
    'NVDA',   // NVIDIA
    'META',   // Meta Platforms
    'TSLA',   // Tesla

    // ETFs (broad market)
    'SPY',    // S&P 500
    'QQQ',    // NASDAQ 100

    // Financials
    'JPM',    // JPMorgan Chase

    // Healthcare
    'JNJ',    // Johnson & Johnson
];

export interface WatchlistConfig {
    symbols: string[];
    /** Timeframe for candlestick data: '1Day', '1Hour', '15Min' */
    timeframe: '1Day' | '1Hour' | '15Min';
    /** Number of bars to fetch for analysis */
    barsCount: number;
}

export const DEFAULT_WATCHLIST_CONFIG: WatchlistConfig = {
    symbols: DEFAULT_WATCHLIST,
    timeframe: '1Day',
    barsCount: 100,
};
