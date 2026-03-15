import { readFileSync, existsSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';
import type { PolynixConfig } from './types';

export const POLYNIX_DEFAULTS: PolynixConfig = {
    broker: {
        paper_trading: true,
        clob_api_url: 'https://clob.polymarket.com',
        gamma_api_url: 'https://gamma-api.polymarket.com',
    },
    capital: {
        starting_balance_usd: 500,
        max_bet_size_usd: 10,
        max_concurrent_positions: 5,
        max_exposure_pct: 50,
    },
    strategy: {
        arb_threshold: 0.96,
        min_edge_pct: 2.0,
        momentum_lookback_seconds: 60,
        min_time_to_expiry_s: 60,
        max_time_to_expiry_s: 240,
    },
    risk: {
        kelly_fraction: 0.25,
        max_daily_loss_usd: 25,
        max_consecutive_losses: 5,
        fee_rate: 0.0156,
    },
    timing: {
        scan_interval_ms: 5000,
        settlement_check_ms: 10000,
    },
    data_sources: {
        binance_symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        use_polymarket_intelligence: true,
    },
};

export function loadPolynixConfig(filePath?: string): PolynixConfig {
    const tomlPath = filePath ?? join(process.cwd(), 'polynix.toml');
    if (!existsSync(tomlPath)) return POLYNIX_DEFAULTS;
    try {
        const raw = readFileSync(tomlPath, 'utf-8');
        const parsed = parse(raw) as Partial<PolynixConfig>;
        return {
            broker: { ...POLYNIX_DEFAULTS.broker, ...parsed.broker },
            capital: { ...POLYNIX_DEFAULTS.capital, ...parsed.capital },
            strategy: { ...POLYNIX_DEFAULTS.strategy, ...parsed.strategy },
            risk: { ...POLYNIX_DEFAULTS.risk, ...parsed.risk },
            timing: { ...POLYNIX_DEFAULTS.timing, ...parsed.timing },
            data_sources: { ...POLYNIX_DEFAULTS.data_sources, ...parsed.data_sources },
        };
    } catch {
        console.warn('[polynix] Failed to parse polynix.toml, using defaults');
        return POLYNIX_DEFAULTS;
    }
}
