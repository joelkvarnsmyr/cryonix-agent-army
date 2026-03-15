// ---------------------------------------------------------------------------
// Polynix — Polymarket 5-min binary options types
// ---------------------------------------------------------------------------

export interface CryptoMicroMarket {
    conditionId: string;
    questionId: string;
    title: string;
    asset: string;
    expiresAt: number;          // Unix ms
    timeToExpiry: number;       // Seconds remaining
    yesTokenId: string;
    noTokenId: string;
}

export interface ArbOpportunity {
    market: CryptoMicroMarket;
    yesBestAsk: number;
    noBestAsk: number;
    combinedCost: number;       // yesBestAsk + noBestAsk
    grossEdge: number;          // 1.0 - combinedCost
    netEdge: number;            // grossEdge - round-trip fees
    yesLiquidity: number;       // USD at best ask
    noLiquidity: number;
    maxSize: number;            // min(yesLiquidity, noLiquidity)
}

export interface DirectionalSignal {
    market: CryptoMicroMarket;
    direction: 'YES' | 'NO';
    currentPrice: number;
    priceChangePct: number;
    polymarketProb: number;     // Current YES mid on Polymarket
    impliedFairProb: number;    // Momentum-derived fair value
    edge: number;               // |impliedFairProb - polymarketProb|
    confidence: number;         // 0-100
}

export interface PolynixPosition {
    id: string;
    market: CryptoMicroMarket;
    type: 'arb' | 'directional';
    side: 'YES' | 'NO' | 'BOTH';
    entryPrice: number;
    size: number;               // Contracts
    costBasis: number;          // Total USD spent
    enteredAt: number;          // Unix ms
    expiresAt: number;
    status: 'open' | 'won' | 'lost' | 'settled';
    pnl: number;
}

export interface PolynixAccountState {
    balance: number;
    totalPnl: number;
    openPositions: number;
    tradesTotal: number;
    wins: number;
    losses: number;
    winRate: number;
}

export interface OrderResult {
    orderId: string;
    status: 'filled' | 'partial' | 'open' | 'rejected';
    filledQty: number;
    filledPrice: number;
}

export interface RiskDecision {
    canTrade: boolean;
    reason?: 'daily_loss_limit' | 'max_consecutive_losses' | 'max_positions' | 'max_exposure';
    suggestedSize: number;
}

export interface PolynixConfig {
    broker: {
        paper_trading: boolean;
        clob_api_url: string;
        gamma_api_url: string;
    };
    capital: {
        starting_balance_usd: number;
        max_bet_size_usd: number;
        max_concurrent_positions: number;
        max_exposure_pct: number;
    };
    strategy: {
        arb_threshold: number;
        min_edge_pct: number;
        momentum_lookback_seconds: number;
        min_time_to_expiry_s: number;
        max_time_to_expiry_s: number;
    };
    risk: {
        kelly_fraction: number;
        max_daily_loss_usd: number;
        max_consecutive_losses: number;
        fee_rate: number;
    };
    timing: {
        scan_interval_ms: number;
        settlement_check_ms: number;
    };
    data_sources: {
        binance_symbols: string[];
        use_polymarket_intelligence: boolean;
    };
}
