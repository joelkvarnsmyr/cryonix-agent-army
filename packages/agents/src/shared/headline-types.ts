export interface HeadlineScan {
    /** -3 (crash-level bearish) to +3 (euphoric bullish) */
    impact: number;
    /** What happened in 1-2 sentences */
    summary: string;
    /** Category */
    category: 'geopolitik' | 'fed' | 'crypto' | 'earnings' | 'trade_war' | 'regulation' | 'hack' | 'other';
    /** Which assets are most affected */
    affectedAssets: string[];
    /** Raw source tweets/headlines */
    sources: string[];
    /** Confidence in this assessment 0-1 */
    confidence: number;
}

export interface HeadlineState {
    scan: HeadlineScan;
    timestamp: number;
    /** 'bullish' | 'bearish' | 'neutral' */
    direction: 'bullish' | 'bearish' | 'neutral';
    /** Seconds since the event broke */
    ageSeconds: number;
}
