import { readFileSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';
import type { PodConfig } from './types';

/**
 * Typed representation of alphanix.toml
 */
export interface AlphanixTomlConfig {
    orchestrator: {
        max_pods: number;
        capital_total_usd: number;
        rebalance_interval_hours: number;
        global_max_drawdown_pct: number;
        morning_huddle_utc: string;
        esg: {
            enabled: boolean;
            planetary_boundary_checks: boolean;
            min_esg_score: number;
        };
    };
    swarms: {
        max_concurrent_workers: number;
        default_timeout_ms: number;
        backtest_timeout_ms: number;
    };
    pods: Record<string, {
        enabled: boolean;
        adapter: string;
        capital_pct: number;
        strategy: string;
        symbols: string[];
        poll_interval_ms: number;
        risk_max_drawdown_pct: number;
        risk_max_positions: number;
        trading_hours?: string;
    }>;
    broker?: {
        paper_trading: boolean;
    };
    exits?: {
        take_profit_pct: number;
        stop_loss_pct: number;
        trailing_stop_activation_pct: number;
        trailing_stop_distance_pct: number;
        stagnation_hours: number;
        min_holding_minutes: number;
    };
    data_sources?: {
        fred_enabled: boolean;
        sec_edgar_enabled: boolean;
        sentiment_enabled: boolean;
        opensky_enabled: boolean;
        trafikverket_enabled: boolean;
        transcript_enabled: boolean;
    };
    brain?: {
        enabled: boolean;
        schedule_utc: string[];
        acute_trigger_consecutive_losses: number;
        acute_trigger_daily_drawdown_pct: number;
        cooldown_hours: number;
    };
    timing: {
        orchestrator_loop_ms: number;
        pod_default_loop_ms: number;
        state_publish_interval_ms: number;
    };
}

// ============================================================================
// DEFAULT CONFIG — used when TOML file is missing or a key is absent.
// ============================================================================

const DEFAULTS: AlphanixTomlConfig = {
    orchestrator: {
        max_pods: 10,
        capital_total_usd: 10000,
        rebalance_interval_hours: 6,
        global_max_drawdown_pct: 5.0,
        morning_huddle_utc: '06:00',
        esg: {
            enabled: false,
            planetary_boundary_checks: false,
            min_esg_score: 40,
        },
    },
    swarms: {
        max_concurrent_workers: 5,
        default_timeout_ms: 300_000,
        backtest_timeout_ms: 900_000,
    },
    pods: {
        crypto_momentum: {
            enabled: true,
            adapter: 'binance',
            capital_pct: 15,
            strategy: 'momentum',
            symbols: ['BTC/USDC', 'ETH/USDC', 'SOL/USDC'],
            poll_interval_ms: 30_000,
            risk_max_drawdown_pct: 3.0,
            risk_max_positions: 5,
        },
        crypto_dip_hunter: {
            enabled: true,
            adapter: 'binance',
            capital_pct: 10,
            strategy: 'dip_hunter',
            symbols: ['BTC/USDC', 'ETH/USDC', 'SOL/USDC', 'AVAX/USDC', 'LINK/USDC'],
            poll_interval_ms: 30_000,
            risk_max_drawdown_pct: 4.0,
            risk_max_positions: 5,
        },
        us_tech: {
            enabled: true,
            adapter: 'alpaca',
            capital_pct: 15,
            strategy: 'tech_momentum',
            symbols: ['NVDA', 'AAPL', 'MSFT', 'GOOGL', 'META', 'AMZN', 'TSLA'],
            poll_interval_ms: 60_000,
            risk_max_drawdown_pct: 2.5,
            risk_max_positions: 7,
            trading_hours: '09:30-16:00 ET',
        },
        us_defense: {
            enabled: true,
            adapter: 'alpaca',
            capital_pct: 10,
            strategy: 'defense_value',
            symbols: ['LMT', 'RTX', 'NOC', 'GD', 'BA', 'HII'],
            poll_interval_ms: 60_000,
            risk_max_drawdown_pct: 2.0,
            risk_max_positions: 5,
            trading_hours: '09:30-16:00 ET',
        },
        us_energy: {
            enabled: true,
            adapter: 'alpaca',
            capital_pct: 8,
            strategy: 'energy_momentum',
            symbols: ['XOM', 'CVX', 'COP', 'SLB', 'EOG', 'OXY'],
            poll_interval_ms: 60_000,
            risk_max_drawdown_pct: 3.0,
            risk_max_positions: 5,
            trading_hours: '09:30-16:00 ET',
        },
        us_healthcare: {
            enabled: true,
            adapter: 'alpaca',
            capital_pct: 7,
            strategy: 'healthcare_value',
            symbols: ['UNH', 'JNJ', 'LLY', 'PFE', 'ABBV', 'MRK'],
            poll_interval_ms: 60_000,
            risk_max_drawdown_pct: 2.0,
            risk_max_positions: 5,
            trading_hours: '09:30-16:00 ET',
        },
        us_finance: {
            enabled: true,
            adapter: 'alpaca',
            capital_pct: 7,
            strategy: 'finance_momentum',
            symbols: ['JPM', 'GS', 'MS', 'BAC', 'WFC', 'BLK'],
            poll_interval_ms: 60_000,
            risk_max_drawdown_pct: 2.5,
            risk_max_positions: 5,
            trading_hours: '09:30-16:00 ET',
        },
        nordic_value: {
            enabled: true,
            adapter: 'ibkr',
            capital_pct: 10,
            strategy: 'nordic_value',
            symbols: ['HM-B.ST', 'VOLV-B.ST', 'SAND.ST', 'ERIC-B.ST', 'ABB.ST', 'ASSA-B.ST', 'SEB-A.ST', 'ATCO-A.ST'],
            poll_interval_ms: 60_000,
            risk_max_drawdown_pct: 2.0,
            risk_max_positions: 8,
            trading_hours: '09:00-17:30 CET',
        },
        nordic_growth: {
            enabled: true,
            adapter: 'ibkr',
            capital_pct: 8,
            strategy: 'nordic_growth',
            symbols: ['EVO.ST', 'SINCH.ST', 'SAAB-B.ST', 'EMBRAC-B.ST', 'HEXA-B.ST'],
            poll_interval_ms: 60_000,
            risk_max_drawdown_pct: 3.0,
            risk_max_positions: 5,
            trading_hours: '09:00-17:30 CET',
        },
        crypto_altcoins: {
            enabled: true,
            adapter: 'binance',
            capital_pct: 10,
            strategy: 'altcoin_momentum',
            symbols: ['AVAX/USDC', 'LINK/USDC', 'DOT/USDC', 'MATIC/USDC', 'UNI/USDC', 'AAVE/USDC'],
            poll_interval_ms: 30_000,
            risk_max_drawdown_pct: 5.0,
            risk_max_positions: 6,
        },
    },
    broker: {
        paper_trading: true,
    },
    exits: {
        take_profit_pct: 5.0,
        stop_loss_pct: 3.0,
        trailing_stop_activation_pct: 2.0,
        trailing_stop_distance_pct: 1.0,
        stagnation_hours: 48,
        min_holding_minutes: 15,
    },
    data_sources: {
        fred_enabled: true,
        sec_edgar_enabled: true,
        sentiment_enabled: true,
        opensky_enabled: true,
        trafikverket_enabled: true,
        transcript_enabled: true,
    },
    brain: {
        enabled: true,
        schedule_utc: ['06:00', '12:00', '18:00', '00:00'],
        acute_trigger_consecutive_losses: 3,
        acute_trigger_daily_drawdown_pct: 2.0,
        cooldown_hours: 1,
    },
    timing: {
        orchestrator_loop_ms: 60_000,
        pod_default_loop_ms: 30_000,
        state_publish_interval_ms: 10_000,
    },
};

// ============================================================================
// LOADER
// ============================================================================

let _config: AlphanixTomlConfig | null = null;

/**
 * Load alphanix.toml from the project root.
 * Falls back to safe defaults if the file is missing.
 */
export function loadAlphanixConfig(customPath?: string): AlphanixTomlConfig {
    if (_config) return _config;

    const searchPaths = customPath
        ? [customPath]
        : [
            join(process.cwd(), 'alphanix.toml'),
            join(process.cwd(), '..', '..', 'alphanix.toml'),  // From apps/web/ → monorepo root
            join(__dirname, '..', '..', '..', '..', '..', 'alphanix.toml'), // Fallback from deep src
        ];

    for (const filePath of searchPaths) {
        try {
            const raw = readFileSync(filePath, 'utf-8');
            const parsed = parse(raw) as any;

            // Deep merge: TOML values override defaults
            _config = deepMerge(DEFAULTS, parsed) as AlphanixTomlConfig;
            console.info(`[ALPHANIX CONFIG] Loaded from ${filePath}`);
            return _config;
        } catch {
            // File not found at this path, try next
        }
    }

    console.warn('[ALPHANIX CONFIG] alphanix.toml not found. Using safe defaults.');
    _config = { ...DEFAULTS };
    return _config;
}

/**
 * Force reload on next access (useful for hot-reload or tests).
 */
export function resetAlphanixConfig(): void {
    _config = null;
}

/**
 * Convert a raw pod config object from TOML into a typed PodConfig.
 */
export function toPodConfig(id: string, raw: AlphanixTomlConfig['pods'][string]): PodConfig {
    return {
        id,
        enabled: raw.enabled,
        adapter: raw.adapter,
        capitalPct: raw.capital_pct,
        strategy: raw.strategy,
        symbols: raw.symbols,
        pollIntervalMs: raw.poll_interval_ms,
        riskMaxDrawdownPct: raw.risk_max_drawdown_pct,
        riskMaxPositions: raw.risk_max_positions,
        tradingHours: raw.trading_hours,
    };
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
