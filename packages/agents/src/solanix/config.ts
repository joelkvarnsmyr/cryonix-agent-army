import { readFileSync, existsSync } from 'fs';
import { parse } from '@iarna/toml';
import { join } from 'path';

export interface SolanixTomlConfig {
    broker: { paper_trading: boolean };
    watchlist: { symbols: string[]; timeframe: '15m' | '1h' | '4h' | '1d'; bars_count: number };
    capital: { max_position_size_usd: number; max_capital_per_trade_pct: number; min_order_value: number };
    limits: { max_open_positions: number; max_trades_per_day: number };
    risk: { min_confidence: number; max_daily_loss_pct: number; max_weekly_loss_pct: number; max_consecutive_losses: number };
    exits: { take_profit_pct: number; stop_loss_pct: number; trailing_stop_pct: number; trailing_activation_pct: number; stagnation_timeout_days: number; stagnation_min_pnl_pct: number };
    rotation: { enabled: boolean; min_score_advantage: number; min_hold_minutes: number };
    timing: { poll_interval_ms: number; signal_scan_interval_ms: number; dexscreener_scan_interval_ms: number };
    signals: { min_signal_score: number; dexscreener_enabled: boolean; dexscreener_min_liquidity_usd: number; dexscreener_volume_spike_multiplier: number; dexscreener_dynamic_ttl_ms: number };
}

export const SOLANIX_DEFAULTS: SolanixTomlConfig = {
    broker: { paper_trading: true },
    watchlist: { symbols: ['SOL', 'JUP', 'BONK', 'WIF', 'PYTH', 'RNDR'], timeframe: '1h', bars_count: 100 },
    capital: { max_position_size_usd: 50, max_capital_per_trade_pct: 0.95, min_order_value: 1.0 },
    limits: { max_open_positions: 5, max_trades_per_day: 10 },
    risk: { min_confidence: 0.50, max_daily_loss_pct: 0.05, max_weekly_loss_pct: 0.10, max_consecutive_losses: 3 },
    exits: { take_profit_pct: 8.0, stop_loss_pct: 4.0, trailing_stop_pct: 5.0, trailing_activation_pct: 3.0, stagnation_timeout_days: 3, stagnation_min_pnl_pct: 0.5 },
    rotation: { enabled: true, min_score_advantage: 15, min_hold_minutes: 30 },
    timing: { poll_interval_ms: 60_000, signal_scan_interval_ms: 900_000, dexscreener_scan_interval_ms: 300_000 },
    signals: { min_signal_score: 0.25, dexscreener_enabled: true, dexscreener_min_liquidity_usd: 50_000, dexscreener_volume_spike_multiplier: 3.0, dexscreener_dynamic_ttl_ms: 7_200_000 },
};

export function loadSolanixConfig(filePath?: string): SolanixTomlConfig {
    const tomlPath = filePath ?? join(process.cwd(), 'solanix.toml');
    if (!existsSync(tomlPath)) return SOLANIX_DEFAULTS;
    try {
        const raw = readFileSync(tomlPath, 'utf-8');
        const parsed = parse(raw) as Partial<SolanixTomlConfig>;
        return {
            broker: { ...SOLANIX_DEFAULTS.broker, ...parsed.broker },
            watchlist: { ...SOLANIX_DEFAULTS.watchlist, ...parsed.watchlist },
            capital: { ...SOLANIX_DEFAULTS.capital, ...parsed.capital },
            limits: { ...SOLANIX_DEFAULTS.limits, ...parsed.limits },
            risk: { ...SOLANIX_DEFAULTS.risk, ...parsed.risk },
            exits: { ...SOLANIX_DEFAULTS.exits, ...parsed.exits },
            rotation: { ...SOLANIX_DEFAULTS.rotation, ...parsed.rotation },
            timing: { ...SOLANIX_DEFAULTS.timing, ...parsed.timing },
            signals: { ...SOLANIX_DEFAULTS.signals, ...parsed.signals },
        };
    } catch {
        console.warn('[solanix] Failed to parse solanix.toml, using defaults');
        return SOLANIX_DEFAULTS;
    }
}
