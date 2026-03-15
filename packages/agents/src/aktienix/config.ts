import { readFileSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';

/**
 * Typed representation of aktienix.toml
 */
export interface AktienixTomlConfig {
    broker: {
        provider: 'alpaca' | 'ibkr' | 'mock';
        paper_trading: boolean;
        account_type: 'cash' | 'margin';
    };
    market_hours: {
        regular_hours_only: boolean;
        skip_first_minutes: number;
        close_before_eod: boolean;
        no_new_orders_before_close_min: number;
    };
    watchlist: {
        symbols: string[];
        timeframe: '1Day' | '1Hour' | '15Min';
        bars_count: number;
    };
    capital: {
        max_position_size_usd: number;
        max_capital_per_trade_pct: number;
        min_order_value: number;
    };
    limits: {
        max_open_positions: number;
        max_trades_per_day: number;
        max_day_trades_per_5d: number;
    };
    signals: {
        min_signal_score: number;
        weight_rsi: number;
        weight_macd: number;
        weight_bollinger: number;
        weight_trend: number;
        weight_volume: number;
        rsi_period: number;
        rsi_oversold: number;
        rsi_approaching_oversold: number;
        rsi_overbought: number;
        rsi_approaching_overbought: number;
        bollinger_period: number;
        bollinger_std: number;
        bollinger_edge_threshold: number;
        macd_fast: number;
        macd_slow: number;
        macd_signal_period: number;
        counter_trend_penalty: number;
    };
    risk: {
        min_confidence: number;
        min_settled_cash: number;
        max_daily_loss_pct: number;
        max_weekly_loss_pct: number;
        max_consecutive_losses: number;
    };
    exits: {
        take_profit_pct: number;
        stop_loss_pct: number;
        trailing_stop_pct: number;
        trailing_activation_pct: number;
        stagnation_timeout_days: number;
        stagnation_min_pnl_pct: number;
    };
    timing: {
        poll_interval_ms: number;
        signal_scan_interval_ms: number;
    };
    intelligence: {
        enabled: boolean;
        news_scan_interval_ms: number;
        macro_confidence_boost: number;
        macro_bearish_block: boolean;
    };
    polymarket: {
        crypto_correlated_tickers: string[];
        crypto_boost: number;
        crypto_penalty: number;
        delta_threshold: number;
    };
}

// ============================================================================
// DEFAULT CONFIG — used when TOML file is missing or a key is absent.
// ============================================================================

const DEFAULTS: AktienixTomlConfig = {
    broker: { provider: 'mock', paper_trading: true, account_type: 'cash' },
    market_hours: { regular_hours_only: true, skip_first_minutes: 15, close_before_eod: false, no_new_orders_before_close_min: 30 },
    watchlist: { symbols: ['AAPL', 'MSFT', 'GOOGL', 'SPY', 'QQQ'], timeframe: '1Day', bars_count: 220 },
    capital: { max_position_size_usd: 5000, max_capital_per_trade_pct: 0.95, min_order_value: 5.0 },
    limits: { max_open_positions: 5, max_trades_per_day: 5, max_day_trades_per_5d: 2 },
    signals: {
        min_signal_score: 0.35, weight_rsi: 0.25, weight_macd: 0.25, weight_bollinger: 0.20,
        weight_trend: 0.20, weight_volume: 0.10, rsi_period: 14, rsi_oversold: 30,
        rsi_approaching_oversold: 40, rsi_overbought: 70, rsi_approaching_overbought: 60,
        bollinger_period: 20, bollinger_std: 2.0, bollinger_edge_threshold: 0.10,
        macd_fast: 12, macd_slow: 26, macd_signal_period: 9, counter_trend_penalty: 0.50,
    },
    risk: { min_confidence: 0.60, min_settled_cash: 1.0, max_daily_loss_pct: 0.02, max_weekly_loss_pct: 0.05, max_consecutive_losses: 3 },
    exits: { take_profit_pct: 5.0, stop_loss_pct: 3.0, trailing_stop_pct: 4.0, trailing_activation_pct: 2.0, stagnation_timeout_days: 10, stagnation_min_pnl_pct: 0.5 },
    timing: { poll_interval_ms: 60_000, signal_scan_interval_ms: 900_000 },
    intelligence: { enabled: true, news_scan_interval_ms: 900_000, macro_confidence_boost: 0.15, macro_bearish_block: true },
    polymarket: { crypto_correlated_tickers: ['MSTR', 'COIN', 'RIOT', 'MARA', 'SQ', 'PYPL'], crypto_boost: 0.08, crypto_penalty: 0.08, delta_threshold: 20 },
};

// ============================================================================
// LOADER
// ============================================================================

let _config: AktienixTomlConfig | null = null;

/**
 * Load aktienix.toml from the project root.
 * Falls back to safe defaults if the file is missing.
 */
export function loadAktienixConfig(customPath?: string): AktienixTomlConfig {
    if (_config) return _config;

    const searchPaths = customPath
        ? [customPath]
        : [
            join(process.cwd(), 'aktienix.toml'),
            join(process.cwd(), '..', '..', 'aktienix.toml'),  // From apps/aktienix/ → monorepo root
            join(__dirname, '..', '..', '..', '..', '..', 'aktienix.toml'), // Fallback from deep src
        ];

    for (const filePath of searchPaths) {
        try {
            const raw = readFileSync(filePath, 'utf-8');
            const parsed = parse(raw) as any;

            // Deep merge: TOML values override defaults
            _config = deepMerge(DEFAULTS, parsed) as AktienixTomlConfig;
            console.info(`[AKTIENIX CONFIG] Loaded from ${filePath}`);
            return _config;
        } catch {
            // File not found at this path, try next
        }
    }

    console.warn('[AKTIENIX CONFIG] aktienix.toml not found. Using safe defaults.');
    _config = { ...DEFAULTS };
    return _config;
}

/**
 * Force reload on next access (useful for hot-reload or tests).
 */
export function resetAktienixConfig(): void {
    _config = null;
}

/**
 * Deep merge utility. Source values override target.
 */
function deepMerge(target: any, source: any): any {
    const result = { ...target };
    for (const key of Object.keys(source)) {
        if (
            source[key] &&
            typeof source[key] === 'object' &&
            !Array.isArray(source[key]) &&
            target[key] &&
            typeof target[key] === 'object'
        ) {
            result[key] = deepMerge(target[key], source[key]);
        } else {
            result[key] = source[key];
        }
    }
    return result;
}
