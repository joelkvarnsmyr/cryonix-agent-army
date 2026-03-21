// ---------------------------------------------------------------------------
// Polynix — Polymarket 5-min binary options types
// ---------------------------------------------------------------------------

export interface CryptoMicroMarket {
    conditionId: string;
    questionId: string;
    title: string;
    asset: string;              // 'BTC', 'ETH', 'SOL', or 'MACRO' for non-crypto arb markets
    expiresAt: number;          // Unix ms
    timeToExpiry: number;       // Seconds remaining
    yesTokenId: string;
    noTokenId: string;
    priceTarget?: number;       // Extracted price target (e.g. 80000 from "BTC above $80K")
    targetDirection?: 'above' | 'below'; // Direction of the price target
    liquidity: number;          // Market liquidity in USD
    volume24hr: number;         // 24h trading volume
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
    status: 'open' | 'won' | 'lost' | 'settled' | 'exited';
    pnl: number;
    currentPrice?: number;      // Live midpoint price of our token
    unrealizedPnl?: number;     // (currentPrice * size) - costBasis (for directional) or guaranteed edge (for arb)
    exitReason?: 'take_profit' | 'stop_loss' | 'stagnation';
    exitPrice?: number;
}

export interface ExitConfig {
    enabled: boolean;
    take_profit_pct: number;    // % gain to trigger take-profit exit
    stop_loss_pct: number;      // % loss to trigger stop-loss exit
    stagnation_hours: number;   // Hours of flat price to trigger stagnation exit
    min_hold_seconds: number;   // Minimum hold time before any exit
}

export interface ExitDecision {
    positionId: string;
    reason: 'take_profit' | 'stop_loss' | 'stagnation';
    pnlPct: number;
    currentPrice: number;
}

export interface CopyTraderConfig {
    enabled: boolean;
    poll_interval_ms: number;   // How often to poll for new trades
    min_wallet_pnl: number;     // Minimum PnL to follow a wallet
    min_wallet_trades: number;  // Minimum trades to qualify as leader
    max_copy_size_usd: number;  // Max size per copy trade
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
        scan_all_for_arb: boolean;
        min_liquidity_usd: number;
        max_markets_per_scan: number;
        arb_max_bet_size_usd: number;       // Separate max bet for arb (lower = faster rotation)
        arb_max_positions: number;           // Max arb position slots (rest reserved for directional)
        arb_max_exposure_pct: number;        // Max % of bankroll in arb
        arb_max_expiry_s: number;            // Max expiry for arb (skip long-duration arbs)
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
    micro_markets?: {
        enabled: boolean;
        min_time_to_expiry_s: number;
        max_time_to_expiry_s: number;
        max_bet_size_usd: number;
        reserve_pct: number;
    };
    exits?: ExitConfig;
    copy_trader?: CopyTraderConfig;
}
