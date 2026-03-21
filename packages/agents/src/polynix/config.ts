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
        max_bet_size_usd: 25,
        max_concurrent_positions: 20,
        max_exposure_pct: 50,
    },
    strategy: {
        arb_threshold: 0.96,
        min_edge_pct: 2.0,
        momentum_lookback_seconds: 60,
        min_time_to_expiry_s: 3600,
        max_time_to_expiry_s: 14 * 86400,
        scan_all_for_arb: true,
        min_liquidity_usd: 500,
        max_markets_per_scan: 80,
        arb_max_bet_size_usd: 10,           // Smaller arb bets = faster capital rotation
        arb_max_positions: 30,              // Reserve half of slots for directional
        arb_max_exposure_pct: 50,           // Max 50% of bankroll in arb
        arb_max_expiry_s: 3 * 86400,        // Skip arbs expiring in > 3 days
    },
    risk: {
        kelly_fraction: 0.25,
        max_daily_loss_usd: 25,
        max_consecutive_losses: 5,
        fee_rate: 0.0156,
    },
    timing: {
        scan_interval_ms: 60_000,           // 60s (markets don't change every second)
        settlement_check_ms: 300_000,       // 5 min (long-duration markets)
    },
    data_sources: {
        binance_symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
        use_polymarket_intelligence: true,
    },
    micro_markets: {
        enabled: true,
        min_time_to_expiry_s: 30,
        max_time_to_expiry_s: 300,
        max_bet_size_usd: 9,
        reserve_pct: 20,
    },
    exits: {
        enabled: true,
        take_profit_pct: 30,
        stop_loss_pct: 40,
        stagnation_hours: 48,
        min_hold_seconds: 300,
    },
    copy_trader: {
        enabled: false,
        poll_interval_ms: 300_000,
        min_wallet_pnl: 100,
        min_wallet_trades: 10,
        max_copy_size_usd: 15,
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
            micro_markets: { ...POLYNIX_DEFAULTS.micro_markets, ...parsed.micro_markets } as PolynixConfig['micro_markets'],
            exits: { ...POLYNIX_DEFAULTS.exits, ...parsed.exits } as PolynixConfig['exits'],
            copy_trader: { ...POLYNIX_DEFAULTS.copy_trader, ...parsed.copy_trader } as PolynixConfig['copy_trader'],
        };
    } catch {
        console.warn('[polynix] Failed to parse polynix.toml, using defaults');
        return POLYNIX_DEFAULTS;
    }
}
